-- Lighthouse Fund: second update of 14 November 2026.
-- Run this once in the Supabase SQL editor, after update-2026-11-14.sql. It is safe to run again.
-- It saves each company's closing price every trading day, so stock pages can draw a price chart.
-- The history starts on the day this is run. Earlier days are not filled in.

create table if not exists public.price_history (
  code text not null,
  day date not null,
  close numeric not null check (close > 0),
  primary key (code, day)
);
alter table public.price_history enable row level security;
drop policy if exists "anyone reads price history" on public.price_history;
create policy "anyone reads price history" on public.price_history
  for select to anon, authenticated using (true);
revoke all on public.price_history from anon, authenticated;
grant select on public.price_history to anon, authenticated;

-- Saves today's price for every company in the feed. The last save of the day is the close.
create or replace function public.record_prices(p_csv text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Australia/Sydney')::date;
  v_n int;
begin
  with lines as (
    select string_to_array(replace(l, '"', ''), ',') as f
    from regexp_split_to_table(p_csv, E'\r?\n') as l
    where l ~ '^"?[A-Za-z0-9]+"?,'
  ),
  feed as (
    select distinct on (upper(f[1])) upper(f[1]) as code, f[2]::numeric as price
    from lines
    where array_length(f, 1) >= 5 and f[2] ~ '^[0-9]+(\.[0-9]+)?$' and f[5] = to_char(v_today, 'YYYY-MM-DD')
      and upper(f[1]) ~ '^[A-Z0-9]{2,6}$'
  )
  insert into public.price_history (code, day, close)
  select code, v_today, price from feed where price > 0
  on conflict (code, day) do update set close = excluded.close
  where public.price_history.close is distinct from excluded.close;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.record_prices(text) from public, anon, authenticated;

-- The five-minute check now also saves prices.
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
  if to_regprocedure('public.expire_orders()') is not null then
    perform public.expire_orders();
  end if;
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
  begin
    perform public.record_prices(v_body);
  exception when others then
    null; -- a problem saving prices never stops orders from being checked
  end;
  update public.order_checks set checked_at = now(), ok = true, filled = v_filled, note = null where id = 1;
exception when others then
  update public.order_checks set checked_at = now(), ok = false, filled = 0, note = left(sqlerrm, 200) where id = 1;
end;
$$;
revoke all on function public.run_limit_orders() from public, anon, authenticated;

notify pgrst, 'reload schema';

select public.run_limit_orders();
select (select ok from public.order_checks where id = 1) as price_check_ok,
       (select note from public.order_checks where id = 1) as note,
       (select count(*) from public.price_history) as prices_saved,
       (select max(day) from public.price_history) as latest_day;
