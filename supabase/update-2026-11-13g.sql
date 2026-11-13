-- Lighthouse Fund database update, 13 November 2026 (seventh part).
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It adds: market orders that wait for the market to open, a small buy and sell spread,
-- trade proposals that the fund manager approves, price targets and review prices,
-- and the manager's comment on the monthly report.
-- It is safe to run more than once. It does NOT change any existing trades.

-- ---------- 1. market orders that wait for the open ----------
alter table public.orders add column if not exists kind text not null default 'limit';
alter table public.orders add column if not exists note text;
alter table public.orders drop constraint if exists orders_kind_check;
alter table public.orders add constraint orders_kind_check check (kind in ('limit', 'market'));

-- Takes the price feed as text (code, price, day low, day high, trade date) and fills
-- every open order that is due. Returns how many were filled.
--   Market orders fill once the stock has traded today and the ASX is open, at the price
--   plus or minus a 0.1% spread.
--   Limit orders fill while the ASX is open once the price is through the limit, or at the
--   limit if the day's range touched it after the order was placed.
create or replace function public.process_price_feed(p_csv text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamp := now() at time zone 'Australia/Sydney';
  v_today date := (now() at time zone 'Australia/Sydney')::date;
  v_open timestamp := (now() at time zone 'Australia/Sydney')::date + interval '10 hours';
  -- The feed runs about 20 minutes behind, so prices keep arriving until about 4:30pm.
  v_session boolean := extract(isodow from (now() at time zone 'Australia/Sydney')) between 1 and 5
    and (now() at time zone 'Australia/Sydney')::time between time '10:00' and time '16:30';
  v_spread numeric := 0.001;
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
    if not coalesce(r.traded_today, false) then
      -- Nothing has traded today (market not open yet, weekend or holiday): every order waits.
      null;
    elsif r.kind = 'market' then
      if v_session then
        v_price := round(r.px * (case when r.side = 'buy' then 1 + v_spread else 1 - v_spread end), 3);
      end if;
    elsif r.side = 'buy' then
      if v_session and r.px <= r.limit_price then
        v_price := r.px;
      elsif r.day_low > 0 and r.day_low <= r.limit_price then
        -- The price touched the limit earlier today. That only counts if it happened
        -- after the order was placed.
        if (r.created_at at time zone 'Australia/Sydney') < v_open
           or (r.placed_low > 0 and r.day_low < r.placed_low) then
          v_price := r.limit_price;
        end if;
      end if;
    else
      if v_session and r.px >= r.limit_price then
        v_price := r.px;
      elsif r.day_high > 0 and r.day_high >= r.limit_price then
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
                coalesce(r.note, case when r.kind = 'market' then 'Market order placed while the market was closed'
                                      else 'Limit order at $' || trim(to_char(r.limit_price, 'FM999999990.00')) end),
                r.trader_name, r.created_by);
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

-- The website can also fill an order that is due while someone has it open.
create or replace function public.fill_order(p_id bigint, p_price numeric)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_trade_id bigint;
begin
  if coalesce(public.current_role_name(), 'viewer') not in ('trader', 'admin') then
    raise exception 'Only analysts and fund managers can fill orders';
  end if;
  select * into v_order from public.orders where id = p_id for update;
  if not found or v_order.status <> 'open' then
    raise exception 'That order is no longer open';
  end if;
  if p_price is null or p_price <= 0 then
    raise exception 'A price is needed to fill an order';
  end if;
  if v_order.kind = 'limit'
     and ((v_order.side = 'buy' and p_price > v_order.limit_price)
       or (v_order.side = 'sell' and p_price < v_order.limit_price)) then
    raise exception 'The price has not reached the limit';
  end if;

  perform set_config('lighthouse.order_fill', '1', true);
  insert into public.trades (type, code, sleeve, quantity, price, note, trader_name, created_by)
  values (v_order.side, v_order.code, v_order.sleeve, v_order.quantity, p_price,
          coalesce(v_order.note, case when v_order.kind = 'market' then 'Market order placed while the market was closed'
                                      else 'Limit order at $' || trim(to_char(v_order.limit_price, 'FM999999990.00')) end),
          v_order.trader_name, v_order.created_by)
  returning id into v_trade_id;
  perform set_config('lighthouse.order_fill', '', true);

  update public.orders set status = 'filled', closed_at = now(), fill_price = p_price where id = p_id;
  return v_trade_id;
end;
$$;
revoke all on function public.fill_order(bigint, numeric) from public, anon;
grant execute on function public.fill_order(bigint, numeric) to authenticated;

