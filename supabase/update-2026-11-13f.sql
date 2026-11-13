-- Lighthouse Fund database update, 13 November 2026 (sixth part).
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It makes the fund's trades, orders and value history readable only by people who
-- are signed in. Visitors without an account can no longer see them.
-- It is safe to run more than once. It does NOT change any existing trades.

drop policy if exists "trades are public" on public.trades;
drop policy if exists "members read trades" on public.trades;
create policy "members read trades" on public.trades
  for select to authenticated using (true);
revoke select on public.trades from anon;

do $$
declare
  t text;
begin
  foreach t in array array['orders', 'fund_snapshots', 'order_checks'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists "orders are public" on public.%I', t);
      execute format('drop policy if exists "snapshots are public" on public.%I', t);
      execute format('drop policy if exists "order checks are public" on public.%I', t);
      execute format('drop policy if exists "members read" on public.%I', t);
      execute format('create policy "members read" on public.%I for select to authenticated using (true)', t);
      execute format('revoke select on public.%I from anon', t);
    end if;
  end loop;
end;
$$;

notify pgrst, 'reload schema';

-- Shows who can read each table now. Every row should say "authenticated" only.
select tablename, policyname, roles from pg_policies
where schemaname = 'public' and cmd = 'SELECT' and tablename in ('trades', 'orders', 'fund_snapshots', 'order_checks')
order by tablename;
