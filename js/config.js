// Lighthouse Fund app settings.
// Leave SUPABASE_URL empty to run in demo mode (data stays in this browser only).
// The key below is the publishable key, which is safe to be public. Never put a secret key here.
window.LIGHTHOUSE_CONFIG = {
  SUPABASE_URL: "https://ubsvtdzwcfyxfpgozmhx.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_UGJKCcLuQelrTVuxVBVWrQ_MuEiIqIe",

  // CSV price feed. Columns: code,name,sector,price,change_pct,market_cap,excluded,updated
  PRICES_CSV_URL: "https://docs.google.com/spreadsheets/d/13SfuLb3d5nv2o2-GCNQIRsD1OU-pD1rG4j0TeGA5xNg/gviz/tq?tqx=out:csv&headers=1&sheet=Feed",

  FUND_NAME: "AFSA Lighthouse Fund",
  STARTING_CAPITAL: 100000,
  INCEPTION_DATE: "2027-07-01",
  ETF_CODE: "VAS",
  BROKERAGE_FLAT: 0, // trades are free. Set to 10 and 0.001 to charge brokerage again
  BROKERAGE_RATE: 0, // (the database function check_trade must be changed to match)
  ENFORCE_EXCLUSIONS: false, // true blocks stocks flagged "excluded" in the feed (the ten largest)
  COMPANY_INFO_URL: "https://www.marketindex.com.au/asx/{code}", // {code} is replaced in lower case
  MAX_STOCK_WEIGHT: 0.15,
  MIN_ETF_VALUE: 0, // set to 40000 to bring back the index ETF floor
  ACTIVE_SLEEVE_CAP: 30000,
  PRICE_REFRESH_SECONDS: 120
};
