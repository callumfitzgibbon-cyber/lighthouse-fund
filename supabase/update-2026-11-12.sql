-- Lighthouse Fund database update, 12 November 2026.
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It makes trades free, adds profile photos and self-service name changes,
-- and RESETS THE TRADE RECORD to a clean A$100,000.

-- ---------- 1. free trades (no brokerage) ----------
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
    if new.type = 'deposit' and auth.uid() is not null
       and coalesce(public.current_role_name(), 'viewer') <> 'admin' then
      raise exception 'Only an admin can add capital';
    end if;
  end if;
  return new;
end;
$$;

-- ---------- 2. profiles: photo, and members can edit their own name and photo ----------
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles drop constraint if exists profiles_avatar_size;
alter table public.profiles add constraint profiles_avatar_size
  check (avatar_url is null or (char_length(avatar_url) < 200000 and avatar_url like 'data:image/%'));

-- Members can change their own name and photo, but not their role or email.
create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and coalesce(public.current_role_name(), 'viewer') <> 'admin' then
    if new.role is distinct from old.role then
      raise exception 'Only an admin can change roles';
    end if;
    if new.email is distinct from old.email then
      raise exception 'Change your email from the profile page';
    end if;
  end if;
  new.display_name := left(nullif(btrim(new.display_name), ''), 60);
  if new.display_name is null then
    new.display_name := old.display_name;
  end if;
  return new;
end;
$$;

drop policy if exists "members update own profile" on public.profiles;
create policy "members update own profile" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Keep the profile's email in step when someone confirms a new email address.
create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (new.email is distinct from old.email)
  execute function public.sync_profile_email();

-- ---------- 3. reset the trade record ----------
truncate table public.trades restart identity;
insert into public.trades (type, cash_amount, note, trader_name)
values ('deposit', 100000, 'Notional starting capital', 'System');