-- ---------- 2. trade proposals ----------
-- An analyst proposes a trade with a short case. The fund manager approves or rejects it.
create table if not exists public.proposals (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  trader_name text,
  side text not null check (side in ('buy', 'sell')),
  code text not null,
  sleeve text not null check (sleeve in ('index', 'competition', 'active')),
  quantity numeric not null check (quantity > 0),
  order_type text not null default 'market' check (order_type in ('market', 'limit')),
  limit_price numeric,
  ref_price numeric,
  rationale text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  decided_by uuid,
  decided_name text
);

create or replace function public.check_proposal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  new.code := upper(new.code);
  new.rationale := left(nullif(btrim(new.rationale), ''), 600);
  if new.rationale is null then
    raise exception 'A proposal needs a short case for the trade';
  end if;
  new.status := 'pending';
  new.decided_at := null;
  new.decided_by := null;
  new.decided_name := null;
  return new;
end;
$$;

drop trigger if exists check_proposal on public.proposals;
create trigger check_proposal
  before insert on public.proposals
  for each row execute function public.check_proposal();

alter table public.proposals enable row level security;
drop policy if exists "members read proposals" on public.proposals;
create policy "members read proposals" on public.proposals
  for select to authenticated using (true);
drop policy if exists "traders add proposals" on public.proposals;
create policy "traders add proposals" on public.proposals
  for insert to authenticated
  with check (public.current_role_name() in ('trader', 'admin'));
revoke all on public.proposals from anon, authenticated;
grant select, insert on public.proposals to authenticated;

-- Only a fund manager can decide a proposal, and only once.
create or replace function public.decide_proposal(p_id bigint, p_status text, p_name text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(public.current_role_name(), 'viewer') <> 'admin' then
    raise exception 'Only a fund manager can approve or reject a proposal';
  end if;
  if p_status not in ('approved', 'rejected') then
    raise exception 'A proposal can only be approved or rejected';
  end if;
  update public.proposals
  set status = p_status, decided_at = now(), decided_by = auth.uid(), decided_name = left(p_name, 60)
  where id = p_id and status = 'pending';
  if not found then
    raise exception 'That proposal has already been decided';
  end if;
end;
$$;
revoke all on function public.decide_proposal(bigint, text, text) from public, anon;
grant execute on function public.decide_proposal(bigint, text, text) to authenticated;

-- ---------- 3. price targets and review prices ----------
create table if not exists public.position_levels (
  code text primary key,
  target numeric check (target is null or target > 0),
  stop numeric check (stop is null or stop > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_name text
);

create or replace function public.stamp_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists stamp_position_levels on public.position_levels;
create trigger stamp_position_levels
  before insert or update on public.position_levels
  for each row execute function public.stamp_update();

alter table public.position_levels enable row level security;
drop policy if exists "members read levels" on public.position_levels;
create policy "members read levels" on public.position_levels
  for select to authenticated using (true);
drop policy if exists "traders set levels" on public.position_levels;
create policy "traders set levels" on public.position_levels
  for insert to authenticated
  with check (public.current_role_name() in ('trader', 'admin'));
drop policy if exists "traders change levels" on public.position_levels;
create policy "traders change levels" on public.position_levels
  for update to authenticated
  using (public.current_role_name() in ('trader', 'admin'))
  with check (public.current_role_name() in ('trader', 'admin'));
revoke all on public.position_levels from anon, authenticated;
grant select, insert, update on public.position_levels to authenticated;

-- ---------- 4. the manager's comment on the monthly report ----------
create table if not exists public.fund_reports (
  month text primary key check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  comment text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_name text
);

drop trigger if exists stamp_fund_reports on public.fund_reports;
create trigger stamp_fund_reports
  before insert or update on public.fund_reports
  for each row execute function public.stamp_update();

alter table public.fund_reports enable row level security;
drop policy if exists "members read reports" on public.fund_reports;
create policy "members read reports" on public.fund_reports
  for select to authenticated using (true);
drop policy if exists "manager writes reports" on public.fund_reports;
create policy "manager writes reports" on public.fund_reports
  for insert to authenticated
  with check (public.current_role_name() = 'admin');
drop policy if exists "manager changes reports" on public.fund_reports;
create policy "manager changes reports" on public.fund_reports
  for update to authenticated
  using (public.current_role_name() = 'admin')
  with check (public.current_role_name() = 'admin');
revoke all on public.fund_reports from anon, authenticated;
grant select, insert, update on public.fund_reports to authenticated;

notify pgrst, 'reload schema';

-- Shows the four new pieces. Each row should say true.
select 'orders can wait for the open' as piece, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'kind') as ready
union all select 'trade proposals', to_regclass('public.proposals') is not null
union all select 'targets and review prices', to_regclass('public.position_levels') is not null
union all select 'report comments', to_regclass('public.fund_reports') is not null;
