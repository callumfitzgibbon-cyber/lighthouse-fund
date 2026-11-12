# AFSA Lighthouse Fund

A paper-trading app for the AFSA Lighthouse Fund, a simulated student-run portfolio at Macquarie University. No real money is involved.

## What it does

- **Portfolio**: fund value, return since inception, holdings, allocation and mandate checks.
- **Trade**: search the stock list and buy or sell. Orders fill straight away at the latest delayed price.
- **History**: a permanent record of every trade, with CSV download.
- **Members**: the admin sets who can trade.

The app enforces the fund's rules on every order:

| Rule | Setting |
| --- | --- |
| Brokerage | A$10 or 0.10% of the trade, whichever is higher |
| Single stock limit | 15% of the fund |
| Index ETF floor | A$40,000 in VAS |
| Active sleeve cap | A$30,000 |
| Excluded stocks | Flagged in the price feed (top 10 companies and any manual exclusions) |

Settings live in `js/config.js`.

## How it is built

Plain HTML, CSS and JavaScript with no build step, so it can be hosted on GitHub Pages as is.

- `index.html`, `css/`, `js/`: the app.
- `js/config.js`: settings, the database address and the price feed address.
- `supabase/schema.sql`: database tables and access rules.
- `js/vendor/supabase.js`: the Supabase client library (v2.45.4), included so the app loads nothing from other sites.

Prices come from a Google Sheet that uses `GOOGLEFINANCE`, read as CSV. They are delayed by up to 20 minutes.

## Demo mode

With `SUPABASE_URL` left empty in `js/config.js`, the app runs in demo mode. Trades are saved in the browser only. To try it locally:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Going live

1. **Database.** Create a free project at supabase.com. Open the SQL editor, paste in `supabase/schema.sql` and run it. Copy the project URL and the anon public key into `js/config.js`. The anon key is designed to be public. Never put the service role key in this repository.
2. **First admin.** Create your account in the app, then run this in the Supabase SQL editor with your email:
   ```sql
   update public.profiles set role = 'admin' where email = 'you@example.com';
   ```
   After that, set other people's roles on the Members page.
3. **Price feed.** Share the price feed sheet as "Anyone with the link can view". It holds only public market prices.
4. **Hosting.** In the repository settings, turn on GitHub Pages for the `main` branch. In Supabase, add the site address under Authentication, URL Configuration.

## Access rules

- Anyone can view the portfolio and trade history.
- Only traders and admins can place trades. Only admins can add capital or change roles.
- Trades can never be edited or deleted. The database refuses it.
- The database sets the brokerage, the trader and the time itself, and refuses orders the fund cannot afford or shares it does not hold.

The 15% limit, ETF floor and sleeve cap are checked in the app before an order is sent. The price on an order comes from the trader's browser, so traders are trusted to be committee members.

## Disclaimer

The AFSA Lighthouse Fund is a simulated student portfolio run for educational purposes. Nothing here is financial advice.
