-- Lighthouse Fund database update, 13 November 2026 (third part).
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It makes the database check open limit orders by itself every five minutes
-- around ASX trading hours, so nobody needs to keep the website open.
-- It is safe to run more than once. It does NOT change any existing trades.

-- ---------- 1. what each order saw when it was placed ----------
alter table public.orders add column if not exists placed_low numeric;
alter table public.orders add column if not exists placed_high numeric;

-- ---------- 2. a note of the last automatic check, shown on the website ----------
create table if not exists public.order_checks (
  id int primary key check (id = 1),
  checked_at timestamptz,
  ok boolean,
  filled int,
  note text
);
alter table public.order_checks enable row level security;
drop policy if exists "order checks are public" on public.order_checks;
create policy "order checks are public" on public.order_checks
  for select to anon, authenticated using (true);
revoke all on public.order_checks from anon, authenticated;
grant select on public.order_checks to anon, authenticated;
insert into public.order_checks (id) values (1) on conflict (id) do nothing;

-- ---------- 3. filling orders from the price feed ----------
-- Takes the price feed as text (code, price, day low, day high, trade date) and fills
-- every open order whose limit has been reached. Returns how many were filled.
create or replace function public.process_price_feed(p_csv text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Australia/Sydney')::date;
  v_open timestamp := (now() at time zone 'Australia/Sydney')::date + interval '10 hours';
  v_filled int := 0;
  v_price numeric;
  r record;
begin
  for r in
    with lines as (
      select string_to_array(replace(l, '"', ''), ',') as f
      from regexp_split_to_table(p_csv, E'\r?\n') as l
      where l ~ '^"?[A-Za-z0-9]+"?,'
    ),
    feed as (
      select upper(f[1]) as code,
             case when f[2] ~ '^[0-9.]+$' then f[2]::numeric else 0 end as price,
             case when f[3] ~ '^[0-9.]+$' then f[3]::numeric else 0 end as day_low,
             case when f[4] ~ '^[0-9.]+$' then f[4]::numeric else 0 end as day_high,
             f[5] as trade_date
      from lines
      where array_length(f, 1) >= 5
    )
    select o.*, f.price as px, f.day_low, f.day_high,
           (f.trade_date = to_char(v_today, 'YYYY-MM-DD')) as traded_today
    from public.orders o
    join feed f on f.code = o.code
    where o.status = 'open' and f.price > 0
    order by o.created_at
  loop
    v_price := null;
    if r.side = 'buy' then
      if r.px <= r.limit_price then
        v_price := r.px;
      elsif r.traded_today and r.day_low > 0 and r.day_low <= r.limit_price then
        -- The price touched the limit earlier today. That only counts if it happened
        -- after the order was placed.
        if (r.created_at at time zone 'Australia/Sydney') < v_open
           or (r.placed_low > 0 and r.day_low < r.placed_low) then
          v_price := r.limit_price;
        end if;
      end if;
    else
      if r.px >= r.limit_price then
        v_price := r.px;
      elsif r.traded_today and r.day_high > 0 and r.day_high >= r.limit_price then
        if (r.created_at at time zone 'Australia/Sydney') < v_open
           or (r.placed_high > 0 and r.day_high > r.placed_high) then
          v_price := r.limit_price;
        end if;
      end if;
    end if;

    if v_price is not null then
      begin
        perform set_config('lighthouse.order_fill', '1', true);
        insert into public.trades (type, code, sleeve, quantity, price, note, trader_name, created_by)
        values (r.side, r.code, r.sleeve, r.quantity, v_price,
                'Limit order at $' || trim(to_char(r.limit_price, 'FM999999990.00')), r.trader_name, r.created_by);
        update public.orders set status = 'filled', closed_at = now(), fill_price = v_price
        where id = r.id and status = 'open';
        v_filled := v_filled + 1;
      exception when others then
        -- Not enough cash or shares right now: the order stays open and is tried again.
        null;
      end;
      perform set_config('lighthouse.order_fill', '', true);
    end if;
  end loop;
  return v_filled;
end;
$$;
revoke all on function public.process_price_feed(text) from public, anon, authenticated;

-- ---------- 4. fetching the price feed and running the check ----------
create extension if not exists http with schema extensions;

create or replace function public.run_limit_orders()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status int;
  v_body text;
  v_filled int;
begin
  if not exists (select 1 from public.orders where status = 'open') then
    update public.order_checks set checked_at = now(), ok = true, filled = 0, note = 'No open orders' where id = 1;
    return;
  end if;
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '25000');
  select status, content into v_status, v_body
  from http_get('https://docs.google.com/spreadsheets/d/13SfuLb3d5nv2o2-GCNQIRsD1OU-pD1rG4j0TeGA5xNg/gviz/tq?tqx=out:csv&headers=1&sheet=Feed&tq=select%20A%2CD%2CJ%2CK%2CL');
  if v_status <> 200 or v_body is null or v_body not like '%trade_date%' then
    update public.order_checks set checked_at = now(), ok = false, filled = 0,
      note = 'Price feed did not load (status ' || coalesce(v_status::text, 'none') || ')' where id = 1;
    return;
  end if;
  v_filled := public.process_price_feed(v_body);
  update public.order_checks set checked_at = now(), ok = true, filled = v_filled, note = null where id = 1;
exception when others then
  update public.order_checks set checked_at = now(), ok = false, filled = 0, note = left(sqlerrm, 200) where id = 1;
end;
$$;
revoke all on function public.run_limit_orders() from public, anon, authenticated;

-- ---------- 5. the timer ----------
-- Every five minutes from 9am to 7pm Sydney time (covers both daylight saving and
-- standard time; the times below are in UTC, which is what the timer uses).
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'lighthouse-limit-orders';
  perform cron.schedule('lighthouse-limit-orders', '*/5 22-23,0-8 * * *', 'select public.run_limit_orders()');
end;
$$;

-- Run it once now so the website shows a first check straight away.
select public.run_limit_orders();
select checked_at, ok, filled, note from public.order_checks;

notify pgrst, 'reload schema';
