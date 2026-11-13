-- Lighthouse Fund database update, 13 November 2026.
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It adds job titles, charter sign-off, the fund manager's trade approval code,
-- limit orders, and removing accounts. It is safe to run more than once.
-- It does NOT touch the trade record.

-- ---------- 1. job titles and charter sign-off ----------
alter table public.profiles add column if not exists title text;
alter table public.profiles add column if not exists charter_agreed_at timestamptz;
alter table public.profiles add column if not exists charter_version text;

-- New sign-ups record that they agreed to the charter on the sign-up form.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, charter_agreed_at, charter_version)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.email),
    case when new.raw_user_meta_data ->> 'charter_agreed' = 'true' then now() end,
    case when new.raw_user_meta_data ->> 'charter_agreed' = 'true' then left(new.raw_user_meta_data ->> 'charter_version', 20) end
  );
  return new;
end;
$$;

-- Members can change their own name and photo and agree to the charter,
-- but not their role, email or job title.
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and coalesce(public.current_role_name(), 'viewer') <> 'admin' then
    if new.role is distinct from old.role then
      raise exception 'Only a fund manager can change roles';
    end if;
    if new.email is distinct from old.email then
      raise exception 'Change your email from the profile page';
    end if;
    if new.title is distinct from old.title then
      raise exception 'Only a fund manager can change job titles';
    end if;
  end if;

  -- The agreement date is set by the database and cannot be changed or removed afterwards.
  if auth.uid() is not null and new.charter_agreed_at is distinct from old.charter_agreed_at then
    if old.charter_agreed_at is null and new.id = auth.uid() then
      new.charter_agreed_at := now();
    else
      new.charter_agreed_at := old.charter_agreed_at;
      new.charter_version := old.charter_version;
    end if;
  end if;

  new.title := left(nullif(btrim(new.title), ''), 40);
  new.display_name := left(nullif(btrim(new.display_name), ''), 60);
  if new.display_name is null then
    new.display_name := old.display_name;
  end if;
  return new;
end;
$$;

