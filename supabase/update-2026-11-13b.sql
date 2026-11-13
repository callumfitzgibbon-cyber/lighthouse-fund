-- Lighthouse Fund database update, 13 November 2026 (second part).
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It lets a limit order remember the day's low and high at the moment it was placed,
-- so the site can tell whether the price touched the limit afterwards.
-- It is safe to run more than once. It does NOT touch the trade record.

alter table public.orders add column if not exists placed_low numeric;
alter table public.orders add column if not exists placed_high numeric;

notify pgrst, 'reload schema';
