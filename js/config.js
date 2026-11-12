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
  BROKERAGE_FLAT: 10,
  BROKERAGE_RATE: 0.001,
  MAX_STOCK_WEIGHT: 0.15,
  MIN_ETF_VALUE: 40000,
  ACTIVE_SLEEVE_CAP: 30000,
  PRICE_REFRESH_SECONDS: 120
};
