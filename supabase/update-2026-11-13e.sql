-- Lighthouse Fund database update, 13 November 2026 (fifth part).
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It saves the fund's value once every trading day so the website can draw
-- the performance chart. Run update-2026-11-13c.sql before this one.
-- It is safe to run more than once. It does NOT change any existing trades.

-- ---------- 1. one row per trading day ----------
create table if not exists public.fund_snapshots (
  day date primary key,
  fund_value numeric not null,
  cash numeric not null,
  benchmark_price numeric,
  updated_at timestamptz not null default now()
);
alter table public.fund_snapshots enable row level security;
drop policy if exists "snapshots are public" on public.fund_snapshots;
create policy "snapshots are public" on public.fund_snapshots
  for select to authenticated using (true);
revoke all on public.fund_snapshots from anon, authenticated;
grant select on public.fund_snapshots to authenticated;

-- ---------- 2. working out the fund's value from the price feed ----------
-- Saves (or updates) today's row. Does nothing on a day the market has not traded,
-- or if a share the fund holds has no price, so the chart never gets a false dip.
create or replace function public.record_snapshot(p_csv text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Australia/Sydney')::date;
  v_cash numeric;
  v_holdings numeric;
  v_missing int;
  v_bench numeric;
  v_bench_date text;
begin
  create temp table if not exists lh_feed (code text primary key, price numeric, trade_date text) on commit drop;
  truncate lh_feed;
  insert into lh_feed
  select upper(f[1]), case when f[2] ~ '^[0-9.]+$' then f[2]::numeric else 0 end, f[5]
  from (
    select string_to_array(replace(l, '"', ''), ',') as f
    from regexp_split_to_table(p_csv, E'\r?\n') as l
    where l ~ '^"?[A-Za-z0-9]+"?,'
  ) x
  where array_length(f, 1) >= 5 and upper(f[1]) <> 'CODE'
  on conflict (code) do nothing;

  select price, trade_date into v_bench, v_bench_date from lh_feed where code = 'VAS';
  if v_bench is null or v_bench <= 0 or v_bench_date is distinct from to_char(v_today, 'YYYY-MM-DD') then
    return false;
  end if;

  select coalesce(sum(case
      when type in ('deposit', 'dividend') then cash_amount
      when type = 'buy' then -(quantity * price + brokerage)
      when type = 'sell' then quantity * price - brokerage
    end), 0)
  into v_cash from public.trades;

  select coalesce(sum(h.qty * coalesce(f.price, 0)), 0),
         count(*) filter (where coalesce(f.price, 0) <= 0)
  into v_holdings, v_missing
  from (
    select code, sum(case when type = 'buy' then quantity when type = 'sell' then -quantity else 0 end) as qty
    from public.trades where type in ('buy', 'sell') group by code
  ) h
  left join lh_feed f on f.code = h.code
  where h.qty > 0;

  if v_missing > 0 then
    return false;
  end if;

  insert into public.fund_snapshots (day, fund_value, cash, benchmark_price, updated_at)
  values (v_today, round(v_cash + v_holdings, 2), round(v_cash, 2), v_bench, now())
  on conflict (day) do update
    set fund_value = excluded.fund_value, cash = excluded.cash,
        benchmark_price = excluded.benchmark_price, updated_at = now();
  return true;
end;
$$;
revoke all on function public.record_snapshot(text) from public, anon, authenticated;

-- ---------- 3. the five-minute check now also saves the day's value ----------
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
  perform public.record_snapshot(v_body);
  update public.order_checks set checked_at = now(), ok = true, filled = v_filled, note = null where id = 1;
exception when others then
  update public.order_checks set checked_at = now(), ok = false, filled = 0, note = left(sqlerrm, 200) where id = 1;
end;
$$;
revoke all on function public.run_limit_orders() from public, anon, authenticated;

-- Run it once now and show the result: the check, then any saved days.
select public.run_limit_orders();
select checked_at, ok, filled, note from public.order_checks;
select * from public.fund_snapshots order by day desc limit 3;

notify pgrst, 'reload schema';
