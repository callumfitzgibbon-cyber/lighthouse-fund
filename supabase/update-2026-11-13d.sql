-- Lighthouse Fund database update, 13 November 2026 (fourth part).
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It makes sure only a fund manager can record a dividend, and that every dividend
-- names a stock and an amount. It is safe to run more than once.
-- It does NOT change any existing trades.

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
    if auth.uid() is not null and coalesce(public.current_role_name(), 'viewer') <> 'admin' then
      raise exception 'Only a fund manager can add capital or record dividends';
    end if;
    if new.type = 'dividend' then
      new.code := upper(new.code);
      new.quantity := null;
      new.price := null;
      new.sleeve := null;
      if new.code is null or new.cash_amount is null or new.cash_amount <= 0 then
        raise exception 'A dividend needs a stock and an amount above zero';
      end if;
    end if;
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
