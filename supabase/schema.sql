-- Lighthouse Fund database setup for Supabase.
-- Paste this whole file into the Supabase SQL editor and run it once.

-- ---------- members ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'viewer' check (role in ('viewer', 'trader', 'admin')),
  created_at timestamptz not null default now()
);

-- Every new sign-up gets a viewer profile.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', new.email));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.current_role_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Members cannot promote themselves: only an admin may change a role.
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and coalesce(public.current_role_name(), 'viewer') <> 'admin' then
    raise exception 'Only an admin can change roles';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_role on public.profiles;
create trigger protect_profile_role
  before update on public.profiles
  for each row execute function public.protect_profile_role();

-- ---------- trades (append-only) ----------
create table if not exists public.trades (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  trader_name text,
  type text not null check (type in ('buy', 'sell', 'dividend', 'deposit')),
  code text,
  sleeve text check (sleeve in ('index', 'competition', 'active')),
  quantity numeric check (quantity is null or quantity > 0),
  price numeric check (price is null or price > 0),
  brokerage numeric not null default 0,
  cash_amount numeric,
  note text,
  constraint trade_shape check (
    (type in ('buy', 'sell') and code is not null and quantity is not null and price is not null and sleeve is not null)
    or (type in ('dividend', 'deposit') and cash_amount is not null)
  )
);

-- The database sets who traded, when, and the brokerage, and refuses
-- trades the fund cannot afford or shares it does not hold.
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
begin
  -- One trade at a time, so two orders cannot both spend the same cash.
  perform pg_advisory_xact_lock(727001);

  if auth.uid() is not null then
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  new.code := upper(new.code);

  if new.type in ('buy', 'sell') then
    v_value := new.quantity * new.price;
    new.brokerage := round(greatest(10, v_value * 0.001), 2);
    new.cash_amount := null;

    select coalesce(sum(case
        when type in ('deposit', 'dividend') then cash_amount
        when type = 'buy' then -(quantity * price + brokerage)
        when type = 'sell' then quantity * price - brokerage
      end), 0)
    into v_cash from public.trades;

    select coalesce(sum(case when type = 'buy' then quantity when type = 'sell' then -quantity else 0 end), 0)
    into v_held from public.trades where code = new.code;

    if new.type = 'buy' and v_value + new.brokerage > v_cash then
      raise exception 'Not enough cash for this order';
    end if;
    if new.type = 'sell' and new.quantity > v_held then
      raise exception 'The fund does not hold that many shares';
    end if;
  else
    new.brokerage := 0;
    if new.type = 'deposit' and auth.uid() is not null
       and coalesce(public.current_role_name(), 'viewer') <> 'admin' then
      raise exception 'Only an admin can add capital';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists check_trade on public.trades;
create trigger check_trade
  before insert on public.trades
  for each row execute function public.check_trade();

-- ---------- access rules ----------
alter table public.profiles enable row level security;
alter table public.trades enable row level security;

-- Anyone can read the trade record. Only traders and admins can add to it.
-- There are no update or delete rules, so nobody can change or remove a trade.
drop policy if exists "trades are public" on public.trades;
create policy "trades are public" on public.trades
  for select to anon, authenticated using (true);

drop policy if exists "traders add trades" on public.trades;
create policy "traders add trades" on public.trades
  for insert to authenticated
  with check (public.current_role_name() in ('trader', 'admin'));

drop policy if exists "read own profile or admin reads all" on public.profiles;
create policy "read own profile or admin reads all" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.current_role_name() = 'admin');

drop policy if exists "admin updates profiles" on public.profiles;
create policy "admin updates profiles" on public.profiles
  for update to authenticated
  using (public.current_role_name() = 'admin')
  with check (public.current_role_name() = 'admin');

revoke all on public.trades from anon, authenticated;
grant select on public.trades to anon, authenticated;
grant insert on public.trades to authenticated;
grant select, update on public.profiles to authenticated;

-- ---------- starting capital ----------
insert into public.trades (type, cash_amount, note, trader_name)
select 'deposit', 100000, 'Notional starting capital', 'System'
where not exists (select 1 from public.trades);