-- ---------- 2. trade approval code ----------
-- A secret only the database can read. The code is worked out from it and the time.
create table if not exists public.fund_secrets (
  id int primary key check (id = 1),
  trade_code_secret text not null
);
alter table public.fund_secrets enable row level security;
revoke all on public.fund_secrets from anon, authenticated;
insert into public.fund_secrets (id, trade_code_secret)
values (1, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (id) do nothing;

-- The six-digit code for a given five-minute window.
create or replace function public.trade_code_for(p_window bigint)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lpad(((('x' || substr(md5(trade_code_secret || ':' || p_window::text), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0')
  from public.fund_secrets where id = 1;
$$;
revoke all on function public.trade_code_for(bigint) from public, anon, authenticated;

-- Only a fund manager is given the current code.
create or replace function public.get_trade_code()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_window bigint := floor(extract(epoch from now()) / 300);
begin
  if coalesce(public.current_role_name(), 'viewer') <> 'admin' then
    raise exception 'Only a fund manager can see the approval code';
  end if;
  return json_build_object('code', public.trade_code_for(v_window), 'expires_at', to_timestamp((v_window + 1) * 300));
end;
$$;
revoke all on function public.get_trade_code() from public, anon;
grant execute on function public.get_trade_code() to authenticated;

-- The code an analyst typed is checked and then thrown away, never stored.
alter table public.trades add column if not exists approval_code text;
alter table public.trades add column if not exists approved boolean not null default false;

create or replace function public.check_trade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cash numeric;
  v_held numeric;
  v_value numeric;
  v_window bigint := floor(extract(epoch from now()) / 300);
  v_from_order boolean := coalesce(current_setting('lighthouse.order_fill', true), '') = '1';
begin
  -- One trade at a time, so two orders cannot both spend the same cash.
  perform pg_advisory_xact_lock(727001);

  if v_from_order then
    -- A limit order being filled: it was approved when it was placed.
    new.created_at := now();
  elsif auth.uid() is not null then
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  new.code := upper(new.code);

  if new.type in ('buy', 'sell') then
    -- Every trade goes through the fund manager: anyone else needs the current code
    -- (or the one that expired in the last five minutes).
    if not v_from_order and auth.uid() is not null and coalesce(public.current_role_name(), 'viewer') <> 'admin' then
      if new.approval_code is null
         or btrim(new.approval_code) not in (public.trade_code_for(v_window), public.trade_code_for(v_window - 1)) then
        raise exception 'That approval code is wrong or has expired. Ask the fund manager for the current code.';
      end if;
    end if;
    new.approved := true;
    new.approval_code := null;

    v_value := new.quantity * new.price;
    new.brokerage := 0;
    new.cash_amount := null;

    select coalesce(sum(case
        when type in ('deposit', 'dividend') then cash_amount
        when type = 'buy' then -(quantity * price + brokerage)
        when type = 'sell' then quantity * price - brokerage
      end), 0)
    into v_cash from public.trades;

    select coalesce(sum(case when type = 'buy' then quantity when type = 'sell' then -quantity else 0 end), 0)
    into v_held from public.trades where code = new.code;

    if new.type = 'buy' and v_value > v_cash then
      raise exception 'Not enough cash for this order';
    end if;
    if new.type = 'sell' and new.quantity > v_held then
      raise exception 'The fund does not hold that many shares';
    end if;
  else
    new.brokerage := 0;
    new.approval_code := null;
    if new.type = 'deposit' and auth.uid() is not null
       and coalesce(public.current_role_name(), 'viewer') <> 'admin' then
      raise exception 'Only an admin can add capital';
    end if;
  end if;
  return new;
end;
$$;

-- ---------- 3. limit orders ----------
-- An order that waits until the price reaches its limit. Filling it adds a normal trade.
create table if not exists public.orders (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  trader_name text,
  side text not null check (side in ('buy', 'sell')),
  code text not null,
  sleeve text not null check (sleeve in ('index', 'competition', 'active')),
  quantity numeric not null check (quantity > 0),
  limit_price numeric not null check (limit_price > 0),
  status text not null default 'open' check (status in ('open', 'filled', 'cancelled')),
  closed_at timestamptz,
  fill_price numeric,
  approval_code text
);

create or replace function public.check_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window bigint := floor(extract(epoch from now()) / 300);
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
    new.created_at := now();
    if coalesce(public.current_role_name(), 'viewer') <> 'admin' then
      if new.approval_code is null
         or btrim(new.approval_code) not in (public.trade_code_for(v_window), public.trade_code_for(v_window - 1)) then
        raise exception 'That approval code is wrong or has expired. Ask the fund manager for the current code.';
      end if;
    end if;
  end if;
  new.code := upper(new.code);
  new.status := 'open';
  new.closed_at := null;
  new.fill_price := null;
  new.approval_code := null;
  return new;
end;
$$;

drop trigger if exists check_order on public.orders;
create trigger check_order
  before insert on public.orders
  for each row execute function public.check_order();

alter table public.orders enable row level security;
drop policy if exists "orders are public" on public.orders;
create policy "orders are public" on public.orders
  for select to anon, authenticated using (true);
drop policy if exists "traders place orders" on public.orders;
create policy "traders place orders" on public.orders
  for insert to authenticated
  with check (public.current_role_name() in ('trader', 'admin'));
revoke all on public.orders from anon, authenticated;
grant select on public.orders to anon, authenticated;
grant insert on public.orders to authenticated;

-- Fills an open order once the market price has reached its limit.
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
  if p_price is null or p_price <= 0
     or (v_order.side = 'buy' and p_price > v_order.limit_price)
     or (v_order.side = 'sell' and p_price < v_order.limit_price) then
    raise exception 'The price has not reached the limit';
  end if;

  perform set_config('lighthouse.order_fill', '1', true);
  insert into public.trades (type, code, sleeve, quantity, price, note, trader_name, created_by)
  values (v_order.side, v_order.code, v_order.sleeve, v_order.quantity, p_price,
          'Limit order at $' || trim(to_char(v_order.limit_price, 'FM999999990.00')), v_order.trader_name, v_order.created_by)
  returning id into v_trade_id;
  perform set_config('lighthouse.order_fill', '', true);

  update public.orders set status = 'filled', closed_at = now(), fill_price = p_price where id = p_id;
  return v_trade_id;
end;
$$;
revoke all on function public.fill_order(bigint, numeric) from public, anon;
grant execute on function public.fill_order(bigint, numeric) to authenticated;

-- The person who placed an order, or a fund manager, can cancel it while it is open.
create or replace function public.cancel_order(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = p_id for update;
  if not found or v_order.status <> 'open' then
    raise exception 'That order is no longer open';
  end if;
  if coalesce(public.current_role_name(), 'viewer') <> 'admin' and v_order.created_by is distinct from auth.uid() then
    raise exception 'Only the person who placed the order or a fund manager can cancel it';
  end if;
  update public.orders set status = 'cancelled', closed_at = now() where id = p_id;
end;
$$;
revoke all on function public.cancel_order(bigint) from public, anon;
grant execute on function public.cancel_order(bigint) to authenticated;

-- ---------- 4. removing accounts ----------
-- Trades stay on the record under the person's name after their account is removed.
alter table public.trades drop constraint if exists trades_created_by_fkey;
alter table public.trades add constraint trades_created_by_fkey
  foreign key (created_by) references public.profiles (id) on delete set null;

create or replace function public.remove_member(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(public.current_role_name(), 'viewer') <> 'admin' then
    raise exception 'Only a fund manager can remove accounts';
  end if;
  if p_id = auth.uid() then
    raise exception 'You cannot remove your own account';
  end if;
  update public.orders set status = 'cancelled', closed_at = now() where created_by = p_id and status = 'open';
  delete from auth.users where id = p_id;
  delete from public.profiles where id = p_id;
end;
$$;
revoke all on function public.remove_member(uuid) from public, anon;
grant execute on function public.remove_member(uuid) to authenticated;

-- Tell the API about the new columns and functions straight away.
notify pgrst, 'reload schema';
