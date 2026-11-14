-- Lighthouse Fund: update of 14 November 2026.
-- Run this once in the Supabase SQL editor. It is safe to run again.
-- It adds three things:
--   1. limit orders can have an expiry (end of day, 7 days or 30 days)
--   2. a shared watchlist that analysts and fund managers add to
--   3. ASX announcements for the stocks the fund holds or watches, fetched by the database
-- Run the earlier updates first (the one from 13 November part c at least).

-- ---------- 1. order expiry ----------
alter table public.orders add column if not exists expires_at timestamptz;
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (status in ('open', 'filled', 'cancelled', 'expired'));

-- Closes open orders whose time has run out. Returns how many it closed.
create or replace function public.expire_orders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  update public.orders set status = 'expired', closed_at = now()
  where status = 'open' and expires_at is not null and expires_at <= now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.expire_orders() from public, anon;
grant execute on function public.expire_orders() to authenticated;

-- ---------- 2. watchlist ----------
create table if not exists public.watchlist (
  code text primary key check (code = upper(code) and length(code) between 2 and 6),
  note text check (note is null or length(note) <= 200),
  ref_price numeric,
  added_by uuid default auth.uid() references public.profiles (id) on delete set null,
  added_name text,
  created_at timestamptz not null default now()
);
alter table public.watchlist enable row level security;
drop policy if exists "members read watchlist" on public.watchlist;
create policy "members read watchlist" on public.watchlist
  for select to authenticated using (true);
drop policy if exists "traders add to watchlist" on public.watchlist;
create policy "traders add to watchlist" on public.watchlist
  for insert to authenticated
  with check (public.current_role_name() in ('trader', 'admin'));
drop policy if exists "traders remove from watchlist" on public.watchlist;
create policy "traders remove from watchlist" on public.watchlist
  for delete to authenticated
  using (public.current_role_name() in ('trader', 'admin'));
revoke all on public.watchlist from anon, authenticated;
grant select, insert, delete on public.watchlist to authenticated;

-- ---------- 3. ASX announcements ----------
create table if not exists public.announcements (
  document_key text primary key,
  code text not null,
  headline text not null,
  announced_at timestamptz not null,
  price_sensitive boolean not null default false,
  kind text,
  fetched_at timestamptz not null default now()
);
create index if not exists announcements_code_time on public.announcements (code, announced_at desc);
alter table public.announcements enable row level security;
drop policy if exists "members read announcements" on public.announcements;
create policy "members read announcements" on public.announcements
  for select to authenticated using (true);
revoke all on public.announcements from anon, authenticated;
grant select on public.announcements to authenticated;

create table if not exists public.announcement_checks (
  id int primary key check (id = 1),
  checked_at timestamptz,
  ok boolean,
  added int,
  note text
);
insert into public.announcement_checks (id) values (1) on conflict do nothing;
alter table public.announcement_checks enable row level security;
drop policy if exists "members read announcement checks" on public.announcement_checks;
create policy "members read announcement checks" on public.announcement_checks
  for select to authenticated using (true);
revoke all on public.announcement_checks from anon, authenticated;
grant select on public.announcement_checks to authenticated;

create extension if not exists http with schema extensions;

-- Reads the latest announcements for every stock the fund holds or watches.
create or replace function public.refresh_announcements()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r record;
  v_status int;
  v_body text;
  v_added int := 0;
  v_n int;
  v_failed text := '';
  v_codes int := 0;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '15000');
  for r in
    select code from (
      select code from public.trades where type in ('buy', 'sell') and code is not null
      group by code
      having sum(case when type = 'buy' then quantity else -quantity end) > 0.000001
      union
      select code from public.watchlist
    ) c
    where code ~ '^[A-Z0-9]{2,6}$'
    order by code
    limit 40
  loop
    v_codes := v_codes + 1;
    begin
      select status, content into v_status, v_body
      from http_get('https://asx.api.markitdigital.com/asx-research/1.0/companies/' || lower(r.code) || '/announcements?count=8');
      if v_status = 200 and v_body is not null then
        insert into public.announcements (document_key, code, headline, announced_at, price_sensitive, kind)
        select i ->> 'documentKey', r.code, left(i ->> 'headline', 300), (i ->> 'date')::timestamptz,
               coalesce((i ->> 'isPriceSensitive')::boolean, false), left(i ->> 'announcementType', 80)
        from jsonb_array_elements(v_body::jsonb -> 'data' -> 'items') as i
        where coalesce(i ->> 'documentKey', '') <> '' and coalesce(i ->> 'headline', '') <> '' and coalesce(i ->> 'date', '') <> ''
        on conflict (document_key) do nothing;
        get diagnostics v_n = row_count;
        v_added := v_added + v_n;
      else
        v_failed := v_failed || r.code || ' (status ' || coalesce(v_status::text, 'none') || ') ';
      end if;
    exception when others then
      v_failed := v_failed || r.code || ' (' || left(sqlerrm, 60) || ') ';
    end;
  end loop;
  delete from public.announcements where announced_at < now() - interval '180 days';
  update public.announcement_checks
  set checked_at = now(), ok = (v_failed = ''), added = v_added,
      note = case when v_codes = 0 then 'The fund holds and watches no stocks yet'
                  when v_failed = '' then null else left('Did not load: ' || v_failed, 300) end
  where id = 1;
exception when others then
  update public.announcement_checks set checked_at = now(), ok = false, added = 0, note = left(sqlerrm, 300) where id = 1;
end;
$$;
revoke all on function public.refresh_announcements() from public, anon, authenticated;

-- The five-minute check now also closes expired orders before it looks at prices.
create or replace function public.run_limit_orders()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status int;
  v_body text;
  v_filled int := 0;
begin
  perform public.expire_orders();
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '25000');
  select status, content into v_status, v_body
  from http_get('https://docs.google.com/spreadsheets/d/13SfuLb3d5nv2o2-GCNQIRsD1OU-pD1rG4j0TeGA5xNg/gviz/tq?tqx=out:csv&headers=1&sheet=Feed&tq=select%20A%2CD%2CJ%2CK%2CL');
  if v_status <> 200 or v_body is null or v_body not like '%trade_date%' then
    update public.order_checks set checked_at = now(), ok = false, filled = 0,
      note = 'Price feed did not load (status ' || coalesce(v_status::text, 'none') || ')' where id = 1;
    return;
  end if;
  if exists (select 1 from public.orders where status = 'open') then
    v_filled := public.process_price_feed(v_body);
  end if;
  if to_regprocedure('public.record_snapshot(text)') is not null then
    perform public.record_snapshot(v_body);
  end if;
  update public.order_checks set checked_at = now(), ok = true, filled = v_filled, note = null where id = 1;
exception when others then
  update public.order_checks set checked_at = now(), ok = false, filled = 0, note = left(sqlerrm, 200) where id = 1;
end;
$$;
revoke all on function public.run_limit_orders() from public, anon, authenticated;

-- Announcements are checked every half hour from 8am to 8pm Sydney time (times below are UTC).
create extension if not exists pg_cron;
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'lighthouse-announcements';
  perform cron.schedule('lighthouse-announcements', '7,37 21-23,0-9 * * *', 'select public.refresh_announcements()');
end;
$$;

notify pgrst, 'reload schema';

-- Fetch announcements once now, then show what happened.
select public.refresh_announcements();
select 'order expiry' as piece, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'expires_at') as ready, null::text as detail
union all select 'watchlist', to_regclass('public.watchlist') is not null, null
union all select 'announcements', coalesce(ok, false), coalesce(note, added || ' announcements loaded') from public.announcement_checks where id = 1;
