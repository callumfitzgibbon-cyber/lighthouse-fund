(function () {
  "use strict";

  var CFG = window.LIGHTHOUSE_CONFIG;
  var NO_DATABASE = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
  var LS_DEMO_ON = "lighthouse.demo.on";
  // Demo mode can be switched on from the site. It keeps trades in this browser and never touches the real fund.
  var DEMO_CHOSEN = false;
  try {
    if (/[?&]demo=1\b/.test(window.location.search)) localStorage.setItem(LS_DEMO_ON, "1");
    DEMO_CHOSEN = localStorage.getItem(LS_DEMO_ON) === "1";
  } catch (e) { DEMO_CHOSEN = /[?&]demo=1\b/.test(window.location.search); }
  var DEMO = NO_DATABASE || DEMO_CHOSEN;
  function setDemo(on) {
    try { if (on) localStorage.setItem(LS_DEMO_ON, "1"); else localStorage.removeItem(LS_DEMO_ON); } catch (e) { /* storage unavailable */ }
    window.location.href = window.location.origin + window.location.pathname + (on ? "?demo=1" : "");
  }

  var state = {
    view: "home",
    animateNext: true,
    user: null, // { id, email, name, role }
    trades: [],
    prices: {}, // code -> { code, name, sector, price, change_pct, market_cap, excluded }
    priceList: [],
    pricesUpdated: null,
    pricesAreSample: false,
    priceError: null,
    order: { code: null, side: "buy", qtyMode: "shares", qty: "", amount: "", type: "market", limit: "", sleeve: "competition", approval: "", rationale: "" },
    orders: [], // open orders: limit orders, and market orders waiting for the open
    ordersOff: false, // true until the database has the orders table
    queueOff: false, // true until the database can hold market orders for the open
    proposals: [], // analyst trades waiting for, or decided by, the fund manager
    proposalsOn: false, // true when the database has the proposals table
    levels: {}, // price target and review level for each holding
    levelsOn: false,
    report: { month: "", comment: "" },
    search: "",
    sector: "",
    coSearch: "",
    members: [],
    freshIds: {},
    busy: false
  };

  // ---------- helpers ----------
  var money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
  function fmtMoney(n) { return money.format(isFinite(n) ? n : 0); }
  function fmtPct(n, dp) { return (isFinite(n) ? n * 100 : 0).toFixed(dp == null ? 1 : dp) + "%"; }
  function fmtQty(n) { return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 4 }).format(n); }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(sel) { return document.querySelector(sel); }
  function signClass(n) { return n > 0 ? "up" : n < 0 ? "down" : ""; }
  function canTrade() { return !!state.user && (state.user.role === "trader" || state.user.role === "admin"); }
  // Visitors without an account see nothing of the real fund. Demo mode stays open to everyone.
  function locked() { return !DEMO && !state.user; }
  function isAdmin() { return !!state.user && state.user.role === "admin"; }
  function brokerageFor(value) { return Math.max(CFG.BROKERAGE_FLAT, value * CFG.BROKERAGE_RATE); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function round3(n) { return Math.round(n * 1000) / 1000; }
  // Buys fill a little above the quoted price and sells a little below, like a real market.
  var SPREAD = CFG.SPREAD > 0 ? CFG.SPREAD : 0;
  function quote(info, side) { return round3(info.price * (side === "buy" ? 1 + SPREAD : 1 - SPREAD)); }
  function fmtPrice(n) { return Math.abs(n * 100 - Math.round(n * 100)) > 1e-6 ? "$" + Number(n).toFixed(3) : fmtMoney(n); }

  var toastTimer;
  function toast(msg) {
    var el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 4000);
  }

  // ---------- CSV ----------
  function parseCsv(text) {
    var rows = [], row = [], cur = "", inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; } }
        else { cur += c; }
      } else if (c === '"') { inQ = true; }
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c !== "\r") { cur += c; }
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function toNum(s) {
    var n = parseFloat(String(s == null ? "" : s).replace(/[$,%\s]/g, ""));
    return isFinite(n) ? n : 0;
  }

  // ---------- prices ----------
  function setPrices(list, updated, sample) {
    state.priceList = list.filter(function (p) { return p.code; });
    state.prices = {};
    state.priceList.forEach(function (p) { state.prices[p.code] = p; });
    state.pricesUpdated = updated;
    state.pricesAreSample = !!sample;
  }

  function loadPrices() {
    if (!CFG.PRICES_CSV_URL) {
      setPrices(window.LIGHTHOUSE_DEMO_PRICES.slice(), null, true);
      return Promise.resolve();
    }
    return fetch(CFG.PRICES_CSV_URL, { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("Price feed returned " + r.status); return r.text(); })
      .then(function (text) {
        var rows = parseCsv(text);
        var head = rows.shift().map(function (h) { return h.trim().toLowerCase(); });
        var idx = function (name) { return head.indexOf(name); };
        var updated = null;
        var list = rows.map(function (r) {
          var get = function (name) { var i = idx(name); return i >= 0 ? (r[i] || "").trim() : ""; };
          if (get("updated")) updated = get("updated");
          return {
            code: get("code").toUpperCase(),
            name: get("name"),
            sector: get("sector"),
            price: toNum(get("price")),
            change_pct: toNum(get("change_pct")),
            market_cap: toNum(get("market_cap")),
            day_low: toNum(get("day_low")),
            day_high: toNum(get("day_high")),
            trade_date: get("trade_date"),
            excluded: get("excluded")
          };
        });
        setPrices(list, updated, false);
        state.priceError = null;
      })
      .catch(function (e) {
        state.priceError = e.message || "Could not load prices";
        if (!state.priceList.length) setPrices(window.LIGHTHOUSE_DEMO_PRICES.slice(), null, true);
      });
  }

  // ---------- stores ----------
  var LS_TRADES = "lighthouse.demo.trades";
  var LS_PROFILE = "lighthouse.demo.profile";
  var LS_ORDERS = "lighthouse.demo.orders";
  var LS_PROPOSALS = "lighthouse.demo.proposals";
  var LS_LEVELS = "lighthouse.demo.levels";
  var LS_REPORTS = "lighthouse.demo.reports";

  var demoStore = {
    init: function () {
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem(LS_PROFILE) || "{}") || {}; } catch (e) { saved = {}; }
      state.user = { id: "demo", email: saved.email || "demo@example.com", name: saved.name || "Demo manager", role: "admin", avatar: saved.avatar || null };
      return Promise.resolve();
    },
    saveProfile: function (patch) {
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem(LS_PROFILE) || "{}") || {}; } catch (e) { saved = {}; }
      try { localStorage.setItem(LS_PROFILE, JSON.stringify(Object.assign(saved, patch))); } catch (e) { /* storage unavailable */ }
      return Promise.resolve();
    },
    updateName: function (name) { return demoStore.saveProfile({ name: name }); },
    updateAvatar: function (dataUrl) { return demoStore.saveProfile({ avatar: dataUrl }); },
    updateEmail: function (email) { return demoStore.saveProfile({ email: email }).then(function () { return true; }); },
    updatePassword: function () { return Promise.resolve(); },
    // Demo mode makes up a code that changes every five minutes, to show how approval works.
    getTradeCode: function () {
      var w = Math.floor(Date.now() / 300000);
      return Promise.resolve({ code: ("000000" + ((w * 7919 + 104729) * 2654435761 % 1000000)).slice(-6), expires: (w + 1) * 300000 });
    },
    listSnapshots: function () { return Promise.resolve([]); },
    listTrades: function () {
      var list;
      try { list = JSON.parse(localStorage.getItem(LS_TRADES) || "null"); } catch (e) { list = null; }
      if (!list) {
        list = [{ id: 1, created_at: new Date().toISOString(), type: "deposit", code: null, sleeve: null, quantity: null, price: null, brokerage: 0, cash_amount: CFG.STARTING_CAPITAL, note: "Notional starting capital", trader_name: "System" }];
        try { localStorage.setItem(LS_TRADES, JSON.stringify(list)); } catch (e) { /* storage unavailable */ }
      }
      return Promise.resolve(list);
    },
    addDividend: function (d) {
      return demoStore.listTrades().then(function (list) {
        var row = { id: list.length ? list[list.length - 1].id + 1 : 1, created_at: new Date().toISOString(), type: "dividend", code: d.code, sleeve: null, quantity: null, price: null, brokerage: 0, cash_amount: d.cash_amount, note: d.note, trader_name: state.user.name };
        list.push(row);
        try { localStorage.setItem(LS_TRADES, JSON.stringify(list)); } catch (e) { /* storage unavailable */ }
        return row;
      });
    },
    addTrade: function (t) {
      return demoStore.listTrades().then(function (list) {
        var value = t.quantity * t.price;
        var row = Object.assign({}, t, {
          id: list.length ? list[list.length - 1].id + 1 : 1,
          created_at: new Date().toISOString(),
          brokerage: round2(brokerageFor(value)),
          cash_amount: null,
          trader_name: t.trader_name || state.user.name
        });
        list.push(row);
        try { localStorage.setItem(LS_TRADES, JSON.stringify(list)); } catch (e) { /* storage unavailable */ }
        return row;
      });
    },
    readOrders: function () {
      var list;
      try { list = JSON.parse(localStorage.getItem(LS_ORDERS) || "[]") || []; } catch (e) { list = []; }
      return list;
    },
    writeOrders: function (list) { try { localStorage.setItem(LS_ORDERS, JSON.stringify(list)); } catch (e) { /* storage unavailable */ } },
    listOrders: function () { return Promise.resolve(demoStore.readOrders().filter(function (o) { return o.status === "open"; })); },
    placeOrder: function (o) {
      var list = demoStore.readOrders();
      list.push({ id: list.length + 1, created_at: new Date().toISOString(), side: o.side, code: o.code, sleeve: o.sleeve, quantity: o.quantity, limit_price: o.limit_price, kind: o.kind || "limit", note: o.note || null, placed_low: o.placed_low || null, placed_high: o.placed_high || null, status: "open", trader_name: o.trader_name || state.user.name, created_by: state.user.id });
      demoStore.writeOrders(list);
      return Promise.resolve();
    },
    closeOrder: function (id, status) {
      var list = demoStore.readOrders();
      list.forEach(function (o) { if (o.id === id) o.status = status; });
      demoStore.writeOrders(list);
    },
    cancelOrder: function (id) { demoStore.closeOrder(id, "cancelled"); return Promise.resolve(); },
    fillOrder: function (id, price) {
      var o = demoStore.readOrders().filter(function (x) { return x.id === id && x.status === "open"; })[0];
      if (!o) return Promise.reject(new Error("That order is no longer open"));
      var pf = computePortfolio(state.trades);
      var held = pf.positions.filter(function (p) { return p.code === o.code; })[0];
      if (o.side === "buy" && o.quantity * price > pf.cash + 0.005) return Promise.reject(new Error("Not enough cash for this order"));
      if (o.side === "sell" && (!held || held.qty < o.quantity)) return Promise.reject(new Error("The fund does not hold that many shares"));
      return demoStore.addTrade({ type: o.side, code: o.code, sleeve: o.sleeve, quantity: o.quantity, price: price, trader_name: o.trader_name,
        note: o.note || (o.kind === "market" ? "Market order placed while the market was closed" : "Limit order at " + fmtMoney(o.limit_price)) })
        .then(function () { demoStore.closeOrder(id, "filled"); });
    },
    signOut: function () { return Promise.resolve(); },
    listMembers: function () { return Promise.resolve([]); },
    readList: function (key) { var v; try { v = JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { v = null; } return v; },
    writeList: function (key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    listProposals: function () { state.proposalsOn = true; return Promise.resolve(demoStore.readList(LS_PROPOSALS) || []); },
    addProposal: function (p) {
      var list = demoStore.readList(LS_PROPOSALS) || [];
      list.push(Object.assign({}, p, { id: list.length + 1, created_at: new Date().toISOString(), created_by: state.user.id, trader_name: state.user.name, status: "pending" }));
      demoStore.writeList(LS_PROPOSALS, list);
      return Promise.resolve();
    },
    decideProposal: function (id, status) {
      var list = demoStore.readList(LS_PROPOSALS) || [];
      list.forEach(function (x) { if (x.id === id) { x.status = status; x.decided_at = new Date().toISOString(); x.decided_name = state.user.name; } });
      demoStore.writeList(LS_PROPOSALS, list);
      return Promise.resolve();
    },
    listLevels: function () { state.levelsOn = true; return Promise.resolve(demoStore.readList(LS_LEVELS) || {}); },
    saveLevel: function (code, target, stop) {
      var map = demoStore.readList(LS_LEVELS) || {};
      map[code] = { target: target, stop: stop };
      demoStore.writeList(LS_LEVELS, map);
      return Promise.resolve();
    },
    getReport: function (month) { var m = demoStore.readList(LS_REPORTS) || {}; return Promise.resolve({ month: month, comment: m[month] || "" }); },
    saveReport: function (month, comment) { var m = demoStore.readList(LS_REPORTS) || {}; m[month] = comment; demoStore.writeList(LS_REPORTS, m); return Promise.resolve(); },
    reset: function () { try { [LS_TRADES, LS_ORDERS, LS_PROPOSALS, LS_LEVELS, LS_REPORTS].forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { /* ignore */ } },
    // Fills the demo with a realistic starting portfolio at today's prices.
    seed: function () {
      var day = 86400000, now = Date.now();
      var list = [{ id: 1, created_at: new Date(now - 12 * day).toISOString(), type: "deposit", code: null, sleeve: null, quantity: null, price: null, brokerage: 0, cash_amount: CFG.STARTING_CAPITAL, note: "Notional starting capital", trader_name: "System" }];
      var plan = [
        [CFG.ETF_CODE, "index", 45000, 11, "Core index holding"],
        ["JBH", "competition", 15000, 9, "Competition winner: retail earnings momentum"],
        ["XRO", "competition", 15000, 9, "Competition runner-up: subscriber growth"],
        ["COH", "competition", 15000, 9, "Competition third place: implant demand"],
        ["NST", "active", 8000, 4, "Active sleeve: gold exposure"]
      ];
      plan.forEach(function (row) {
        var info = state.prices[row[0]];
        if (!info || !(info.price > 0)) return;
        var qty = Math.floor(row[2] / info.price);
        if (qty < 1) return;
        list.push({ id: list.length + 1, created_at: new Date(now - row[3] * day).toISOString(), type: "buy", code: info.code, sleeve: row[1], quantity: qty,
          price: round2(info.price * (1 - (info.change_pct || 0) / 100)), brokerage: 0, cash_amount: null, note: row[4], trader_name: state.user.name });
      });
      try { localStorage.setItem(LS_TRADES, JSON.stringify(list)); localStorage.removeItem(LS_ORDERS); } catch (e) { /* storage unavailable */ }
      // A sample analyst proposal and price levels, so the demo shows how they work.
      var px = function (c) { return state.prices[c] && state.prices[c].price > 0 ? state.prices[c].price : 0; };
      var pick = ["QAN", "WOW", "ALL", "GMG", "STO"].filter(function (c) { return px(c) > 0; })[0];
      demoStore.writeList(LS_PROPOSALS, pick ? [{ id: 1, created_at: new Date(now - 3600000).toISOString(), created_by: "sample", trader_name: "Priya Nair (sample analyst)", side: "buy", code: pick, sleeve: "active",
        quantity: Math.max(1, Math.floor(2000 / px(pick))), order_type: "market", limit_price: null, ref_price: px(pick), status: "pending",
        rationale: "Earnings upgrade last week and the shares have not caught up. I would start with a small position in the active sleeve and add if the next update confirms it." }] : []);
      var lv = {};
      ["JBH", "XRO", "COH", "NST"].forEach(function (c, i) { if (px(c) > 0) lv[c] = { target: round2(px(c) * (i === 3 ? 1.012 : 1.18)), stop: round2(px(c) * 0.88) }; });
      demoStore.writeList(LS_LEVELS, lv);
    }
  };

  var sb = null;
  var liveStore = {
    init: function () {
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      sb.auth.onAuthStateChange(function (event) {
        if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
          setTimeout(function () { liveStore.loadUser().then(refreshAll); }, 0);
        }
      });
      return liveStore.loadUser();
    },
    loadUser: function () {
      return sb.auth.getSession().then(function (res) {
        var session = res.data && res.data.session;
        if (!session) { state.user = null; return; }
        var u = session.user;
        return sb.from("profiles").select("*").eq("id", u.id).maybeSingle().then(function (r) {
          var p = r.data || {};
          state.user = { id: u.id, email: u.email, name: p.display_name || u.email, role: p.role || "viewer", avatar: p.avatar_url || null,
            // Only ask for the charter once the database has the column for it.
            needsCharter: Object.prototype.hasOwnProperty.call(p, "charter_agreed_at") && !p.charter_agreed_at };
        });
      });
    },
    // One row per trading day, saved by the database: the fund's value and the index ETF's price.
    listSnapshots: function () {
      return sb.from("fund_snapshots").select("day, fund_value, benchmark_price").order("day", { ascending: true }).then(function (r) {
        return r.error ? [] : r.data.map(function (d) { return { day: d.day, fund: Number(d.fund_value), price: Number(d.benchmark_price) }; });
      });
    },
    listTrades: function () {
      return sb.from("trades").select("*").order("id", { ascending: true }).then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data.map(function (t) {
          ["quantity", "price", "brokerage", "cash_amount"].forEach(function (k) { if (t[k] != null) t[k] = Number(t[k]); });
          return t;
        });
      });
    },
    addDividend: function (d) {
      return sb.from("trades").insert({ type: "dividend", code: d.code, cash_amount: d.cash_amount, note: d.note, trader_name: state.user.name })
        .then(function (r) { if (r.error) throw new Error(r.error.message); });
    },
    addTrade: function (t) {
      return sb.from("trades").insert(Object.assign({
        type: t.type, code: t.code, sleeve: t.sleeve, quantity: t.quantity, price: t.price, note: t.note || null, trader_name: t.trader_name || state.user.name
      }, t.approval ? { approval_code: t.approval } : {})).select().single().then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      });
    },
    listOrders: function () {
      return sb.from("orders").select("*").eq("status", "open").order("id", { ascending: true }).then(function (r) {
        if (r.error) { state.ordersOff = true; return []; }
        state.ordersOff = false;
        // When the database checks orders by itself, show when it last did.
        sb.from("order_checks").select("checked_at, ok, note").eq("id", 1).maybeSingle().then(function (c) {
          state.orderCheck = c && !c.error ? c.data : null;
          if (state.view === "trade") renderOpenOrders();
        }, function () { state.orderCheck = null; });
        var rows = r.data.map(function (o) { o.quantity = Number(o.quantity); o.limit_price = Number(o.limit_price); o.placed_low = Number(o.placed_low) || 0; o.placed_high = Number(o.placed_high) || 0; o.kind = o.kind || "limit"; return o; });
        // Market orders can only wait for the open once the database has been given the column for it.
        return sb.from("orders").select("kind").limit(1).then(function (k) { state.queueOff = !!k.error; return rows; }, function () { state.queueOff = true; return rows; });
      });
    },
    listProposals: function () {
      return sb.from("proposals").select("*").order("id", { ascending: false }).limit(40).then(function (r) {
        if (r.error) { state.proposalsOn = false; return []; }
        state.proposalsOn = true;
        return r.data.map(function (x) { x.quantity = Number(x.quantity); x.limit_price = x.limit_price == null ? null : Number(x.limit_price); x.ref_price = Number(x.ref_price) || 0; return x; }).reverse();
      });
    },
    addProposal: function (x) {
      return sb.from("proposals").insert({ side: x.side, code: x.code, sleeve: x.sleeve, quantity: x.quantity, order_type: x.order_type, limit_price: x.limit_price, ref_price: x.ref_price, rationale: x.rationale, trader_name: state.user.name })
        .then(function (r) { if (r.error) throw new Error(r.error.message); });
    },
    decideProposal: function (id, status) {
      return sb.rpc("decide_proposal", { p_id: id, p_status: status, p_name: state.user.name }).then(function (r) { if (r.error) throw new Error(r.error.message); });
    },
    listLevels: function () {
      return sb.from("position_levels").select("code, target, stop").then(function (r) {
        if (r.error) { state.levelsOn = false; return {}; }
        state.levelsOn = true;
        var map = {};
        r.data.forEach(function (d) { map[d.code] = { target: Number(d.target) || 0, stop: Number(d.stop) || 0 }; });
        return map;
      });
    },
    saveLevel: function (code, target, stop) {
      return sb.from("position_levels").upsert({ code: code, target: target || null, stop: stop || null, updated_name: state.user.name }).then(function (r) { if (r.error) throw new Error(r.error.message); });
    },
    getReport: function (month) {
      return sb.from("fund_reports").select("comment").eq("month", month).maybeSingle().then(function (r) {
        return { month: month, comment: r.error || !r.data ? "" : r.data.comment || "", off: !!r.error };
      });
    },
    saveReport: function (month, comment) {
      return sb.from("fund_reports").upsert({ month: month, comment: comment, updated_name: state.user.name }).then(function (r) {
        if (r.error) throw new Error(/fund_reports|schema cache|not find/i.test(r.error.message) ? "Saving the comment needs the latest database update to be run in Supabase first." : r.error.message);
      });
    },
    placeOrder: function (o) {
      var row = Object.assign({
        side: o.side, code: o.code, sleeve: o.sleeve, quantity: o.quantity, limit_price: o.limit_price, trader_name: o.trader_name || state.user.name
      }, o.approval ? { approval_code: o.approval } : {}, o.kind === "market" ? { kind: "market" } : {}, o.note && !state.queueOff ? { note: o.note } : {});
      var range = o.placed_low > 0 && o.placed_high > 0 ? { placed_low: o.placed_low, placed_high: o.placed_high } : null;
      var insert = function (extra) { return sb.from("orders").insert(Object.assign({}, row, extra || {})); };
      return insert(range).then(function (r) {
        // A database that has not had the day-range columns added yet still takes the order.
        if (r.error && range && /placed_(low|high)/.test(r.error.message || "")) return insert(null);
        return r;
      }).then(function (r) { if (r.error) throw new Error(r.error.message); });
    },
    cancelOrder: function (id) {
      return sb.rpc("cancel_order", { p_id: id }).then(function (r) { if (r.error) throw new Error(r.error.message); });
    },
    fillOrder: function (id, price) {
      return sb.rpc("fill_order", { p_id: id, p_price: price }).then(function (r) { if (r.error) throw new Error(r.error.message); });
    },
    removeMember: function (id) {
      return sb.rpc("remove_member", { p_id: id }).then(function (r) {
        if (r.error) throw new Error(/remove_member|schema cache|not find/i.test(r.error.message) ? "Removing accounts needs the latest database update to be run in Supabase first." : r.error.message);
      });
    },
    signIn: function (email, password) {
      return sb.auth.signInWithPassword({ email: email, password: password }).then(function (r) { if (r.error) throw new Error(r.error.message); });
    },
    signUp: function (email, password, name) {
      return sb.auth.signUp({ email: email, password: password, options: { data: { display_name: name, charter_agreed: "true", charter_version: CFG.CHARTER_VERSION }, emailRedirectTo: window.location.origin + window.location.pathname } }).then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      });
    },
    signOut: function () { return sb.auth.signOut(); },
    listMembers: function () {
      return sb.from("profiles").select("*").order("created_at", { ascending: true }).then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      });
    },
    // Updates a profile row and fails loudly if the database refused or ignored the change.
    patchProfile: function (id, patch) {
      return sb.from("profiles").update(patch).eq("id", id).select("id").then(function (r) {
        if (r.error) throw new Error(/avatar_url/.test(r.error.message) ? "Profile photos need the latest database update to be run in Supabase first." : r.error.message);
        if (!r.data || !r.data.length) throw new Error("The database did not accept the change. The latest database update may not have been run in Supabase yet.");
      });
    },
    setRole: function (id, role) { return liveStore.patchProfile(id, { role: role }); },
    agreeCharter: function () { return liveStore.patchProfile(state.user.id, { charter_agreed_at: new Date().toISOString(), charter_version: CFG.CHARTER_VERSION }); },
    setTitle: function (id, title) {
      return liveStore.patchProfile(id, { title: title || null }).catch(function (e) {
        throw new Error(/title/.test(e.message) ? "Job titles need the latest database update to be run in Supabase first." : e.message);
      });
    },
    // The fund manager's current approval code. Only an admin account is given it.
    getTradeCode: function () {
      return sb.rpc("get_trade_code").then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return { code: r.data.code, expires: new Date(r.data.expires_at).getTime() };
      });
    },
    updateName: function (name) {
      return liveStore.patchProfile(state.user.id, { display_name: name }).then(function () {
        return sb.auth.updateUser({ data: { display_name: name } });
      });
    },
    updateAvatar: function (dataUrl) { return liveStore.patchProfile(state.user.id, { avatar_url: dataUrl }); },
    // Resolves true if the email changed straight away, false if a confirmation link was sent.
    updateEmail: function (email) {
      return sb.auth.updateUser({ email: email }, { emailRedirectTo: window.location.origin + window.location.pathname }).then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return !!(r.data && r.data.user && r.data.user.email === email);
      });
    },
    updatePassword: function (password) {
      return sb.auth.updateUser({ password: password }).then(function (r) { if (r.error) throw new Error(r.error.message); });
    }
  };

  var store = DEMO ? demoStore : liveStore;

  // ---------- portfolio maths ----------
  function computePortfolio(trades) {
    var cash = 0, positions = {};
    trades.forEach(function (t) {
      var value = (t.quantity || 0) * (t.price || 0);
      if (t.type === "deposit" || t.type === "dividend") {
        cash += t.cash_amount || 0;
      } else if (t.type === "buy") {
        cash -= value + (t.brokerage || 0);
        var p = positions[t.code] || (positions[t.code] = { code: t.code, qty: 0, cost: 0, sleeve: t.sleeve });
        p.qty += t.quantity;
        p.cost += value + (t.brokerage || 0);
        p.sleeve = t.sleeve || p.sleeve;
      } else if (t.type === "sell") {
        cash += value - (t.brokerage || 0);
        var s = positions[t.code];
        if (s && s.qty > 0) {
          var avg = s.cost / s.qty;
          s.qty -= t.quantity;
          s.cost -= avg * t.quantity;
          if (s.qty < 1e-9) { s.qty = 0; s.cost = 0; }
        }
      }
    });

    var list = Object.keys(positions).map(function (k) { return positions[k]; }).filter(function (p) { return p.qty > 0; });
    var holdingsValue = 0;
    list.forEach(function (p) {
      var info = state.prices[p.code];
      p.name = info ? info.name : "";
      p.sector = info ? info.sector : "";
      p.price = info ? info.price : 0;
      p.priced = !!(info && info.price > 0);
      p.value = p.qty * p.price;
      p.gain = p.value - p.cost;
      p.gainPct = p.cost > 0 ? p.gain / p.cost : 0;
      holdingsValue += p.value;
    });
    var total = cash + holdingsValue;
    list.forEach(function (p) { p.weight = total > 0 ? p.value / total : 0; });
    list.sort(function (a, b) { return b.value - a.value; });

    var etf = list.filter(function (p) { return p.code === CFG.ETF_CODE; })[0];
    var etfValue = etf ? etf.value : 0;
    var activeValue = list.filter(function (p) { return p.sleeve === "active"; }).reduce(function (a, p) { return a + p.value; }, 0);
    var competitionValue = list.filter(function (p) { return p.sleeve === "competition"; }).reduce(function (a, p) { return a + p.value; }, 0);
    var stocks = list.filter(function (p) { return p.code !== CFG.ETF_CODE; });
    var maxWeight = stocks.reduce(function (m, p) { return Math.max(m, p.weight); }, 0);
    var sectors = {};
    stocks.filter(function (p) { return p.sleeve === "competition"; }).forEach(function (p) { sectors[p.sector || "Unknown"] = true; });

    return {
      cash: cash, holdingsValue: holdingsValue, total: total, positions: list,
      etfValue: etfValue, activeValue: activeValue, competitionValue: competitionValue, maxWeight: maxWeight,
      competitionCount: stocks.filter(function (p) { return p.sleeve === "competition"; }).length,
      competitionSectors: Object.keys(sectors).length,
      ret: CFG.STARTING_CAPITAL > 0 ? total / CFG.STARTING_CAPITAL - 1 : 0,
      unpriced: list.filter(function (p) { return !p.priced; }).map(function (p) { return p.code; })
    };
  }

  // Works out the size and price of the order being typed.
  // pending = a limit order that has to wait for the price to reach the limit.
  function orderNumbers(order, info) {
    var limit = order.type === "limit" ? Number(order.limit) : 0;
    var isLimit = order.type === "limit";
    var q = quote(info, order.side);
    var marketable = isLimit && limit > 0 && (order.side === "buy" ? limit >= q : limit <= q);
    // Orders fill straight away only while the market is trading. A database that cannot hold
    // market orders yet fills them at once, as before.
    var live = fillsNow(info) || (!isLimit && (state.ordersOff || state.queueOff));
    var pending = isLimit && (!marketable || !live);
    var queued = !isLimit && !live;
    var price = pending ? limit : q;
    var qty = order.qtyMode === "amount" ? (price > 0 ? Math.floor(Number(order.amount) / price) : 0) : Number(order.qty);
    return { qty: qty || 0, price: price, limit: limit, isLimit: isLimit, pending: pending, queued: queued, waits: pending || queued, marketable: marketable, value: (qty || 0) * price };
  }

  // Checks an order against the fund's mandate. Returns a list of plain-language problems.
  function validateOrder(order, pf) {
    var issues = [];
    var info = state.prices[order.code];
    if (!info) { issues.push("Choose a stock from the list."); return issues; }
    if (!(info.price > 0)) { issues.push("No price is available for " + info.code + " right now."); return issues; }
    var n = orderNumbers(order, info);
    if (n.isLimit && !(n.limit > 0)) { issues.push("Enter a limit price."); return issues; }
    var qty = n.qty;
    if (order.qtyMode === "amount") {
      if (!(Number(order.amount) > 0)) { issues.push("Enter a dollar amount."); return issues; }
      if (qty < 1) { issues.push("That amount does not cover one share at " + fmtMoney(n.price) + "."); return issues; }
    } else if (!(qty > 0) || Math.floor(qty) !== qty) { issues.push("Enter a whole number of shares."); return issues; }

    var isEtf = info.code === CFG.ETF_CODE;
    var value = n.value;
    var brokerage = brokerageFor(value);
    var held = pf.positions.filter(function (p) { return p.code === info.code; })[0];
    var heldQty = held ? held.qty : 0;
    var heldValue = held ? held.value : 0;

    if (order.side === "buy") {
      if (isExcluded(info)) issues.push(info.code + " is outside the mandate: " + info.excluded + ".");
      if (value + brokerage > pf.cash + 0.005) issues.push("Not enough cash. This order costs " + fmtMoney(value + brokerage) + " and the fund has " + fmtMoney(pf.cash) + ". Sell some of the index ETF first.");
      if (!isEtf) {
        if (CFG.MIN_ETF_VALUE > 0 && pf.etfValue < CFG.MIN_ETF_VALUE) issues.push("The index ETF holding is below the " + fmtMoney(CFG.MIN_ETF_VALUE) + " floor. Buy " + CFG.ETF_CODE + " first.");
        var totalAfter = pf.total - brokerage;
        var weightAfter = totalAfter > 0 ? (heldValue + value) / totalAfter : 1;
        if (weightAfter > CFG.MAX_STOCK_WEIGHT + 1e-9) issues.push("This would take " + info.code + " to " + fmtPct(weightAfter) + " of the fund. You cannot buy a stock above " + fmtPct(CFG.MAX_STOCK_WEIGHT, 0) + ".");
        if (order.sleeve === "active" && pf.activeValue + value > CFG.ACTIVE_SLEEVE_CAP + 0.005) issues.push("This would take the active sleeve to " + fmtMoney(pf.activeValue + value) + ". The cap is " + fmtMoney(CFG.ACTIVE_SLEEVE_CAP) + ".");
      }
    } else {
      if (qty > heldQty) issues.push("The fund holds " + fmtQty(heldQty) + " " + info.code + ". You cannot sell more than that.");
      else if (CFG.MIN_ETF_VALUE > 0 && isEtf && pf.etfValue - value < CFG.MIN_ETF_VALUE - 0.005) issues.push("This would leave " + fmtMoney(pf.etfValue - value) + " in the index ETF. The floor is " + fmtMoney(CFG.MIN_ETF_VALUE) + ".");
    }
    if (n.pending && state.ordersOff) issues.push("Limit orders need the latest database update to be run in Supabase first.");
    return issues;
  }

  // ---------- rendering ----------
  var ICON = {
    ext: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 5.5 10.5M11 9.5V13H3V5h3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.500M3 13.500h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ok: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.500 8.500 3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bad: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4v5M8 11.800v.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    dash: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.500 8h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?").charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
  }
  function safeAvatar(url) { return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(url || "") ? url : ""; }
  function avatarHtml(person, cls) {
    var url = safeAvatar(person && person.avatar);
    return '<span class="avatar ' + (cls || "") + '">' + (url ? '<img src="' + url + '" alt="">' : esc(initials(person && person.name))) + "</span>";
  }
  function infoUrl(code) { return CFG.COMPANY_INFO_URL.replace("{code}", encodeURIComponent(String(code).toLowerCase())); }
  function bookUrl(code) { return "https://www.tmxaustralia.com/market-data/book-viewer?symbol=" + encodeURIComponent(code); }
  function isExcluded(info) { return CFG.ENFORCE_EXCLUSIONS && !!info.excluded && info.code !== CFG.ETF_CODE; }
  function fmtCap(n) {
    if (!(n > 0)) return "";
    return n >= 1e9 ? "$" + (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "b" : "$" + Math.round(n / 1e6) + "m";
  }
  function fmtChange(n) { return (n > 0 ? "+" : "") + n.toFixed(2) + "%"; }

  // The ASX trades 10am to 4pm Sydney time on weekdays (public holidays are not checked).
  function marketOpen() {
    var parts = {};
    new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    var mins = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
    return ["Sat", "Sun"].indexOf(parts.weekday) < 0 && mins >= 600 && mins < 960;
  }

  // ---------- charter agreement ----------
  // The full charter in a scroll box. The tick box unlocks once it has been scrolled to the end.
  function charterBox(checkId, label) {
    return '<div class="charter-scroll" tabindex="0" data-charter-for="' + checkId + '">' + window.LIGHTHOUSE_CHARTER_HTML + "</div>" +
      '<p class="charter-hint muted small" data-hint-for="' + checkId + '">Scroll to the end of the charter to agree.</p>' +
      '<label class="check-row"><input type="checkbox" id="' + checkId + '" disabled><span>' + label + "</span></label>";
  }
  function unlockCharter(box) {
    if (box.scrollHeight - box.scrollTop - box.clientHeight > 24) return;
    var check = document.getElementById(box.dataset.charterFor);
    if (check && check.disabled) {
      check.disabled = false;
      var hint = document.querySelector('[data-hint-for="' + box.dataset.charterFor + '"]');
      if (hint) hint.hidden = true;
    }
  }
  document.addEventListener("scroll", function (e) {
    if (e.target && e.target.dataset && e.target.dataset.charterFor) unlockCharter(e.target);
  }, true);

  function renderCharterGate() {
    var need = !DEMO && state.user && state.user.needsCharter;
    var el = $("#charter-modal");
    if (!need) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement("div");
    el.className = "modal";
    el.id = "charter-modal";
    el.innerHTML = '<div class="modal-box wide" role="dialog" aria-modal="true" aria-labelledby="charter-title">' +
      '<h2 id="charter-title">Agree to the fund charter</h2><p class="muted small">Every member signs this once before using the fund.</p>' +
      charterBox("charter-check", "I, " + esc(state.user.name) + ", have read and agree to the Lighthouse Fund Charter.") +
      '<div class="modal-actions"><button type="button" class="btn secondary" data-action="signout">Sign out</button><button type="button" class="btn" data-action="agree-charter" disabled>Agree and continue</button></div></div>';
    document.body.appendChild(el);
  }

  // ---------- trade approval code ----------
  // Analysts need the fund manager's current code to place a trade. Fund managers trade without one.
  function needsCode() { return !DEMO && canTrade() && !isAdmin() && !state.proposalsOn; }
  // The database's six-digit code is shown and typed as three words. Each pair of digits picks one word.
  var CODE_WORDS = "amber anchor arrow aspen atlas aurora autumn badger banner basalt beacon birch bishop bridge bronze canyon cedar cinder cobalt comet copper coral cove crane crimson delta dune eagle ember falcon fathom fern flint forest fox frost garnet glacier granite grove harbour hawk hazel heron horizon indigo iron island ivory jade jasper juniper keel kestrel lagoon lantern lark linen lotus lunar maple marble meadow mercury mist navy north oak ocean olive onyx opal orbit otter pearl pepper pilot pine quartz raven reef river saffron sage silver slate spruce storm summit tide timber topaz tundra velvet violet walnut willow winter yarrow zephyr".split(" ");
  function phraseFor(code) {
    return /^\d{6}$/.test(code || "") ? [0, 2, 4].map(function (i) { return CODE_WORDS[Number(code.substr(i, 2))]; }) : [];
  }
  // Turns what an analyst typed back into the six digits. The digits themselves still work.
  function codeFromPhrase(text) {
    var raw = String(text || "").trim().toLowerCase();
    if (/^\d{6}$/.test(raw.replace(/\s/g, ""))) return raw.replace(/\s/g, "");
    var parts = raw.split(/[^a-z]+/).filter(Boolean);
    if (parts.length !== 3) return "";
    var out = "";
    for (var i = 0; i < 3; i++) { var n = CODE_WORDS.indexOf(parts[i]); if (n < 0) return ""; out += ("0" + n).slice(-2); }
    return out;
  }
  var codeState = { code: null, expires: 0, error: null, loading: false, tried: 0 };

  function codeCardHtml() {
    if (!isAdmin()) return "";
    if (state.proposalsOn) {
      var w = pendingProposals().length;
      return '<div class="card code-card"><div class="eyebrow light">Trade proposals</div><div class="code-digits">' + w + '<span class="code-unit">' + (w === 1 ? " waiting" : " waiting") + "</span></div>" +
        '<p class="code-note">' + (w ? "Analysts have sent trades for you to approve or reject." : "Analysts send their trades to you with a short case. Nothing is placed until you approve it.") + "</p>" +
        (w ? '<button type="button" class="btn ghost small-btn" data-view="trade" style="margin-top:12px">Review now</button>' : "") + "</div>";
    }
    return '<div class="card code-card" id="code-card">' + codeCardInner() + "</div>";
  }
  function codeCardInner() {
    var head = '<div class="eyebrow light">Trade codephrase</div>';
    if (codeState.error) return head + '<p class="code-note">' + esc(codeState.error) + "</p>";
    if (!codeState.code) return head + '<div class="code-digits">· · ·</div><p class="code-note">Loading…</p>';
    var left = Math.max(0, Math.ceil((codeState.expires - Date.now()) / 1000));
    return head +
      '<div class="code-digits phrase" aria-label="Codephrase ' + phraseFor(codeState.code).join(" ") + '">' + phraseFor(codeState.code).map(function (w) { return "<span>" + w + "</span>"; }).join("") + "</div>" +
      '<div class="code-bar"><span style="width:' + Math.min(100, left / 3) + '%"></span></div>' +
      '<div class="code-foot"><span>New phrase in ' + Math.floor(left / 60) + ":" + ("0" + (left % 60)).slice(-2) + '</span><button type="button" class="link" data-action="copy-code">Copy</button></div>' +
      '<p class="code-note">Only you can see this. Give the three words to an analyst to approve their trade.</p>';
  }
  function tickCode() {
    var el = $("#code-card");
    if (!el || !isAdmin() || !store.getTradeCode) return;
    var now = Date.now();
    if ((!codeState.code || now >= codeState.expires) && !codeState.loading && now - codeState.tried > 5000) {
      codeState.loading = true;
      codeState.tried = now;
      store.getTradeCode().then(function (c) {
        codeState.code = c.code; codeState.expires = c.expires; codeState.error = null; codeState.loading = false; tickCode();
      }).catch(function (e) {
        codeState.loading = false;
        codeState.code = null;
        codeState.error = /get_trade_code|schema cache|not find/i.test(e.message) ? "Run the latest database update in Supabase to switch on approval codes." : "Could not load the code: " + e.message;
        tickCode();
      });
    }
    if (now >= codeState.expires && codeState.code) { codeState.code = null; }
    el.innerHTML = codeCardInner();
  }
  setInterval(tickCode, 1000);

  var NAV_ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    portfolio: '<path d="M21 12a9 9 0 1 1-9-9"/><path d="M12 3v9h9a9 9 0 0 0-9-9z"/>',
    trade: '<path d="M4 8h14"/><path d="M14 4l4 4-4 4"/><path d="M20 16H6"/><path d="M10 12l-4 4 4 4"/>',
    companies: '<rect x="4" y="3" width="10" height="18" rx="1"/><path d="M14 9h6v12h-6"/><path d="M8 7h2M8 11h2M8 15h2"/>',
    history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    report: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
    members: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.5a6 6 0 0 1 3.5 5.5"/>'
  };
  // Slides the highlight from the tab you were on to the one you picked.
  function placeNavInd(from) {
    var nav = $("#nav"), ind = nav.querySelector(".nav-ind"), cur = nav.querySelector('[aria-current="page"]');
    if (!ind) return;
    if (!cur || !cur.offsetWidth) { ind.style.opacity = "0"; ind.style.width = ""; return; }
    var to = { x: "translateX(" + cur.offsetLeft + "px)", w: cur.offsetWidth + "px" };
    if (from && (from.x !== to.x || from.w !== to.w)) {
      ind.style.transition = "none"; ind.style.transform = from.x; ind.style.width = from.w;
      void ind.offsetWidth;
      ind.style.transition = "";
    }
    ind.style.opacity = "1"; ind.style.transform = to.x; ind.style.width = to.w;
    if (nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2);
  }
  window.addEventListener("resize", function () { placeNavInd(null); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { placeNavInd(null); });

  function renderChrome() {
    document.body.classList.toggle("auth-page", state.view === "signin");

    var tabs = locked() ? [["home", "Home"], ["companies", "Companies"]] : [["home", "Home"], ["portfolio", "Portfolio"], ["trade", "Trade"], ["companies", "Companies"], ["history", "History"], ["report", "Report"]];
    if (isAdmin() && !DEMO) tabs.push(["members", "Members"]);
    var waiting = isAdmin() && state.proposalsOn && state.view !== "trade" ? pendingProposals().length : 0;
    var unseen = isAdmin() && state.view !== "members" ? unseenMembers().length : 0;
    var navEl = $("#nav");
    var oldInd = navEl.querySelector(".nav-ind");
    var from = oldInd && oldInd.style.width ? { x: oldInd.style.transform, w: oldInd.style.width } : null;
    navEl.innerHTML = '<span class="nav-ind" aria-hidden="true"></span>' + tabs.map(function (t) {
      return '<button type="button" data-view="' + t[0] + '"' + (state.view === t[0] ? ' aria-current="page"' : "") + ">" +
        '<svg class="nav-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (NAV_ICONS[t[0]] || "") + "</svg><span>" + t[1] + "</span>" +
        (t[0] === "members" && unseen ? '<span class="count" title="New members">' + unseen + "</span>" : "") +
        (t[0] === "trade" && waiting ? '<span class="count" title="Proposals waiting for you">' + waiting + "</span>" : "") + "</button>";
    }).join("");
    placeNavInd(from);

    var acc;
    if (state.user) {
      acc = '<button type="button" class="me" data-view="profile" title="Your profile">' + avatarHtml(state.user) +
        '<span class="me-text"><span class="me-name">' + esc(state.user.name) + '</span><span class="me-role">' + esc(roleLabel(state.user.role)) + "</span></span></button>";
      if (!DEMO) acc += '<button type="button" class="btn quiet" data-action="signout">Sign out</button>';
    } else {
      acc = '<button type="button" class="btn" data-view="signin">Sign in</button>';
    }
    $("#account").innerHTML = acc;

    var pf = computePortfolio(state.trades);
    var open = marketOpen();
    $("#strip").innerHTML =
      '<span class="strip-item"><i class="dot ' + (open ? "on" : "") + '"></i>ASX ' + (open ? "open" : "closed") + "</span>" +
      '<span class="strip-item hide-sm">' + pricesStamp() + "</span>" +
      '<span class="strip-gap"></span>' + (locked() ? '<span class="strip-item">Sign in to see the fund</span>' :
      '<span class="strip-item"><b>Fund</b> ' + fmtMoney(pf.total) + "</span>" +
      '<span class="strip-item"><b>Return</b> <span class="' + signClass(pf.ret) + '">' + (pf.ret > 0 ? "+" : "") + fmtPct(pf.ret, 2) + "</span></span>" +
      '<span class="strip-item hide-sm"><b>Cash</b> ' + fmtMoney(pf.cash) + "</span>");

    var notes = [];
    var demoNote = DEMO ? '<div class="banner demo"><div class="wrap"><span><b>Demo mode.</b> Trade as much as you like. Everything here stays in this browser and the real fund is not touched.</span>' +
      '<span class="banner-actions"><button type="button" class="link" data-action="seed-demo">Load sample portfolio</button><button type="button" class="link" data-action="reset-demo">Start again</button>' +
      (NO_DATABASE ? "" : '<button type="button" class="btn small-btn" data-action="exit-demo">Exit demo</button>') + "</span></div></div>" : "";
    if (state.pricesAreSample) notes.push("Showing sample prices, not real market prices.");
    if (state.priceError) notes.push("Price feed problem: " + state.priceError + ".");
    var demoLink = $("#demo-link");
    if (demoLink) demoLink.hidden = DEMO;
    $("#banner").innerHTML = demoNote + (notes.length ? '<div class="banner"><div class="wrap">' + esc(notes.join(" ")) + "</div></div>" : "");
  }

  function roleLabel(r) { return { viewer: "Viewer", trader: "Analyst", admin: "Fund Manager" }[r] || r; }

  function pricesStamp() {
    if (state.pricesAreSample) return "Sample prices";
    return state.pricesUpdated ? "Prices as at " + esc(state.pricesUpdated) + ", delayed" : "Prices delayed";
  }

  function donut(parts, total) {
    var acc = 0;
    var rings = parts.filter(function (p) { return p[1] > 0; }).map(function (p) {
      var share = p[1] / total * 100;
      var el = '<circle cx="21" cy="21" r="15.915" fill="none" stroke="' + p[2] + '" stroke-width="5" stroke-dasharray="' + share.toFixed(3) + " " + (100 - share).toFixed(3) + '" stroke-dashoffset="' + (25 - acc).toFixed(3) + '"/>';
      acc += share;
      return el;
    }).join("");
    return '<svg class="donut" viewBox="0 0 42 42" role="img" aria-label="Allocation of the fund"><circle cx="21" cy="21" r="15.915" fill="none" stroke="#3d4451" stroke-width="5"/>' + rings + "</svg>";
  }

  function renderPortfolio() {
    var pf = computePortfolio(state.trades);
    var parts = [
      ["Index ETF", pf.etfValue, "#ffffff"],
      ["Competition stocks", pf.competitionValue, "#e5354f"],
      ["Active sleeve", pf.activeValue, "#f5a9b5"],
      ["Cash", Math.max(pf.cash, 0), "#6f7683"]
    ];
    var totalForBar = parts.reduce(function (a, p) { return a + p[1]; }, 0) || 1;
    var gain = pf.total - CFG.STARTING_CAPITAL;
    var biggest = pf.positions[0];

    var perf = performancePoints(pf);
    var rows = pf.positions.map(function (p) {
      var over = false; // the limit applies to buying, so a holding that has grown past it is fine
      return "<tr>" +
        '<td><span class="co">' + monoHtml(p.code, true) + '<span><a class="code" href="' + infoUrl(p.code) + '" target="_blank" rel="noopener noreferrer">' + esc(p.code) + '</a> <span class="pill sleeve">' + esc(sleeveLabel(p.sleeve)) + '</span><div class="muted small">' + esc(p.name) + "</div></span></span></td>" + levelCell(p) +
        '<td class="num">' + fmtQty(p.qty) + "</td>" +
        '<td class="num">' + (p.priced ? fmtMoney(p.price) : "No price") + "</td>" +
        '<td class="num">' + fmtMoney(p.value) + "</td>" +
        '<td class="num ' + signClass(p.gain) + '">' + fmtMoney(p.gain) + '<div class="small">' + fmtPct(p.gainPct) + "</div></td>" +
        '<td class="num">' + fmtPct(p.weight) + '<span class="wbar"><span style="width:' + Math.min(100, p.weight * 100).toFixed(1) + '%"></span></span></td>' +
        "</tr>";
    }).join("");

    var invested = pf.holdingsValue > 0;
    var checkList = [];
    if (CFG.MIN_ETF_VALUE > 0) checkList.push(["Index ETF at least " + fmtMoney(CFG.MIN_ETF_VALUE), invested ? pf.etfValue >= CFG.MIN_ETF_VALUE : null, fmtMoney(pf.etfValue)]);
    checkList.push(["No buying a stock above " + fmtPct(CFG.MAX_STOCK_WEIGHT, 0), invested ? true : null, "Largest is " + fmtPct(pf.maxWeight) + (pf.maxWeight > CFG.MAX_STOCK_WEIGHT ? " after price rises" : "")]);
    checkList.push(["Active sleeve within " + fmtMoney(CFG.ACTIVE_SLEEVE_CAP, 0), invested ? pf.activeValue <= CFG.ACTIVE_SLEEVE_CAP : null, fmtMoney(pf.activeValue) + " used"]);
    var flagged = pf.positions.filter(function (p) { var f = levelFlag(p); return f && f.cls === "bad"; }).map(function (p) { return p.code; });
    if (Object.keys(state.levels).some(function (c) { return state.levels[c].stop > 0 && pf.positions.some(function (p) { return p.code === c; }); }))
      checkList.push(["Holdings above their review price", !flagged.length, flagged.length ? flagged.join(", ") + " needs a review" : "None has fallen to its review price"]);
    checkList.push(["Competition stocks in different sectors", pf.competitionCount > 0 ? pf.competitionSectors === pf.competitionCount : null, pf.competitionSectors + (pf.competitionSectors === 1 ? " sector across " : " sectors across ") + pf.competitionCount + (pf.competitionCount === 1 ? " stock" : " stocks")]);
    var checks = checkList.map(function (c) {
      var kind = c[1] === null ? "none" : c[1] ? "ok" : "bad";
      var word = c[1] === null ? "Nothing held yet" : c[1] ? "Within the limit" : "Breach";
      return '<li class="check ' + kind + '"><span class="check-icon">' + (kind === "ok" ? ICON.ok : kind === "bad" ? ICON.bad : ICON.dash) + "</span>" +
        '<span class="check-text"><span class="check-title">' + esc(c[0]) + '</span><span class="muted small">' + esc(c[1] === null ? word : c[2]) + "</span></span>" +
        (kind === "bad" ? '<span class="pill bad">' + (/review/.test(c[0]) ? "Review" : "Breach") + "</span>" : "") + "</li>";
    }).join("");

    var recent = state.trades.filter(function (t) { return t.type === "buy" || t.type === "sell"; }).slice(-5).reverse().map(function (t) {
      return '<li><span class="pill ' + t.type + '">' + (t.type === "buy" ? "Buy" : "Sell") + "</span>" +
        '<span class="recent-main"><b>' + fmtQty(t.quantity) + " " + esc(t.code) + "</b> at " + fmtMoney(t.price) +
        '<span class="muted small">' + esc(t.trader_name || "") + ", " + esc(fmtDate(t.created_at)) + "</span></span></li>";
    }).join("");

    $("#main").innerHTML =
      '<section class="hero">' +
        '<div class="hero-main">' +
          '<div class="eyebrow">Fund value</div>' +
          '<div class="hero-value" data-count="' + pf.total + '">' + fmtMoney(pf.total) + "</div>" +
          '<div class="hero-sub"><span class="delta ' + (signClass(pf.ret) || "flat") + '">' + (pf.ret > 0 ? "+" : "") + fmtPct(pf.ret, 2) + "</span>" +
            "<span>" + (gain >= 0 ? "+" : "") + fmtMoney(gain) + " since inception</span></div>" +
          '<div class="hero-foot">Started with ' + fmtMoney(CFG.STARTING_CAPITAL) + ". " + pricesStamp() + ".</div>" +
        "</div>" +
        '<div class="hero-alloc">' + donut(parts, totalForBar) +
          '<ul class="legend">' + parts.map(function (p) {
            return '<li><i style="background:' + p[2] + '"></i><span>' + esc(p[0]) + "</span><b>" + fmtPct(p[1] / totalForBar) + "</b></li>";
          }).join("") + "</ul>" +
        "</div>" +
      "</section>" +
      '<div class="cards">' +
        statCard("Invested", fmtMoney(pf.holdingsValue), fmtPct(pf.total > 0 ? pf.holdingsValue / pf.total : 0) + " of the fund") +
        statCard("Cash", fmtMoney(pf.cash), fmtPct(pf.total > 0 ? pf.cash / pf.total : 0) + " of the fund") +
        statCard("Holdings", String(pf.positions.length), pf.positions.length === 1 ? "1 position" : pf.positions.length + " positions") +
        statCard("Largest position", biggest ? esc(biggest.code) : "None", biggest ? fmtPct(biggest.weight) + " of the fund" : "All in cash") +
      "</div>" +
      (pf.unpriced.length ? '<p class="notice">No price is available for ' + esc(pf.unpriced.join(", ")) + ", so the fund value is understated.</p>" : "") +
      '<div class="grid-2">' +
        '<div class="stack"><div class="card flush"><div class="card-head"><h2>Holdings</h2>' + (canTrade() ? '<button type="button" class="btn small-btn" data-view="trade">New trade</button>' : "") + "</div>" +
          '<div class="table-scroll"><table><thead><tr><th>Stock</th>' + (state.levelsOn ? '<th class="num">Target / review</th>' : "") + '<th class="num">Quantity</th><th class="num">Price</th><th class="num">Value</th><th class="num">Gain or loss</th><th class="num">Weight</th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="8" class="empty">The fund holds no shares yet. It is all in cash.</td></tr>') +
        "</tbody></table></div></div>" + performanceCardHtml(perf) + attributionCardHtml() + sectorCardHtml(pf) + "</div>" +
        '<div class="stack">' + codeCardHtml() +
          '<div class="card"><h2>Mandate checks</h2><ul class="checks">' + checks + "</ul></div>" + riskCardHtml(perf) +
          '<div class="card"><h2>Latest trades</h2>' + (recent ? '<ul class="recent">' + recent + "</ul>" : '<p class="muted small" style="margin:0">No trades yet.</p>') + "</div>" +
        "</div>" +
      "</div>";
    drawPerformance(perf);
  }

  // ---------- price targets and review levels ----------
  function levelFlag(p) {
    var lv = state.levels[p.code];
    if (!lv || !p.priced) return null;
    if (lv.stop > 0 && p.price <= lv.stop) return { cls: "bad", text: "Review" };
    if (lv.target > 0 && p.price >= lv.target) return { cls: "ok", text: "Target reached" };
    return null;
  }
  function levelCell(p) {
    if (!state.levelsOn) return "";
    var lv = state.levels[p.code] || {}, f = levelFlag(p), set = lv.target > 0 || lv.stop > 0;
    return '<td class="num lvl">' + (set ? '<span class="nowrap">' + (lv.target > 0 ? fmtMoney(lv.target) : "None") + " / " + (lv.stop > 0 ? fmtMoney(lv.stop) : "None") + "</span>" : '<span class="muted">Not set</span>') +
      (f ? '<div><span class="pill ' + f.cls + '">' + f.text + "</span></div>" : "") +
      (canTrade() ? '<div><button type="button" class="link small" data-levels="' + esc(p.code) + '">' + (set ? "Change" : "Set") + "</button></div>" : "") + "</td>";
  }
  function closeLevels() { var el = $("#levels-modal"); if (el) el.remove(); }
  function openLevels(code) {
    closeLevels();
    var info = state.prices[code], lv = state.levels[code] || {};
    var el = document.createElement("div");
    el.className = "modal";
    el.id = "levels-modal";
    el.dataset.code = code;
    el.innerHTML =
      '<div class="modal-box wide" role="dialog" aria-modal="true" aria-labelledby="lvl-title">' +
        '<h2 id="lvl-title">Target and review price for ' + esc(code) + "</h2>" +
        '<p class="muted small">' + (info && info.price > 0 ? esc(code) + " is " + fmtMoney(info.price) + " now. " : "") + "The site flags the holding when either price is reached. Nothing is sold automatically.</p>" +
        '<div class="field"><label for="lvl-target">Price target</label><div class="money-input"><span>$</span><input id="lvl-target" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Where you expect it to get to" value="' + (lv.target > 0 ? lv.target : "") + '"></div></div>' +
        '<div class="field"><label for="lvl-stop">Review price</label><div class="money-input"><span>$</span><input id="lvl-stop" type="number" min="0" step="0.01" inputmode="decimal" placeholder="If it falls to here, the thesis is reviewed" value="' + (lv.stop > 0 ? lv.stop : "") + '"></div></div>' +
        '<p class="small form-msg" id="lvl-msg"></p>' +
        '<div class="modal-actions"><button type="button" class="btn secondary" data-action="levels-cancel">Cancel</button><button type="button" class="btn" data-action="levels-save">Save</button></div>' +
      "</div>";
    document.body.appendChild(el);
    $("#lvl-target").focus();
  }
  function saveLevels() {
    var el = $("#levels-modal");
    if (!el) return;
    var code = el.dataset.code, target = toNum($("#lvl-target").value), stop = toNum($("#lvl-stop").value);
    if (target > 0 && stop > 0 && stop >= target) { $("#lvl-msg").innerHTML = '<p class="form-bad">The review price should be below the target.</p>'; return; }
    store.saveLevel(code, target > 0 ? target : 0, stop > 0 ? stop : 0).then(function () { return store.listLevels(); })
      .then(function (m) { state.levels = m; closeLevels(); toast("Saved for " + code); render(); })
      .catch(function (e) { $("#lvl-msg").innerHTML = '<p class="form-bad">' + esc(e.message) + "</p>"; });
  }

  // ---------- attribution: what each stock added to or took off the fund ----------
  function attribution() {
    var by = {};
    state.trades.forEach(function (t) {
      if (!t.code) return;
      var r = by[t.code] || (by[t.code] = { code: t.code, flow: 0, qty: 0 });
      var v = (t.quantity || 0) * (t.price || 0);
      if (t.type === "buy") { r.flow -= v + (t.brokerage || 0); r.qty += t.quantity; }
      else if (t.type === "sell") { r.flow += v - (t.brokerage || 0); r.qty -= t.quantity; }
      else if (t.type === "dividend") r.flow += t.cash_amount || 0;
    });
    return Object.keys(by).map(function (k) {
      var r = by[k], info = state.prices[k], held = r.qty > 1e-9;
      var pnl = r.flow + (held && info && info.price > 0 ? r.qty * info.price : 0);
      return { code: k, name: info ? info.name : "", held: held, pnl: pnl, contrib: CFG.STARTING_CAPITAL > 0 ? pnl / CFG.STARTING_CAPITAL : 0 };
    }).sort(function (a, b) { return b.pnl - a.pnl; });
  }
  function signedPct(n, dp) { return (n > 0 ? "+" : "") + fmtPct(n, dp == null ? 2 : dp); }
  function attributionRows(list) {
    var max = list.reduce(function (m, r) { return Math.max(m, Math.abs(r.contrib)); }, 0) || 1;
    return list.map(function (r, i) {
      var w = (Math.abs(r.contrib) / max * 50).toFixed(1);
      return '<div class="attr-row"><span class="attr-label"><b>' + esc(r.code) + "</b>" + (r.held ? "" : ' <span class="muted small">sold</span>') + "</span>" +
        '<span class="attr-track"><span class="attr-bar ' + (r.contrib >= 0 ? "pos" : "neg") + '" style="width:' + w + "%;--d:" + (i * 60) + 'ms"></span></span>' +
        '<span class="attr-value ' + signClass(r.pnl) + '">' + signedPct(r.contrib) + '<span class="muted small"> ' + (r.pnl >= 0 ? "+" : "-") + whole(Math.abs(r.pnl)) + "</span></span></div>";
    }).join("");
  }
  function attributionCardHtml() {
    var list = attribution();
    if (!list.length) return "";
    var total = list.reduce(function (a, r) { return a + r.contrib; }, 0);
    return '<div class="card"><div class="card-title-row"><h2>What drove the return</h2><span class="muted small">Each stock\'s share of the fund\'s ' + signedPct(total) + " return, including sold positions and dividends</span></div>" +
      '<div class="attr">' + attributionRows(list) + "</div></div>";
  }

  // ---------- risk numbers, worked out from the daily history ----------
  function riskStats(points) {
    var MIN = 11;
    if (!points || points.length < MIN) return { need: MIN - (points ? points.length : 0) };
    var rf = [], rb = [], i;
    for (i = 1; i < points.length; i++) { rf.push(points[i].fund / points[i - 1].fund - 1); rb.push(points[i].bench / points[i - 1].bench - 1); }
    var mean = function (a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; };
    var sd = function (a) { var m = mean(a); return Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / (a.length - 1)); };
    var mf = mean(rf), mb = mean(rb), cov = 0, vb = 0;
    for (i = 0; i < rf.length; i++) { cov += (rf[i] - mf) * (rb[i] - mb); vb += (rb[i] - mb) * (rb[i] - mb); }
    var peak = points[0].fund, dd = 0;
    points.forEach(function (p) { peak = Math.max(peak, p.fund); dd = Math.min(dd, p.fund / peak - 1); });
    var active = rf.map(function (x, k) { return x - rb[k]; });
    return { days: points.length, vol: sd(rf) * Math.sqrt(252), te: sd(active) * Math.sqrt(252), beta: vb > 0 ? cov / vb : 0, dd: dd };
  }
  function riskItems(r) {
    return [
      ["Volatility", fmtPct(r.vol), "How much the fund's value swings, as a yearly rate"],
      ["Worst fall", fmtPct(r.dd), "The biggest drop from a high point so far"],
      ["Tracking error", fmtPct(r.te), "How far the fund strays from the index, as a yearly rate"],
      ["Beta", r.beta.toFixed(2), "Above 1 means the fund moves more than the index"]
    ];
  }
  function riskCardHtml(perf) {
    var r = riskStats(perf.points);
    if (!state.trades.some(function (t) { return t.type === "buy"; })) return "";
    var body = r.need
      ? '<p class="muted small" style="margin:0">Risk numbers need about two weeks of daily history. ' + r.need + " more trading " + (r.need === 1 ? "day" : "days") + " to go.</p>"
      : '<div class="risk-grid">' + riskItems(r).map(function (x) { return '<div class="risk-item"><div class="eyebrow">' + x[0] + '</div><div class="risk-value">' + x[1] + '</div><div class="muted small">' + x[2] + "</div></div>"; }).join("") + "</div>";
    return '<div class="card"><div class="card-title-row"><h2>Risk</h2><span class="muted small">' + (perf.sample ? "Sample history" : r.need ? "" : "From " + r.days + " trading days") + "</span></div>" + body + "</div>";
  }

  // ---------- monthly report ----------
  function monthOf(iso) { var d = sydneyWallClock(iso); return d ? d.toISOString().slice(0, 7) : ""; }
  function renderReport() {
    var pf = computePortfolio(state.trades), perf = performancePoints(pf), pts = perf.points;
    var today = sydneyToday(), month = today.slice(0, 7);
    var monthName = new Date(month + "-01T00:00:00Z").toLocaleDateString("en-AU", { timeZone: "UTC", month: "long", year: "numeric" });
    var asAt = new Date(today + "T00:00:00Z").toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
    var gain = pf.total - CFG.STARTING_CAPITAL;
    var vsIndex = null, mtd = null, mtdBench = null;
    if (pts.length >= 2) {
      var first = pts[0], last = pts[pts.length - 1];
      vsIndex = (last.fund / first.fund - 1) - (last.bench / first.bench - 1);
      var before = pts.filter(function (p) { return p.day < month + "-01"; }), inMonth = pts.filter(function (p) { return p.day >= month + "-01"; });
      var base = before.length ? before[before.length - 1] : inMonth[0];
      if (base && inMonth.length && base !== last) { mtd = last.fund / base.fund - 1; mtdBench = last.bench / base.bench - 1; }
    }
    var att = attribution(), best = att.length ? att[0] : null, worst = att.length > 1 ? att[att.length - 1] : null;
    var risk = riskStats(pts);
    var acts = state.trades.filter(function (t) { return t.type !== "deposit" && monthOf(t.created_at) === month; });
    var buys = acts.filter(function (t) { return t.type === "buy"; }), sells = acts.filter(function (t) { return t.type === "sell"; });
    var divs = acts.filter(function (t) { return t.type === "dividend"; }).reduce(function (a, t) { return a + (t.cash_amount || 0); }, 0);
    var comment = state.report && state.report.month === month ? state.report.comment : "";

    var kpi = function (label, value, sub, cls) { return '<div class="sheet-kpi"><div class="eyebrow">' + label + '</div><div class="sheet-kpi-value ' + (cls || "") + '">' + value + '</div><div class="muted small">' + sub + "</div></div>"; };
    var by = {};
    pf.positions.forEach(function (p) { var k = p.code === CFG.ETF_CODE ? "Index ETF" : (p.sector || "Other"); by[k] = (by[k] || 0) + p.value; });
    if (pf.cash > 0.005) by.Cash = pf.cash;
    var sectors = Object.keys(by).map(function (k) { return [k, by[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    var maxS = sectors.length ? sectors[0][1] : 1;

    $("#main").innerHTML =
      bandHtml("Investor report", monthName, "A one-page summary of the fund, built from the live record. Print it or save it as a PDF to send around.", [],
        '<button type="button" class="btn" data-action="print-report">Print or save as PDF</button>' +
        (isAdmin() ? '<button type="button" class="btn ghost" data-action="comment-open">' + (comment ? "Edit" : "Write") + " the manager's comment</button>" : "")) +
      '<article class="card sheet">' +
        '<header class="sheet-head"><div class="sheet-brand"><img class="sheet-logo dark-only" src="img/logo-mark-dark.png" alt="" width="52" height="47"><img class="sheet-logo print-only" src="img/logo-mark.png" alt="" width="52" height="47">' +
          '<div><div class="sheet-name">The Lighthouse Fund</div><div class="muted small">An AFSA initiative · Macquarie University</div></div></div>' +
          '<div class="sheet-date"><div class="sheet-title">Monthly report</div><div class="muted small">' + esc(monthName) + " · as at " + esc(asAt) + "</div></div></header>" +
        '<div class="sheet-kpis">' +
          kpi("Fund value", fmtMoney(pf.total), "Started with " + whole(CFG.STARTING_CAPITAL)) +
          kpi("Since inception", signedPct(pf.ret), (gain >= 0 ? "+" : "-") + fmtMoney(Math.abs(gain)), signClass(pf.ret)) +
          kpi("This month", mtd === null ? "Not yet" : signedPct(mtd), mtd === null ? "Needs daily history" : "Index " + signedPct(mtdBench), mtd === null ? "" : signClass(mtd)) +
          kpi("Against the index", vsIndex === null ? "Not yet" : signedPct(vsIndex), vsIndex === null ? "Needs daily history" : (vsIndex >= 0 ? "Ahead of" : "Behind") + " the ASX 300 index ETF", vsIndex === null ? "" : signClass(vsIndex)) +
        "</div>" +
        '<div class="sheet-cols"><div class="sheet-col">' +
          '<section><h3>Manager\'s comment</h3>' + (comment ? '<p class="sheet-comment">' + esc(comment).replace(/\n/g, "<br>") + "</p>" : '<p class="muted">' + (isAdmin() ? "No comment yet. Use the button above to write one for this month." : "No comment has been written for this month yet.") + "</p>") + "</section>" +
          "<section><h3>Largest holdings</h3>" + (pf.positions.length ? '<table class="sheet-table"><thead><tr><th>Stock</th><th class="num">Weight</th><th class="num">Value</th><th class="num">Gain or loss</th></tr></thead><tbody>' +
            pf.positions.slice(0, 6).map(function (p) { return "<tr><td><b>" + esc(p.code) + '</b> <span class="muted small">' + esc(p.name) + '</span></td><td class="num">' + fmtPct(p.weight) + '</td><td class="num">' + whole(p.value) + '</td><td class="num ' + signClass(p.gain) + '">' + signedPct(p.gainPct, 1) + "</td></tr>"; }).join("") +
            "</tbody></table>" : '<p class="muted">The fund is all in cash.</p>') + "</section>" +
          "<section><h3>What drove the return</h3>" + (att.length ? '<div class="attr">' + attributionRows(att.slice(0, 8)) + "</div>" : '<p class="muted">Nothing has been bought yet.</p>') + "</section>" +
        '</div><div class="sheet-col">' +
          "<section><h3>Where the money is</h3>" + '<div class="bars">' + sectors.map(function (r) {
            return '<div class="bar-row"><span class="bar-label">' + esc(r[0]) + '</span><span class="bar-track"><span class="bar-fill' + (r[0] === "Cash" ? " cash" : "") + '" style="width:' + (r[1] / maxS * 100).toFixed(1) + '%"></span></span><span class="bar-value">' + fmtPct(pf.total > 0 ? r[1] / pf.total : 0) + "</span></div>";
          }).join("") + "</div></section>" +
          (best ? '<section><h3>Best and worst</h3><div class="sheet-pair">' +
            '<div class="sheet-tile"><div class="eyebrow">Best</div><div class="sheet-tile-value">' + esc(best.code) + '</div><div class="small ' + signClass(best.pnl) + '">' + signedPct(best.contrib) + " of the fund</div></div>" +
            (worst ? '<div class="sheet-tile"><div class="eyebrow">Worst</div><div class="sheet-tile-value">' + esc(worst.code) + '</div><div class="small ' + signClass(worst.pnl) + '">' + signedPct(worst.contrib) + " of the fund</div></div>" : "") + "</div></section>" : "") +
          "<section><h3>Risk</h3>" + (risk.need ? '<p class="muted">Risk numbers appear after about two weeks of daily history.</p>'
            : '<div class="sheet-risk">' + riskItems(risk).map(function (x) { return "<div><span>" + x[0] + "</span><b>" + x[1] + "</b></div>"; }).join("") + "</div>") + "</section>" +
          "<section><h3>Activity this month</h3><p>" + buys.length + (buys.length === 1 ? " buy" : " buys") + ", " + sells.length + (sells.length === 1 ? " sell" : " sells") + (divs > 0 ? ", " + fmtMoney(divs) + " in dividends" : "") + ".</p>" +
            (buys.length + sells.length ? '<ul class="sheet-acts">' + buys.concat(sells).sort(function (a, b) { return a.id - b.id; }).slice(-8).map(function (t) {
              return "<li><b>" + (t.type === "buy" ? "Bought " : "Sold ") + fmtQty(t.quantity) + " " + esc(t.code) + "</b> at " + fmtPrice(t.price) + ' <span class="muted small">' + esc(fmtDay(t.created_at)) + "</span></li>"; }).join("") + "</ul>" : "") + "</section>" +
        "</div></div>" +
        '<footer class="sheet-foot">The Lighthouse Fund is a simulated portfolio. No real money is invested and nothing in this report is financial advice. Prices are delayed by about 20 minutes.' + (perf.sample ? " Demo mode: the history behind these numbers is a sample." : "") + "</footer>" +
      "</article>";
  }
  function closeComment() { var el = $("#comment-modal"); if (el) el.remove(); }
  function openComment() {
    closeComment();
    var month = sydneyToday().slice(0, 7), el = document.createElement("div");
    el.className = "modal";
    el.id = "comment-modal";
    el.innerHTML = '<div class="modal-box wide" role="dialog" aria-modal="true" aria-labelledby="cm-title"><h2 id="cm-title">Manager\'s comment</h2>' +
      '<p class="muted small">A few sentences on what happened this month and what you are watching. It appears on the report.</p>' +
      '<div class="field"><label class="sr-only" for="report-comment">Comment</label><textarea id="report-comment" rows="7" maxlength="1200">' + esc(state.report && state.report.month === month ? state.report.comment : "") + "</textarea></div>" +
      '<p class="small form-msg" id="cm-msg"></p>' +
      '<div class="modal-actions"><button type="button" class="btn secondary" data-action="comment-cancel">Cancel</button><button type="button" class="btn" data-action="comment-save">Save</button></div></div>';
    document.body.appendChild(el);
    $("#report-comment").focus();
  }
  function saveComment() {
    var month = sydneyToday().slice(0, 7), text = $("#report-comment").value.trim().slice(0, 1200);
    store.saveReport(month, text).then(function () { state.report = { month: month, comment: text }; closeComment(); toast("Comment saved"); render(); })
      .catch(function (e) { $("#cm-msg").innerHTML = '<p class="form-bad">' + esc(e.message) + "</p>"; });
  }

  // ---------- page band ----------
  // The dark strip at the top of each page: a title, a line of explanation and a few key numbers.
  function bandHtml(eyebrow, title, sub, stats, actions, lead) {
    return '<section class="band">' + (lead || "") +
      '<div class="band-text"><div class="eyebrow light">' + esc(eyebrow) + "</div><h1>" + esc(title) + "</h1>" + (sub ? "<p>" + sub + "</p>" : "") +
      (actions ? '<div class="band-actions">' + actions + "</div>" : "") + "</div>" +
      '<div class="band-stats">' + (stats || []).map(function (st) {
        return '<div class="band-stat"><div class="eyebrow light">' + esc(st[0]) + '</div><div class="band-stat-value ' + (st[2] || "") + '">' + st[1] + "</div></div>";
      }).join("") + "</div></section>";
  }
  function whole(n) { return "$" + Math.round(isFinite(n) ? n : 0).toLocaleString("en-AU"); }
  // A small square with the stock code's first letters, in front of a company name.
  function monoHtml(code, held) {
    return '<span class="mono' + (held ? " held" : "") + '" aria-hidden="true">' + esc(String(code || "").slice(0, 2)) + "</span>";
  }

  // ---------- small visuals ----------
  // A moving strip of prices: what the fund holds first, then the day's biggest movers.
  function tickerHtml(pf) {
    var seen = {}, items = [];
    var add = function (p) { if (p && p.price > 0 && !seen[p.code]) { seen[p.code] = true; items.push(p); } };
    pf.positions.forEach(function (h) { add(state.prices[h.code]); });
    state.priceList.slice().sort(function (a, b) { return Math.abs(b.change_pct) - Math.abs(a.change_pct); }).slice(0, 14).forEach(add);
    if (items.length < 4) return "";
    var row = items.map(function (p) {
      var c = p.change_pct;
      return '<span class="tick"><b>' + esc(p.code) + "</b> " + fmtMoney(p.price) + ' <i class="' + (c > 0 ? "up" : c < 0 ? "down" : "") + '">' + (c > 0 ? "▲ " : c < 0 ? "▼ " : "") + Math.abs(c).toFixed(2) + "%</i></span>";
    }).join("");
    return '<div class="ticker" aria-hidden="true"><div class="ticker-track" style="animation-duration:' + (items.length * 3.200).toFixed(0) + 's">' + row + row + "</div></div>";
  }
  // Where the money sits, by sector, as horizontal bars.
  function sectorCardHtml(pf) {
    var by = {};
    pf.positions.forEach(function (p) { var k = p.code === CFG.ETF_CODE ? "Index ETF" : (p.sector || "Other"); by[k] = (by[k] || 0) + p.value; });
    if (pf.cash > 0.005) by.Cash = pf.cash;
    var list = Object.keys(by).map(function (k) { return [k, by[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    if (!pf.positions.length) return "";
    var max = list[0][1] || 1;
    return '<div class="card"><h2>Where the money is</h2><div class="bars">' + list.map(function (r, i) {
      return '<div class="bar-row"><span class="bar-label">' + esc(r[0]) + '</span><span class="bar-track"><span class="bar-fill' + (r[0] === "Cash" ? " cash" : "") + '" style="width:' + (r[1] / max * 100).toFixed(1) + "%;--d:" + (i * 60) + 'ms"></span></span><span class="bar-value">' + fmtPct(pf.total > 0 ? r[1] / pf.total : 0) + "</span></div>";
    }).join("") + "</div></div>";
  }
  // The day's biggest rises and falls, shown on the Trade page until a stock is chosen.
  function moversHtml() {
    var list = state.priceList.filter(function (p) { return p.price > 0 && p.code !== CFG.ETF_CODE; });
    if (list.length < 8) return "";
    var by = list.slice().sort(function (a, b) { return b.change_pct - a.change_pct; });
    var col = function (title, rows) {
      return '<div><div class="eyebrow">' + title + "</div>" + rows.map(function (p) {
        return '<button type="button" class="mover" data-code="' + esc(p.code) + '"><span><b>' + esc(p.code) + '</b><span class="muted small">' + esc(p.name) + '</span></span><span class="num ' + signClass(p.change_pct) + '">' + (p.change_pct > 0 ? "+" : "") + p.change_pct.toFixed(2) + "%</span></button>";
      }).join("") + "</div>";
    };
    return '<div class="movers">' + col("Biggest rises today", by.slice(0, 4)) + col("Biggest falls today", by.slice(-4).reverse()) + "</div>";
  }
  // Runs the entrance effects once after moving to a page, not on every background refresh.
  function playMotion() {
    if (!state.animateNext) return;
    state.animateNext = false;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var els = [];
    document.querySelectorAll("#main .card, #main .reveal").forEach(function (el) {
      if (el.parentElement && el.parentElement.closest(".card")) return;
      el.classList.add("pre", "rise"); els.push(el);
    });
    document.querySelectorAll("#main .bar-fill, #main .attr-bar, #main #perf-chart").forEach(function (el) { el.classList.add("pre"); els.push(el); });
    document.querySelectorAll("#main .home-hero, #main .hero").forEach(function (el) { el.classList.add("pre", "fade-in"); });
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
      }, { threshold: 0.08 });
      els.forEach(function (el) { io.observe(el); });
    } else { els.forEach(function (el) { el.classList.add("in"); }); }
    document.querySelectorAll("#main [data-count]").forEach(function (el) {
      var end = Number(el.dataset.count), t0 = null;
      if (!(end > 0)) return;
      var step = function (t) {
        if (!el.isConnected) return;
        if (t0 === null) t0 = t;
        var k = Math.min(1, (t - t0) / 1100), e = 1 - Math.pow(1 - k, 3);
        el.textContent = fmtMoney(end * e);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  // ---------- home page ----------
  // What a visitor sees first: what the fund is, how it is run and what it holds.
  function renderHome() {
    var pf = computePortfolio(state.trades), perf = performancePoints(pf);
    // If the record could not be loaded, show the starting position, not a fund worth nothing.
    if (!state.trades.length) pf.total = pf.cash = CFG.STARTING_CAPITAL;
    var gain = pf.total - CFG.STARTING_CAPITAL, ret = CFG.STARTING_CAPITAL > 0 ? gain / CFG.STARTING_CAPITAL : 0;
    var dir = Math.abs(gain) < 0.005 ? "flat" : gain > 0 ? "up" : "down";
    var stocks = pf.positions.filter(function (p) { return p.qty > 0; });
    var theses = CFG.THESES || {}, team = CFG.TEAM || [];

    var pillarIcons = [
      '<path d="M4 19V10M10 19V5M16 19v-7M22 19H2" />',
      '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.500 7-10V6l-7-3ZM9 12l2.200 2.200L15.500 10" />',
      '<path d="M7 3h7l5 5v13H7V3ZM14 3v5h5M10 13h6M10 17h6" />'
    ];
    var pillars = [
      ["Australian shares only", "The fund invests in companies in the S&P/ASX 300 and an ASX 300 index ETF. No short selling, borrowing or derivatives."],
      ["Limits that hold", "No buy can take a single stock above " + fmtPct(CFG.MAX_STOCK_WEIGHT, 0) + " of the fund, and every order is checked against the mandate and signed off by the Fund Manager."],
      ["Everything on the record", "Every trade is kept permanently with who placed it and when. Nothing can be edited or deleted afterwards."]
    ].map(function (c, i) {
      return '<div class="card pillar reveal" style="--d:' + (i * 90) + 'ms"><div class="pillar-ico"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.700" stroke-linecap="round" stroke-linejoin="round">' + pillarIcons[i] + "</svg></div><h3>" + esc(c[0]) + "</h3><p>" + esc(c[1]) + "</p></div>";
    }).join("");

    var holdings = stocks.slice(0, 6).map(function (p) {
      var info = state.prices[p.code] || {};
      return '<div class="card holding reveal"><div class="holding-top"><div><div class="holding-code">' + esc(p.code) + '</div><div class="muted small">' + esc(p.name) + "</div></div>" +
        '<div class="holding-weight">' + fmtPct(p.weight) + '<span class="muted small"> of the fund</span></div></div>' +
        '<div class="holding-meta"><span class="pill">' + esc(info.sector || p.sector || sleeveLabel(p.sleeve)) + '</span><span class="' + signClass(p.gain) + '">' + (p.gain >= 0 ? "+" : "") + fmtPct(p.cost > 0 ? p.gain / p.cost : 0) + " since bought</span></div>" +
        (theses[p.code] ? '<p class="holding-thesis">' + esc(theses[p.code]) + "</p>" : "") + "</div>";
    }).join("");

    var people = team.map(function (m) {
      var initials = String(m.name || "").split(/\s+/).map(function (w) { return w.charAt(0); }).slice(0, 2).join("").toUpperCase();
      return '<div class="card person"><span class="avatar big">' + esc(initials) + '</span><div><div class="person-name">' + esc(m.name) + '</div><div class="muted small">' + esc(m.role || "") + "</div></div></div>";
    }).join("");

    if (locked()) {
      $("#main").innerHTML =
        '<section class="home-hero">' +
          '<div class="home-hero-text"><div class="eyebrow light">An AFSA initiative · Macquarie University</div>' +
            "<h1>A student-run fund, managed like the real thing.</h1>" +
            "<p>The Lighthouse Fund is a simulated A$" + Math.round(CFG.STARTING_CAPITAL).toLocaleString("en-AU") + " portfolio of Australian shares, researched at Macquarie University and run under a written charter.</p>" +
            '<div class="home-cta"><button type="button" class="btn" data-view="signin">Member sign in</button>' +
            '<button type="button" class="btn ghost" data-action="enter-demo">Try demo mode</button></div></div>' +
          '<div class="home-stats">' +
            '<div class="home-stat main"><div class="eyebrow light">Simulated portfolio</div><div class="home-stat-value">A$' + Math.round(CFG.STARTING_CAPITAL).toLocaleString("en-AU") + '</div><span class="delta flat">No real money is invested</span></div>' +
            '<div class="home-stat"><div class="eyebrow light">Universe</div><div class="home-stat-small">ASX 300</div></div>' +
            '<div class="home-stat"><div class="eyebrow light">Buy limit</div><div class="home-stat-small">' + fmtPct(CFG.MAX_STOCK_WEIGHT, 0) + "</div></div>" +
            '<div class="home-stat"><div class="eyebrow light">Benchmark</div><div class="home-stat-small">ASX 300</div></div>' +
          "</div>" +
        "</section>" + tickerHtml(pf) +
        '<section class="home-section"><div class="section-head"><h2>How the fund is run</h2><p class="muted">The same disciplines a professional fund works under.</p></div><div class="pillars">' + pillars + "</div></section>" +
        '<section class="home-section"><div class="card members-only"><div><h2>The portfolio is for members</h2><p class="muted">The fund\'s holdings, trades and performance are only shown to people with an account. Demo mode lets anyone try the trading desk with a sample portfolio.</p></div>' +
          '<div class="home-cta"><button type="button" class="btn" data-view="signin">Member sign in</button><button type="button" class="btn secondary" data-action="enter-demo">Try demo mode</button></div></div></section>' +
        (people ? '<section class="home-section"><div class="section-head"><h2>The team</h2></div><div class="people">' + people + "</div></section>" : "") +
        '<section class="home-note"><strong>A simulated fund.</strong> No real money is invested and nothing here is financial advice. The fund exists to give students hands-on experience and to build a track record.</section>';
      return;
    }
    $("#main").innerHTML =
      '<section class="home-hero">' +
        '<div class="home-hero-text"><div class="eyebrow light">An AFSA initiative · Macquarie University</div>' +
          "<h1>A student-run fund, managed like the real thing.</h1>" +
          "<p>The Lighthouse Fund is a simulated A$" + Math.round(CFG.STARTING_CAPITAL).toLocaleString("en-AU") + " portfolio of Australian shares, researched at Macquarie University and run under a written charter.</p>" +
          '<div class="home-cta"><button type="button" class="btn" data-view="portfolio">View the portfolio</button>' +
          (state.user ? "" : '<button type="button" class="btn ghost" data-view="signin">Member sign in</button>') + "</div></div>" +
        '<div class="home-stats">' +
          '<div class="home-stat main"><div class="eyebrow light">Fund value</div><div class="home-stat-value" data-count="' + pf.total + '">' + fmtMoney(pf.total) + '</div><span class="delta ' + dir + '">' + (gain > 0 ? "+" : "") + fmtPct(ret, 2) + " since inception</span></div>" +
          '<div class="home-stat"><div class="eyebrow light">Holdings</div><div class="home-stat-small">' + pf.positions.length + "</div></div>" +
          '<div class="home-stat"><div class="eyebrow light">Invested</div><div class="home-stat-small">' + fmtPct(pf.total > 0 ? pf.holdingsValue / pf.total : 0, 0) + "</div></div>" +
          '<div class="home-stat"><div class="eyebrow light">Benchmark</div><div class="home-stat-small">ASX 300</div></div>' +
        "</div>" +
      "</section>" + tickerHtml(pf) +
      '<section class="home-section"><div class="section-head"><h2>How the fund is run</h2><p class="muted">The same disciplines a professional fund works under.</p></div><div class="pillars">' + pillars + "</div></section>" +
      '<section class="home-section"><div class="section-head"><h2>Performance</h2><p class="muted">' + (perf.sample && perf.points.length ? "Sample history for the demo." : "Tracked every trading day against the same money left in the ASX 300 index ETF.") + "</p></div>" + performanceCardHtml(perf, true) + "</section>" +
      '<section class="home-section"><div class="section-head"><h2>What the fund holds</h2><button type="button" class="link" data-view="portfolio">See the full portfolio</button></div>' +
        (holdings ? '<div class="holdings-grid">' + holdings + "</div>" : '<div class="card home-empty"><strong>The fund is fully in cash.</strong><span class="muted"> Its first positions will appear here as soon as they are bought.</span></div>') + "</section>" +
      (people ? '<section class="home-section"><div class="section-head"><h2>The team</h2></div><div class="people">' + people + "</div></section>" : "") +
      '<section class="home-note"><strong>A simulated fund.</strong> No real money is invested and nothing here is financial advice. The fund exists to give students hands-on experience and to build a track record.</section>';
    drawPerformance(perf);
  }

  // ---------- performance chart ----------
  // The fund's value each trading day beside the same money left in the index ETF.
  function performancePoints(pf) {
    var etf = state.prices[CFG.ETF_CODE], today = sydneyToday();
    if (DEMO) {
      // Demo mode has no saved history, so it draws a sample one that ends at today's value.
      if (!pf.positions.length) return { points: [], sample: true };
      var n = 60, pts = [], seed = 7, rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
      var f = 0, b = 0, fs = [0], bs = [0];
      for (var i = 1; i < n; i++) { var mkt = rnd() * 0.007; f += mkt + rnd() * 0.003; b += mkt; fs.push(f); bs.push(b); }
      var endF = pf.total / CFG.STARTING_CAPITAL - 1, endB = endF - 0.011;
      var d = new Date(today + "T00:00:00Z"), days = [];
      while (days.length < n) { if (d.getUTCDay() % 6 !== 0) days.unshift(d.toISOString().slice(0, 10)); d = new Date(d.getTime() - 86400000); }
      for (var k = 0; k < n; k++) {
        var w = k / (n - 1);
        pts.push({ day: days[k], fund: CFG.STARTING_CAPITAL * (1 + fs[k] - fs[n - 1] * w + endF * w), bench: CFG.STARTING_CAPITAL * (1 + bs[k] - bs[n - 1] * w + endB * w) });
      }
      return { points: pts, sample: true };
    }
    var rows = (state.snapshots || []).filter(function (r) { return r.fund > 0 && r.price > 0; });
    // Today's point follows the live prices on screen.
    if (rows.length && !state.pricesAreSample && etf && etf.price > 0 && tradedToday(etf)) {
      rows = rows.filter(function (r) { return r.day < today; }).concat([{ day: today, fund: pf.total, price: etf.price }]);
    }
    if (!rows.length) return { points: [], sample: false };
    var base = rows[0];
    return { points: rows.map(function (r) { return { day: r.day, fund: r.fund, bench: base.fund * r.price / base.price }; }), sample: false };
  }
  function performanceCardHtml(perf, bare) {
    var S = window.LighthouseChart.series, pts = perf.points, body;
    if (pts.length >= 2) {
      var last = pts[pts.length - 1], first = pts[0], diff = (last.fund / first.fund - 1) - (last.bench / first.bench - 1);
      body = '<div class="chart-legend">' + S.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + "</span>"; }).join("") +
        '<span class="chart-gap">' + (Math.abs(diff) < 0.00005 ? "Level with the index" : fmtPct(Math.abs(diff)) + (diff > 0 ? " ahead of" : " behind") + " the index") + " since " + esc(new Date(first.day + "T00:00:00Z").toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })) + "</span></div>" +
        '<div id="perf-chart"></div>';
    } else {
      body = '<div class="chart-empty"><svg viewBox="0 0 240 70" width="240" height="70" aria-hidden="true"><path d="M4 58 C40 50 60 54 92 40 S150 34 178 20 S220 16 236 8" fill="none" stroke="#3a3e47" stroke-width="2" stroke-dasharray="5 6" stroke-linecap="round"/></svg>' +
        "<p><strong>The chart starts soon.</strong><br>The fund's value is saved at the end of each trading day. Once there are two days on record, this shows the fund against the ASX 300 index ETF.</p></div>";
    }
    return '<div class="card">' + (bare ? "" : '<div class="card-title-row"><h2>Performance</h2><span class="muted small">' +
      (perf.sample && perf.points.length ? "Sample history for the demo" : "Fund value against the same money left in " + esc(CFG.ETF_CODE)) + "</span></div>") + body + "</div>";
  }
  function drawPerformance(perf) {
    var host = $("#perf-chart");
    if (host && perf.points.length >= 2) window.LighthouseChart.render(host, perf.points);
  }

  function statCard(label, value, sub) {
    return '<div class="card stat"><div class="eyebrow">' + esc(label) + '</div><div class="stat-value">' + value + '</div><div class="stat-sub">' + esc(sub) + "</div></div>";
  }
  function sleeveLabel(s) { return { index: "Index ETF", competition: "Competition", active: "Active" }[s] || ""; }

  function matches(p, q) {
    return !q || p.code.toLowerCase().indexOf(q) >= 0 || p.name.toLowerCase().indexOf(q) >= 0 || p.sector.toLowerCase().indexOf(q) >= 0;
  }

  function universeRows() {
    var q = state.search.trim().toLowerCase();
    var selling = state.order.side === "sell";
    var held = {};
    computePortfolio(state.trades).positions.forEach(function (p) { held[p.code] = p; });
    var list = state.priceList.filter(function (p) { return (!selling || held[p.code]) && matches(p, q); });
    if (!list.length) return '<tr><td colspan="4" class="empty">' + (selling && !q ? "The fund holds no shares to sell." : "No stocks match that search.") + "</td></tr>";
    return list.slice(0, 400).map(function (p) {
      var tag = selling ? '<span class="muted small">' + fmtQty(held[p.code].qty) + " held</span>"
        : p.code === CFG.ETF_CODE ? '<span class="pill">Index ETF</span>'
        : isExcluded(p) ? '<span class="pill bad">' + esc(p.excluded) + "</span>"
        : held[p.code] ? '<span class="pill ok">Held</span>' : "";
      return '<tr class="clickable' + (state.order.code === p.code ? " selected" : "") + '" data-code="' + esc(p.code) + '" tabindex="0">' +
        '<td><span class="co">' + monoHtml(p.code, !!held[p.code]) + '<span><span class="code">' + esc(p.code) + '</span><div class="muted small">' + esc(p.name) + "</div></span></span></td>" +
        '<td class="hide-sm">' + esc(p.sector) + "</td>" +
        '<td class="num">' + (p.price > 0 ? fmtMoney(p.price) : "No price") + '<div class="small ' + signClass(p.change_pct) + '">' + fmtChange(p.change_pct) + "</div></td>" +
        '<td class="num">' + tag + "</td></tr>";
    }).join("");
  }

  function renderTrade() {
    if (!canTrade()) {
      $("#main").innerHTML = bandHtml("Order desk", "Trade", "Only analysts and fund managers can place orders.", []) + '<div class="card"><p>' +
        (state.user ? "Your account can view the fund but cannot place trades. Ask the fund manager to make you an analyst." : "Sign in with an analyst or fund manager account to place trades.") +
        "</p>" + (state.user ? "" : '<button type="button" class="btn" data-view="signin">Sign in</button>') + "</div>";
      return;
    }
    var free = brokerageFor(1000) === 0;
    var tradePf = computePortfolio(state.trades);
    $("#main").innerHTML =
      bandHtml("Order desk", "Trade", esc(pricesStamp()) + ". Market orders fill while the ASX is open" + (SPREAD > 0 ? ", " + fmtPct(SPREAD, 1) + " away from the quoted price like a real buy and sell spread" : "") + ". Outside trading hours they wait for the next open." + (free ? " No brokerage." : ""), [
        ["Cash available", whole(tradePf.cash)], ["Fund value", whole(tradePf.total)],
        ["Open orders", String(state.orders.length)], ["Market", marketOpen() ? "Open" : "Closed", marketOpen() ? "up" : ""]]) +
      '<div id="proposals"></div>' +
      '<div class="grid-trade">' +
        '<div class="card flush"><div class="card-pad">' +
          '<div class="seg" role="group" aria-label="Buy or sell">' +
            '<button type="button" class="buy" data-side="buy" aria-pressed="' + (state.order.side === "buy") + '">Buy</button>' +
            '<button type="button" class="sell" data-side="sell" aria-pressed="' + (state.order.side === "sell") + '">Sell</button></div>' +
          '<label class="sr-only" for="search">' + (state.order.side === "sell" ? "Find a holding to sell" : "Find a stock to buy") + "</label>" +
          '<input id="search" type="search" placeholder="' + (state.order.side === "sell" ? "Search the fund's holdings" : "Search by code, company or sector") + '" value="' + esc(state.search) + '" autocomplete="off">' +
          "</div>" +
          '<div class="table-scroll list-scroll"><table><thead><tr><th>Stock</th><th class="hide-sm">Sector</th><th class="num">Price</th><th class="num"></th></tr></thead><tbody id="universe">' + universeRows() + "</tbody></table></div></div>" +
        '<div class="card ticket" id="ticket"></div>' +
      "</div>" +
      '<div id="open-orders"></div>';
    renderTicket();
    renderOpenOrders();
    renderProposals();
  }

  function orderCheckText() {
    var c = state.orderCheck;
    if (DEMO) return "Checked whenever this page refreshes. In demo mode, Fill now skips the wait.";
    if (!c || !c.checked_at) return "Checked against the low and high of each trading day whenever the site is open.";
    if (c.ok === false) return "The last automatic check at " + fmtDate(c.checked_at) + " did not work: " + (c.note || "unknown problem") + ".";
    return "Checked automatically every 5 minutes, 9am to 7pm Sydney time. Last check " + fmtDate(c.checked_at) + ".";
  }

  function renderOpenOrders() {
    var el = $("#open-orders");
    if (!el) return;
    if (!state.orders.length) { el.innerHTML = ""; return; }
    el.innerHTML = '<div class="card flush" style="margin-top:16px"><div class="card-head"><h2>Open orders</h2><span class="muted small">' + esc(orderCheckText()) + '</span></div>' +
      '<div class="table-scroll"><table><thead><tr><th>Placed</th><th>Order</th><th>Stock</th><th class="num">Quantity</th><th class="num">Limit</th><th class="num">Price now</th><th class="num">Day range</th><th>By</th><th class="num"></th></tr></thead><tbody>' +
      state.orders.map(function (o) {
        var info = state.prices[o.code];
        var mine = isAdmin() || (state.user && o.created_by === state.user.id);
        return '<tr><td class="nowrap">' + esc(fmtDate(o.created_at)) + '</td><td><span class="pill ' + o.side + '">' + (o.side === "buy" ? "Buy" : "Sell") + "</span></td>" +
          '<td class="code">' + esc(o.code) + '</td><td class="num">' + fmtQty(o.quantity) + '</td><td class="num">' + (o.kind === "market" ? '<span class="pill">Market, at the open</span>' : fmtMoney(o.limit_price)) + "</td>" +
          '<td class="num">' + (info && info.price > 0 ? fmtMoney(info.price) : "No price") + '</td><td class="num nowrap">' + (info && tradedToday(info) && info.day_low > 0 ? fmtMoney(info.day_low) + " to " + fmtMoney(info.day_high) : "") + '</td><td class="nowrap">' + esc(o.trader_name || "") + "</td>" +
          '<td class="num">' + (DEMO && info && info.price > 0 ? '<button type="button" class="btn secondary small-btn" data-fill-order="' + esc(o.id) + '" title="Demo mode only">Fill now</button> ' : "") +
            (mine ? '<button type="button" class="btn secondary small-btn" data-cancel-order="' + esc(o.id) + '">Cancel</button>' : "") + "</td></tr>";
      }).join("") + "</tbody></table></div></div>";
  }

  function renderTicket() {
    var el = $("#ticket");
    if (!el) return;
    var o = state.order;
    var info = state.prices[o.code];
    el.className = "card ticket " + o.side;
    if (!info) {
      el.innerHTML = "<h2>" + (o.side === "sell" ? "Sell order" : "Buy order") + '</h2><p class="muted" style="margin:0">' + (o.side === "sell" ? "Choose one of the fund's holdings to sell." : "Choose a stock from the list to buy.") + "</p>" + (o.side === "sell" ? "" : moversHtml());
      return;
    }
    var isEtf = info.code === CFG.ETF_CODE;
    var sleeveField = o.side === "buy" && !isEtf
      ? '<div class="field"><label for="sleeve">Sleeve</label><select id="sleeve"><option value="competition"' + (o.sleeve === "competition" ? " selected" : "") + '>Competition stock</option><option value="active"' + (o.sleeve === "active" ? " selected" : "") + ">Active sleeve</option></select></div>"
      : "";
    el.innerHTML =
      "<h2>" + (o.side === "sell" ? "Sell order" : "Buy order") + "</h2>" +
      '<div class="quote"><div><div class="quote-code">' + esc(info.code) + '</div><div class="muted small">' + esc(info.name) + "</div><div class=\"muted small\">" + esc(info.sector) + "</div></div>" +
        '<div class="quote-price"><div>' + fmtMoney(info.price) + '</div><div class="small ' + signClass(info.change_pct) + '">' + fmtChange(info.change_pct) + "</div></div></div>" +
      '<p class="links small"><a href="' + infoUrl(info.code) + '" target="_blank" rel="noopener noreferrer">Company info' + ICON.ext + "</a>" +
        '<a href="' + bookUrl(info.code) + '" target="_blank" rel="noopener noreferrer">Live order book' + ICON.ext + "</a></p>" +
      '<div class="field"><div class="field-head"><label for="' + (o.qtyMode === "amount" ? "amount" : "qty") + '">' + (o.qtyMode === "amount" ? "Dollar amount" : "Number of shares") + "</label>" +
        '<span class="mini-seg" role="group" aria-label="Order by shares or dollars"><button type="button" data-qtymode="shares" aria-pressed="' + (o.qtyMode !== "amount") + '">Shares</button><button type="button" data-qtymode="amount" aria-pressed="' + (o.qtyMode === "amount") + '">Dollars</button></span></div>' +
        (o.qtyMode === "amount"
          ? '<div class="money-input"><span>$</span><input id="amount" type="number" min="0" step="any" inputmode="decimal" placeholder="For example 5000" value="' + esc(o.amount) + '"></div>'
          : '<input id="qty" type="number" min="1" step="1" inputmode="numeric" value="' + esc(o.qty) + '">') + "</div>" +
      '<div class="field"><div class="field-head"><label' + (o.type === "limit" ? ' for="limit"' : "") + ">" + (o.type === "limit" ? "Limit price" : "Price") + "</label>" +
        '<span class="mini-seg" role="group" aria-label="Order type"><button type="button" data-otype="market" aria-pressed="' + (o.type !== "limit") + '">At market</button><button type="button" data-otype="limit" aria-pressed="' + (o.type === "limit") + '">Limit</button></span></div>' +
        (o.type === "limit"
          ? '<div class="money-input"><span>$</span><input id="limit" type="number" min="0" step="0.01" inputmode="decimal" placeholder="' + info.price.toFixed(2) + '" value="' + esc(o.limit) + '"></div>'
          : '<div class="static-field">' + fmtPrice(quote(info, o.side)) + ' <span class="muted small">' + (SPREAD > 0 ? (o.side === "buy" ? "buy" : "sell") + " price, " + fmtPct(SPREAD, 1) + (o.side === "buy" ? " above" : " below") + " the quote" : "current price") +
            (fillsNow(info) || state.queueOff || state.ordersOff ? ", fills straight away" : ". Market closed: fills at the next open") + "</span></div>") + "</div>" +
      sleeveField +
      (needsCode() ? '<div class="field"><label for="approval">Codephrase from the fund manager</label><input id="approval" class="code-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="40" placeholder="three words, for example amber harbour beacon" value="' + esc(o.approval) + '"><div class="muted small" style="margin-top:5px">Every trade goes through the fund manager. Ask them for the current three-word codephrase. It changes every 5 minutes.</div></div>' : "") +
      (needsProposal() ? '<div class="field"><label for="rationale">Your case for this trade</label><textarea id="rationale" rows="3" maxlength="600" placeholder="Why this stock, why now, and what would change your mind.">' + esc(o.rationale) + '</textarea><div class="muted small" style="margin-top:5px">This goes to the Fund Manager, who approves or rejects the trade. Nothing is placed until then.</div></div>' : "") +
      '<div id="calc"></div>';
    renderCalc();
  }

  function renderCalc() {
    var el = $("#calc");
    if (!el) return;
    var o = state.order;
    var info = state.prices[o.code];
    var pf = computePortfolio(state.trades);
    var n = orderNumbers(o, info);
    var qty = n.qty > 0 && Math.floor(n.qty) === n.qty ? n.qty : 0;
    var typed = o.qtyMode === "amount" ? Number(o.amount) > 0 : Number(o.qty) > 0;
    var value = qty * n.price;
    var brokerage = qty > 0 ? brokerageFor(value) : 0;
    var total = o.side === "buy" ? value + brokerage : value - brokerage;
    var cashAfter = o.side === "buy" ? pf.cash - total : pf.cash + total;
    var held = pf.positions.filter(function (p) { return p.code === info.code; })[0];
    var issues = typed || (n.isLimit && o.limit !== "") ? validateOrder(o, pf) : [];
    if (!typed) issues = issues.filter(function (i) { return /limit/i.test(i); });
    var proposing = needsProposal();
    var ok = typed && qty > 0 && !issues.length && !state.busy && (!needsCode() || !!codeFromPhrase(o.approval)) && (!proposing || o.rationale.trim().length >= 10);
    var limitNote = "";
    if (n.isLimit && n.limit > 0) {
      limitNote = n.pending
        ? (n.marketable ? "The market is closed, so this waits for the next session and fills at " + fmtMoney(n.limit) + " or better. You can cancel it before then."
          : "This order waits until " + info.code + " trades at " + fmtMoney(n.limit) + " or " + (o.side === "buy" ? "lower" : "higher") + ", including at any point during the day. You can cancel it before then.")
        : "The price is already " + (o.side === "buy" ? "at or below" : "at or above") + " your limit, so this fills straight away at " + fmtPrice(n.price) + ".";
    } else if (n.queued) {
      limitNote = "The ASX is closed. This order waits and fills at the price when trading starts again, which may differ from the price shown. You can cancel it before then.";
    }
    var waitWord = n.pending ? "Place limit order: " : n.queued ? "Queue for the open: " : "";

    el.innerHTML =
      '<div class="summary">' +
        "<div><span>Currently held</span><span>" + fmtQty(held ? held.qty : 0) + " shares</span></div>" +
        "<div><span>Shares in this order</span><span>" + fmtQty(qty) + " at " + fmtPrice(n.price) + "</span></div>" +
        (brokerageFor(1000) > 0 ? "<div><span>Brokerage</span><span>" + fmtMoney(brokerage) + "</span></div>" : "") +
        '<div class="total"><span>' + (o.side === "buy" ? (n.pending ? "Cost if filled" : n.queued ? "Estimated cost" : "Total cost") : (n.pending ? "Cash if filled" : n.queued ? "Estimated cash" : "Cash received")) + "</span><span>" + fmtMoney(total) + "</span></div>" +
        "<div><span>Cash after</span><span>" + fmtMoney(cashAfter) + "</span></div>" +
      "</div>" +
      (limitNote ? '<p class="muted small" style="margin:-4px 0 12px">' + esc(limitNote) + "</p>" : "") +
      (issues.length ? '<ul class="issues">' + issues.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>" : "") +
      '<button type="button" class="btn block ' + (o.side === "sell" ? "sell" : "buy") + '" data-action="submit-order"' + (ok ? "" : " disabled") + ">" +
        (state.busy ? (proposing ? "Sending…" : "Placing order…") : (proposing ? "Send to the Fund Manager: " : waitWord) + (o.side === "buy" ? (proposing || waitWord ? "buy " : "Buy ") : (proposing || waitWord ? "sell " : "Sell ")) + (qty > 0 ? fmtQty(qty) + " " : "") + esc(info.code)) + "</button>";
  }

  // One tile per sector: how many companies, how the sector moved today, and what the fund holds in it.
  function sectorTilesHtml() {
    var groups = {}, held = {};
    computePortfolio(state.trades).positions.forEach(function (h) { held[h.code] = true; });
    state.priceList.forEach(function (p) {
      if (!p.sector) return;
      var g = groups[p.sector] || (groups[p.sector] = { name: p.sector, n: 0, priced: 0, sum: 0, up: 0, down: 0, held: [] });
      g.n++;
      if (p.price > 0) { g.priced++; g.sum += p.change_pct; if (p.change_pct > 0) g.up++; else if (p.change_pct < 0) g.down++; }
      if (held[p.code]) g.held.push(p.code);
    });
    var list = Object.keys(groups).sort().map(function (k) { return groups[k]; });
    if (!list.length) return "";
    var all = '<button type="button" class="sector-tile all' + (!state.sector ? " on" : "") + '" data-sector="*" aria-pressed="' + (!state.sector) + '">' +
      '<span class="sector-name">All sectors</span><span class="sector-meta">' + state.priceList.length + " companies in " + list.length + " sectors</span></button>";
    return '<div class="section-head sector-head"><h2>Sectors</h2><p class="muted small">Pick a sector to see only its companies.</p></div><div class="sector-grid">' + all + list.map(function (g) {
      var avg = g.priced ? g.sum / g.priced : 0, moved = g.up + g.down;
      return '<button type="button" class="sector-tile' + (state.sector === g.name ? " on" : "") + '" data-sector="' + esc(g.name) + '" aria-pressed="' + (state.sector === g.name) + '">' +
        '<span class="sector-top"><span class="sector-name">' + esc(g.name) + '</span><span class="chg ' + signClass(avg) + '">' + fmtChange(avg) + "</span></span>" +
        '<span class="sector-meta">' + g.n + (g.n === 1 ? " company" : " companies") + (g.held.length ? ' · <b class="sector-held">Fund holds ' + esc(g.held.join(", ")) + "</b>" : "") + "</span>" +
        '<span class="sector-bar" title="' + g.up + " rising, " + g.down + ' falling today">' + (moved ? '<i class="breadth-up" style="width:' + (g.up / moved * 100).toFixed(1) + '%"></i><i class="breadth-down"></i>' : "") + "</span></button>";
    }).join("") + "</div>";
  }

  function renderCompanies() {
    var sectors = {};
    state.priceList.forEach(function (p) { if (p.sector) sectors[p.sector] = true; });
    var sectorOpts = '<option value="">All sectors</option>' + Object.keys(sectors).sort().map(function (s) {
      return '<option value="' + esc(s) + '"' + (state.sector === s ? " selected" : "") + ">" + esc(s) + "</option>";
    }).join("");
    var priced = state.priceList.filter(function (p) { return p.price > 0; });
    var rising = priced.filter(function (p) { return p.change_pct > 0; }).length, falling = priced.filter(function (p) { return p.change_pct < 0; }).length;
    var top = priced.slice().sort(function (a, b) { return Math.abs(b.change_pct) - Math.abs(a.change_pct); })[0];
    $("#main").innerHTML =
      bandHtml("The universe", "Companies", "Every company the fund can buy. Click one to open its full profile on Market Index in a new tab.", [
        ["Companies", String(priced.length)], ["Rising today", String(rising), "up"], ["Falling today", String(falling), "down"],
        ["Biggest mover", top ? esc(top.code) + " " + (top.change_pct > 0 ? "+" : "") + top.change_pct.toFixed(1) + "%" : "None", top ? signClass(top.change_pct) : ""]]) +
      (rising + falling > 0 ? '<div class="breadth" title="Share of companies rising and falling today"><span class="breadth-up" style="width:' + (rising / (rising + falling) * 100).toFixed(1) + '%"></span><span class="breadth-down"></span></div>' : "") +
      '<div id="sector-tiles">' + sectorTilesHtml() + "</div>" +
      '<div class="card flush" id="co-table"><div class="card-pad filters">' +
        '<label class="sr-only" for="co-search">Search companies</label><input id="co-search" type="search" placeholder="Search by code or company" value="' + esc(state.coSearch) + '" autocomplete="off">' +
        '<label class="sr-only" for="co-sector">Sector</label><select id="co-sector">' + sectorOpts + "</select>" +
        '<span class="muted small" id="co-count"></span></div>' +
        '<div class="table-scroll"><table><thead><tr><th>Company</th><th>Sector</th><th class="num">Price</th><th class="num">Change</th><th class="num">Market cap</th><th class="num">Links</th></tr></thead><tbody id="companies"></tbody></table></div></div>';
    renderCompanyRows();
  }

  function renderCompanyRows() {
    var body = $("#companies");
    if (!body) return;
    var q = state.coSearch.trim().toLowerCase();
    var list = state.priceList.filter(function (p) {
      return (!state.sector || p.sector === state.sector) && (!q || p.code.toLowerCase().indexOf(q) >= 0 || p.name.toLowerCase().indexOf(q) >= 0);
    });
    $("#co-count").textContent = list.length + (list.length === 1 ? " company" : " companies") + (state.sector ? " in " + state.sector : "");
    var heldNow = {};
    computePortfolio(state.trades).positions.forEach(function (h) { heldNow[h.code] = true; });
    body.innerHTML = list.map(function (p) {
      return "<tr>" +
        '<td><span class="co">' + monoHtml(p.code, !!heldNow[p.code]) + '<a class="co-link" href="' + infoUrl(p.code) + '" target="_blank" rel="noopener noreferrer"><span class="code">' + esc(p.code) + '</span><span class="muted small">' + esc(p.name) + "</span></a></span></td>" +
        '<td><span class="pill">' + esc(p.sector) + "</span></td>" +
        '<td class="num">' + (p.price > 0 ? fmtMoney(p.price) : "No price") + "</td>" +
        '<td class="num"><span class="chg ' + signClass(p.change_pct) + '">' + fmtChange(p.change_pct) + "</span></td>" +
        '<td class="num">' + fmtCap(p.market_cap) + "</td>" +
        '<td class="num"><div class="row-links"><a href="' + infoUrl(p.code) + '" target="_blank" rel="noopener noreferrer">Info' + ICON.ext + "</a>" +
          '<a href="' + bookUrl(p.code) + '" target="_blank" rel="noopener noreferrer">Order book' + ICON.ext + "</a>" +
          (canTrade() ? '<button type="button" class="btn small-btn" data-trade="' + esc(p.code) + '">Trade</button>' : "") + "</div></td></tr>";
    }).join("") || '<tr><td colspan="6" class="empty">No companies match.</td></tr>';
  }

  // ---------- dividends ----------
  // The fund manager records a dividend by its cents per share. It is added to the fund as cash.
  function closeDividend() { var el = $("#dividend-modal"); if (el) el.remove(); }
  function dividendNumbers() {
    var sel = $("#div-code"), cents = toNum(($("#div-cents") || {}).value);
    var pf = computePortfolio(state.trades);
    var pos = pf.positions.filter(function (p) { return sel && p.code === sel.value; })[0];
    var qty = pos ? pos.qty : 0;
    var amount = round2(qty * cents / 100);
    var info = pos ? state.prices[pos.code] : null;
    var price = info && info.price > 0 ? info.price : 0;
    var n = { code: pos ? pos.code : "", sleeve: pos ? pos.sleeve : null, qty: qty, cents: cents, amount: amount, price: price,
      reinvest: !!($("#div-reinvest") || {}).checked, buyQty: price > 0 ? Math.floor(amount / price) : 0, blocked: "" };
    // Reinvesting is a buy, so the single stock limit applies to it.
    if (pos && pos.code !== CFG.ETF_CODE && n.buyQty > 0 && pf.total + amount > 0 &&
        (pos.value + n.buyQty * price) / (pf.total + amount) > CFG.MAX_STOCK_WEIGHT + 1e-9) {
      n.blocked = pos.code + " would be above " + fmtPct(CFG.MAX_STOCK_WEIGHT, 0) + " of the fund, so this dividend can only be kept as cash.";
    } else if (amount > 0 && !price) {
      n.blocked = "There is no price for " + n.code + " right now, so this dividend can only be kept as cash.";
    } else if (amount > 0 && n.buyQty < 1) {
      n.blocked = "The dividend is less than the price of one share, so it can only be kept as cash.";
    }
    return n;
  }
  function renderDividendCalc() {
    var el = $("#div-calc"), btn = $("[data-action=dividend-save]"), re = $("#div-reinvest");
    if (!el) return;
    var n = dividendNumbers();
    if (re) { re.disabled = !!n.blocked; if (n.blocked && re.checked) { $("#div-cash").checked = true; n.reinvest = false; } }
    var text = "Enter the dividend in cents per share.";
    if (n.cents > 0) {
      text = fmtQty(n.qty) + " shares at " + n.cents + " cents each is a dividend of " + fmtMoney(n.amount) + ". ";
      if (n.reinvest) text += "It buys " + fmtQty(n.buyQty) + " more " + n.code + " at " + fmtMoney(n.price) + ", and the " + fmtMoney(round2(n.amount - n.buyQty * n.price)) + " left over stays as cash.";
      else text += "It is added to the fund's cash." + (n.blocked ? " " + n.blocked : "");
    }
    el.textContent = text;
    if (btn) { btn.disabled = !(n.amount > 0); btn.textContent = n.reinvest ? "Record and reinvest" : "Record as cash"; }
  }
  function openDividend() {
    closeDividend();
    var held = computePortfolio(state.trades).positions.filter(function (p) { return p.qty > 0; });
    if (!held.length) { toast("The fund holds no shares, so there is no dividend to record."); return; }
    var el = document.createElement("div");
    el.className = "modal";
    el.id = "dividend-modal";
    el.innerHTML =
      '<div class="modal-box wide" role="dialog" aria-modal="true" aria-labelledby="div-title">' +
        '<h2 id="div-title">Record a dividend</h2>' +
        '<p class="muted small">Enter it on the day it is paid. It goes on the permanent record.</p>' +
        '<div class="field"><label for="div-code">Stock</label><select id="div-code">' +
          held.map(function (p) { return '<option value="' + esc(p.code) + '">' + esc(p.code) + " · " + fmtQty(p.qty) + " shares</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label for="div-cents">Dividend, in cents per share</label><input id="div-cents" type="number" min="0" step="0.01" inputmode="decimal" placeholder="For example 45"></div>' +
        '<div class="field"><span class="field-label">What to do with it</span>' +
          '<label class="choice"><input type="radio" name="div-mode" id="div-cash" checked> Keep it as cash</label>' +
          '<label class="choice"><input type="radio" name="div-mode" id="div-reinvest"> Reinvest it in the same stock</label></div>' +
        '<p class="small" id="div-calc"></p>' +
        '<div class="modal-actions"><button type="button" class="btn secondary" data-action="dividend-cancel">Cancel</button><button type="button" class="btn" data-action="dividend-save" disabled>Record as cash</button></div>' +
      "</div>";
    document.body.appendChild(el);
    renderDividendCalc();
    $("#div-cents").focus();
  }
  function saveDividend() {
    var n = dividendNumbers();
    if (!(n.amount > 0)) return;
    var reinvest = n.reinvest && !n.blocked && n.buyQty > 0;
    var btn = $("[data-action=dividend-save]");
    if (btn) btn.disabled = true;
    var recorded = false;
    store.addDividend({ code: n.code, cash_amount: n.amount, note: "Dividend of " + n.cents + " cents a share on " + fmtQty(n.qty) + " shares" })
      .then(function () {
        recorded = true;
        if (!reinvest) return null;
        return store.addTrade({ type: "buy", code: n.code, sleeve: n.sleeve, quantity: n.buyQty, price: n.price, note: "Dividend reinvested" });
      })
      .then(function () { closeDividend(); return refreshAll(); })
      .then(function () { toast("Dividend recorded: " + fmtMoney(n.amount) + " from " + n.code + (reinvest ? ", reinvested in " + fmtQty(n.buyQty) + " shares" : "")); })
      .catch(function (e) {
        if (recorded) { closeDividend(); refreshAll(); toast("The dividend was recorded as cash, but the reinvestment did not go through: " + e.message); }
        else { if (btn) btn.disabled = false; toast("Dividend not recorded: " + e.message); }
      });
  }

  function renderHistory() {
    var showBrokerage = state.trades.some(function (t) { return t.brokerage > 0; });
    var showNote = state.trades.some(function (t) { return t.note && t.type !== "deposit"; });
    var hf = state.histFilter || "all", hs = { count: 0, bought: 0, sold: 0, dividends: 0 };
    state.trades.forEach(function (t) {
      var v = (t.quantity || 0) * (t.price || 0);
      if (t.type === "buy") { hs.count++; hs.bought += v; } else if (t.type === "sell") { hs.count++; hs.sold += v; } else if (t.type === "dividend") hs.dividends += t.cash_amount || 0;
    });
    var rows = state.trades.slice().reverse().filter(function (t) { return hf === "all" || t.type === hf; }).map(function (t) {
      var value = (t.quantity || 0) * (t.price || 0);
      var cashEffect = t.type === "buy" ? -(value + (t.brokerage || 0)) : t.type === "sell" ? value - (t.brokerage || 0) : (t.cash_amount || 0);
      var pillClass = t.type === "buy" ? "buy" : t.type === "sell" ? "sell" : "";
      return "<tr>" +
        '<td class="num muted">' + esc(t.id) + "</td>" +
        '<td class="nowrap">' + esc(fmtDate(t.created_at)) + "</td>" +
        '<td><span class="pill ' + pillClass + '">' + esc(t.type.charAt(0).toUpperCase() + t.type.slice(1)) + "</span></td>" +
        '<td class="code">' + esc(t.code || "") + "</td>" +
        "<td>" + esc(sleeveLabel(t.sleeve)) + "</td>" +
        '<td class="num">' + (t.quantity != null ? fmtQty(t.quantity) : "") + "</td>" +
        '<td class="num">' + (t.price != null ? fmtMoney(t.price) : "") + "</td>" +
        (showBrokerage ? '<td class="num">' + (t.brokerage ? fmtMoney(t.brokerage) : "") + "</td>" : "") +
        '<td class="num ' + signClass(cashEffect) + '">' + fmtMoney(cashEffect) + "</td>" +
        '<td class="nowrap">' + esc(t.trader_name || "") + "</td>" +
        (showNote ? "<td>" + esc(t.note || "") + "</td>" : "") + "</tr>";
    }).join("");
    $("#main").innerHTML =
      bandHtml("The record", "History", "Every trade the fund has made, newest first, with who placed it and when (Sydney time). Entries cannot be edited or deleted.", [
        ["Trades", String(hs.count)], ["Bought", whole(hs.bought)], ["Sold", whole(hs.sold)], ["Dividends", whole(hs.dividends)]],
        (isAdmin() ? '<button type="button" class="btn ghost" data-action="dividend-open">Record dividend</button>' : "") +
        '<button type="button" class="btn" data-action="export">' + ICON.down + "Download Excel</button>") +
      '<div class="chips" role="group" aria-label="Show">' + [["all", "All"], ["buy", "Buys"], ["sell", "Sells"], ["dividend", "Dividends"]].map(function (f) {
        return '<button type="button" class="chip' + (hf === f[0] ? " on" : "") + '" data-hist="' + f[0] + '">' + f[1] + "</button>";
      }).join("") + "</div>" +
      '<div class="card flush"><div class="table-scroll"><table><thead><tr><th class="num">No.</th><th>When</th><th>Type</th><th>Stock</th><th>Sleeve</th><th class="num">Quantity</th><th class="num">Price</th>' + (showBrokerage ? '<th class="num">Brokerage</th>' : "") + '<th class="num">Cash effect</th><th>By</th>' + (showNote ? "<th>Note</th>" : "") + '</tr></thead><tbody>' +
      (rows || '<tr><td colspan="11" class="empty">' + (hf === "all" ? "No trades yet." : "Nothing of that kind on the record yet.") + "</td></tr>") + "</tbody></table></div></div>" +
      "";
  }

  // "New" members are those who joined since the fund manager last opened the Members page on this device.
  var LS_SEEN = "lighthouse.members.seen";
  function membersSeenAt() {
    var v = null;
    try { v = localStorage.getItem(LS_SEEN); } catch (e) { /* storage unavailable */ }
    return v;
  }
  function markMembersSeen() { try { localStorage.setItem(LS_SEEN, new Date().toISOString()); } catch (e) { /* storage unavailable */ } }
  function unseenMembers() {
    var seen = membersSeenAt();
    if (!seen || !state.user) return [];
    return state.members.filter(function (m) { return m.id !== state.user.id && m.created_at > seen; });
  }

  function orgNode(m) {
    var fresh = state.freshIds[m.id];
    return '<div class="org-node' + (fresh ? " fresh" : "") + (m.role === "admin" ? " lead" : "") + '">' + avatarHtml({ name: m.display_name || m.email, avatar: m.avatar_url }) +
      '<span class="org-name">' + esc(m.display_name || m.email || "") + (m.id === state.user.id ? ' <span class="muted">(you)</span>' : "") + "</span>" +
      '<span class="org-title">' + esc(m.title || roleLabel(m.role)) + "</span>" +
      '<span class="muted small">Joined ' + esc(fmtDay(m.created_at)) + "</span>" +
      (fresh ? '<span class="pill new">New</span>' : "") + "</div>";
  }

  // A tree: fund managers at the top, then one branch for each other role.
  function orgChart() {
    var of = function (role) { return state.members.filter(function (m) { return m.role === role; }); };
    var branches = [["trader", "Analysts", "Research stocks and place approved trades"], ["viewer", "Viewers", "Can see the fund and its history"]];
    return '<div class="org">' +
      '<div class="org-root">' + (of("admin").map(orgNode).join("") || '<div class="org-empty muted small">No fund manager</div>') + "</div>" +
      '<div class="org-branches">' + branches.map(function (b) {
        var people = of(b[0]);
        return '<div class="org-branch"><div class="org-group"><span class="org-group-name">' + b[1] + '<span class="org-count">' + people.length + '</span></span><span class="muted small">' + b[2] + "</span></div>" +
          '<div class="org-people">' + (people.map(orgNode).join("") || '<div class="org-empty muted small">Nobody yet</div>') + "</div></div>";
      }).join("") + "</div></div>";
  }
  function fmtDay(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric" });
  }

  function renderMembers() {
    if (!isAdmin()) { state.view = "portfolio"; return render(); }
    var freshCount = Object.keys(state.freshIds).length;
    var rows = state.members.map(function (m) {
      var me = m.id === state.user.id;
      var opts = ["admin", "trader", "viewer"].map(function (r) { return '<option value="' + r + '"' + (m.role === r ? " selected" : "") + ">" + roleLabel(r) + "</option>"; }).join("");
      return '<tr><td><span class="person">' + avatarHtml({ name: m.display_name || m.email, avatar: m.avatar_url }) + "<span><b>" + esc(m.display_name || "") + "</b>" + (me ? ' <span class="pill">You</span>' : "") + (state.freshIds[m.id] ? ' <span class="pill new">New</span>' : "") + '<span class="muted small">' + esc(m.email || "") + "</span></span></span></td>" +
        '<td><input class="title-input" type="text" maxlength="40" placeholder="' + esc(roleLabel(m.role)) + '" value="' + esc(m.title || "") + '" data-title-for="' + esc(m.id) + '" aria-label="Job title for ' + esc(m.display_name || m.email || "") + '"></td>' +
        '<td class="nowrap muted">' + esc(fmtDay(m.created_at)) + "</td>" +
        '<td class="nowrap">' + (m.charter_agreed_at ? '<span class="pill ok">Signed ' + esc(fmtDay(m.charter_agreed_at)) + "</span>" : '<span class="pill">Not signed</span>') + "</td>" +
        '<td class="num">' + (me ? '<span class="pill ok">Fund Manager</span>' : '<span class="row-links"><select class="role-select" data-member="' + esc(m.id) + '" aria-label="Role for ' + esc(m.email || "") + '">' + opts + '</select><button type="button" class="btn quiet danger small-btn" data-remove-member="' + esc(m.id) + '">Remove</button></span>') + "</td></tr>";
    }).join("");
    $("#main").innerHTML =
      bandHtml("The team", "Members", "Everyone who has created an account. New accounts start as viewers. Only fund managers can see this page.", [
        ["Members", String(state.members.length)],
        ["Analysts", String(state.members.filter(function (m) { return m.role === "trader"; }).length)],
        ["Viewers", String(state.members.filter(function (m) { return m.role === "viewer"; }).length)],
        ["Charter signed", String(state.members.filter(function (m) { return m.charter_agreed_at; }).length)]]) +
      (freshCount ? '<p class="notice">' + freshCount + (freshCount === 1 ? " person has" : " people have") + " joined since you last looked. They are marked New below.</p>" : "") +
      '<div class="members-top"><div class="card"><h2>Org chart</h2>' + orgChart() + "</div>" + codeCardHtml() + "</div>" +
      '<div class="card flush"><div class="card-head"><h2>Roles and job titles</h2></div><div class="table-scroll"><table><thead><tr><th>Member</th><th>Job title</th><th>Joined</th><th>Charter</th><th class="num">Access</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="empty">No members yet.</td></tr>') + "</tbody></table></div></div>" +
      '<p class="muted small" style="margin-top:12px">Access decides what someone can do on the site. The job title is free text for the org chart, for example Head of Research or Risk Officer. Your own access is locked so the fund can never be left without a fund manager. To hand over, make someone else a fund manager and ask them to change yours. Other people appear here once they create an account on the sign-in page.</p>';
  }

  function renderProfile() {
    if (!state.user) { state.view = "signin"; return render(); }
    var u = state.user;
    var mine = state.trades.filter(function (t) { return (t.type === "buy" || t.type === "sell") && (t.created_by ? t.created_by === u.id : t.trader_name === u.name); });
    var mineRows = mine.slice(-5).reverse().map(function (t) {
      return '<li><span class="pill ' + t.type + '">' + (t.type === "buy" ? "Buy" : "Sell") + "</span><span><b>" + fmtQty(t.quantity) + " " + esc(t.code) + "</b> at " + fmtMoney(t.price) + '<br><span class="muted small">' + esc(fmtDate(t.created_at)) + "</span></span></li>";
    }).join("");
    $("#main").innerHTML =
      bandHtml(roleLabel(u.role), u.name || "Your profile", "Your name is recorded against every trade you place.", [
        ["Trades you placed", String(mine.length)], ["Last trade", mine.length ? esc(fmtDay(mine[mine.length - 1].created_at)) : "None yet"]], "", avatarHtml(u, "xl band-avatar")) +
      '<div class="profile-grid">' +
        '<div class="stack"><div class="card"><h2>Photo and name</h2>' +
          '<div class="photo-row">' + avatarHtml(u, "xl") +
            '<div><input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden>' +
            '<button type="button" class="btn secondary" data-action="pick-avatar">' + (safeAvatar(u.avatar) ? "Change photo" : "Upload a photo") + '</button> ' +
            (safeAvatar(u.avatar) ? '<button type="button" class="btn quiet" data-action="remove-avatar">Remove</button>' : "") +
            "</div></div>" +
          '<form id="name-form" novalidate><div class="field"><label for="p-name">Display name</label><input id="p-name" type="text" maxlength="60" autocomplete="name" value="' + esc(u.name) + '"></div>' +
          '<div class="form-msg" id="name-msg"></div><button type="submit" class="btn">Save name</button></form></div>' +
          '<div class="card"><h2>Your recent trades</h2>' + (mineRows ? '<ul class="recent">' + mineRows + "</ul>" : '<p class="muted small" style="margin:0">You have not placed a trade yet.</p>') + "</div></div>" +
        '<div class="stack">' +
          '<div class="card"><h2>Email</h2><form id="email-form" novalidate><div class="field"><label for="p-email">Email address</label><input id="p-email" type="email" autocomplete="email" value="' + esc(u.email) + '"></div>' +
            '<div class="form-msg" id="email-msg"></div><button type="submit" class="btn secondary">Change email</button></form></div>' +
          '<div class="card"><h2>Password</h2><form id="password-form" novalidate>' +
            '<div class="field"><label for="p-pass">New password</label><input id="p-pass" type="password" autocomplete="new-password" minlength="8"></div>' +
            '<div class="field"><label for="p-pass2">Type it again</label><input id="p-pass2" type="password" autocomplete="new-password" minlength="8"></div>' +
            '<div class="form-msg" id="password-msg"></div><button type="submit" class="btn secondary">Change password</button></form></div>' +
        "</div>" +
      "</div>" +
      '<p class="muted small" style="margin-top:16px">Role: ' + esc(roleLabel(u.role)) + ". Only a fund manager can change roles.</p>";
  }

  function renderSignin() {
    var form = DEMO
      ? "<p>Sign-in is switched off in demo mode. You are using the app as the fund manager.</p>"
      : '<form id="auth-form" novalidate>' +
          '<div class="field" id="name-field"' + (signupMode ? "" : " hidden") + '><label for="name">Your name</label><input id="name" type="text" autocomplete="name" maxlength="60"></div>' +
          '<div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email" required></div>' +
          '<div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="' + (signupMode ? "new-password" : "current-password") + '" minlength="8" required></div>' +
          (signupMode ? '<div class="charter-box"><div class="eyebrow">Fund charter</div>' + charterBox("agree", "I have read and agree to the Lighthouse Fund Charter.") + "</div>" : "") +
          '<div id="auth-msg"></div>' +
          '<button type="submit" class="btn block" id="auth-submit">' + (signupMode ? "Create account" : "Sign in") + "</button>" +
        "</form>" +
        '<p class="auth-switch">' + (signupMode ? "Already have an account?" : "New to the fund?") + ' <button type="button" class="link" data-action="toggle-signup">' + (signupMode ? "Sign in" : "Create an account") + "</button></p>";
    $("#main").innerHTML =
      '<div class="auth-shell">' +
        '<div class="auth-art"><div class="auth-art-inner">' +
          '<div class="eyebrow light">An AFSA initiative · Macquarie University</div>' +
          "<h1>A student-run fund, managed like the real thing.</h1>" +
          "<p>Pitch a stock, win the competition, and manage a live simulated portfolio across the ASX 300.</p>" +
          '<ul class="auth-points"><li>' + ICON.ok + "Simulated " + fmtMoney(CFG.STARTING_CAPITAL).replace(/\.00$/, "") + " portfolio</li><li>" + ICON.ok + "Every trade on a permanent record</li><li>" + ICON.ok + "Benchmarked against the ASX 300</li></ul>" +
        "</div></div>" +
        '<div class="auth-panel"><div class="auth-box">' +
          '<img class="auth-logo" src="img/logo-full-dark.png" alt="The Lighthouse Fund, Macquarie University" width="230" height="202">' +
          "<h2>" + (signupMode ? "Create your account" : "Sign in") + "</h2>" +
          '<p class="muted small">' + (signupMode ? "New accounts can view the fund. The fund manager can then make you an analyst." : "Welcome back. Sign in to manage the fund.") + "</p>" +
          form +
          '<p class="auth-back"><button type="button" class="link" data-view="home">Back to the home page</button>' +
            (DEMO ? "" : ' <span aria-hidden="true">·</span> <button type="button" class="link" data-action="enter-demo">Try demo mode</button>') + "</p>" +
        "</div></div>" +
      "</div>";
  }

  function render() {
    if (locked() && state.view !== "home" && state.view !== "companies" && state.view !== "signin") state.view = "signin";
    renderChrome();
    setTimeout(playMotion, 0);
    if (state.view === "home") renderHome();
    else if (state.view === "trade") renderTrade();
    else if (state.view === "companies") renderCompanies();
    else if (state.view === "history") renderHistory();
    else if (state.view === "report") renderReport();
    else if (state.view === "members") renderMembers();
    else if (state.view === "profile") renderProfile();
    else if (state.view === "signin") renderSignin();
    else renderPortfolio();
    renderCharterGate();
    tickCode();
  }

  function go(view) {
    state.navigated = true;
    state.animateNext = true;
    state.view = view;
    if (view === "members" && isAdmin() && !DEMO) {
      store.listMembers().then(function (m) {
        state.members = m;
        state.freshIds = {};
        unseenMembers().forEach(function (x) { state.freshIds[x.id] = true; });
        markMembersSeen();
        if (state.view === "members") render();
      }).catch(function (e) { toast(e.message); });
    }
    render();
    window.scrollTo(0, 0);
    $("#main").focus({ preventScroll: true });
  }

  // ---------- actions ----------
  function refreshAll() {
    return Promise.all([
      loadPrices(),
      // The fund's record is only fetched for people who are signed in.
      locked() ? (state.trades = [], state.orders = [], state.snapshots = [], null) : store.listTrades().then(function (t) { state.trades = t; }).catch(function (e) { toast("Could not load trades: " + e.message); }),
      locked() ? null : store.listOrders().then(function (o) { state.orders = o; }).catch(function () { state.orders = []; }),
      locked() ? null : store.listSnapshots().then(function (h) { state.snapshots = h; }).catch(function () { state.snapshots = []; }),
      locked() ? (state.proposals = [], state.levels = {}, null) : store.listProposals().then(function (l) { state.proposals = l; }).catch(function () { state.proposals = []; state.proposalsOn = false; }),
      locked() ? null : store.listLevels().then(function (m) { state.levels = m; }).catch(function () { state.levels = {}; state.levelsOn = false; }),
      locked() ? null : store.getReport(sydneyToday().slice(0, 7)).then(function (r) { state.report = r; }).catch(function () { state.report = { month: sydneyToday().slice(0, 7), comment: "" }; }),
      // The fund manager's member list, so the Members tab can flag new sign-ups.
      isAdmin() && !DEMO ? store.listMembers().then(function (m) {
        state.members = m;
        if (!membersSeenAt()) markMembersSeen();
      }).catch(function () { /* shown when the Members page is opened */ }) : null
    ]).then(fillDueOrders).then(function () {
      if (state.view === "signin" && state.user) state.view = "portfolio";
      // Members land on the portfolio. Visitors land on the home page.
      if (state.view === "home" && state.user && !state.navigated) state.view = "portfolio";
      // Avoid wiping anything the person is in the middle of typing.
      if (state.view === "trade" && canTrade() && $("#ticket")) {
        renderChrome();
        $("#universe").innerHTML = universeRows();
        if (state.order.code) renderCalc();
        renderOpenOrders();
        renderProposals();
      } else if (state.view === "companies" && $("#companies")) {
        renderChrome();
        $("#sector-tiles").innerHTML = sectorTilesHtml();
        renderCompanyRows();
      } else if ((state.view === "profile" && $("#name-form")) || (state.view === "signin" && $("#auth-form"))) {
        renderChrome();
      } else {
        render();
      }
    });
  }

  function clearTicket() {
    state.order.qty = "";
    state.order.amount = "";
    state.order.limit = "";
    state.order.approval = "";
    state.order.rationale = "";
  }

  // Places an order that has already passed the checks. It becomes a trade straight away, or
  // waits as an open order when the market is closed or the limit has not been reached.
  // Resolves with a short message saying what happened.
  function executeOrder(o, opts) {
    opts = opts || {};
    var info = state.prices[o.code];
    var pf = computePortfolio(state.trades);
    var n = orderNumbers(o, info);
    var qty = n.qty;
    var held = pf.positions.filter(function (p) { return p.code === info.code; })[0];
    var sleeve = info.code === CFG.ETF_CODE ? "index" : o.side === "sell" && held ? held.sleeve : o.sleeve;
    var verb = o.side === "buy" ? "Buy" : "Sell";
    if (n.waits) {
      return store.placeOrder({ side: o.side, code: info.code, sleeve: sleeve, quantity: qty, limit_price: n.queued ? n.price : n.limit, kind: n.queued ? "market" : "limit",
        approval: opts.approval || "", trader_name: opts.trader_name, note: opts.note, placed_low: tradedToday(info) ? info.day_low : 0, placed_high: tradedToday(info) ? info.day_high : 0 })
        .then(function () { return store.listOrders(); })
        .then(function (list) {
          state.orders = list;
          return n.queued ? "Order queued for the open: " + verb.toLowerCase() + " " + fmtQty(qty) + " " + info.code : "Limit order placed: " + verb.toLowerCase() + " " + fmtQty(qty) + " " + info.code + " at " + fmtMoney(n.limit);
        });
    }
    return store.addTrade({ type: o.side, code: info.code, sleeve: sleeve, quantity: qty, price: n.price, note: opts.note || "", approval: opts.approval || "", trader_name: opts.trader_name })
      .then(function () { return store.listTrades(); })
      .then(function (t) { state.trades = t; return verb + " order filled: " + fmtQty(qty) + " " + info.code + " at " + fmtPrice(n.price); });
  }

  // The words for the box that asks someone to confirm an order.
  function orderConfirmText(o) {
    var info = state.prices[o.code], n = orderNumbers(o, info), verb = o.side === "buy" ? "Buy" : "Sell";
    if (n.pending) return { title: "Place this limit order?", body: verb + " " + fmtQty(n.qty) + " " + info.code + " at " + fmtMoney(n.limit) + " or " + (o.side === "buy" ? "lower" : "higher") + ". It waits until the price gets there while the market is open, and can be cancelled before then.", ok: "Place order" };
    if (n.queued) return { title: "Queue this order for the open?", body: verb + " " + fmtQty(n.qty) + " " + info.code + ". The market is closed, so it fills at the price when trading starts again. That may differ from the " + fmtPrice(n.price) + " shown now. You can cancel it before then.", ok: "Queue order" };
    return { title: verb + " " + fmtQty(n.qty) + " " + info.code + " at " + fmtPrice(n.price) + "?", body: "This is recorded permanently and cannot be undone.", ok: verb + " " + info.code };
  }

  function submitOrder() {
    var o = state.order;
    var info = state.prices[o.code];
    var pf = computePortfolio(state.trades);
    var issues = validateOrder(o, pf);
    if (issues.length) { renderCalc(); return; }
    if (needsProposal()) return submitProposal();
    var text = orderConfirmText(o);
    confirmBox(text.title, text.body, text.ok).then(function (ok) {
      if (!ok) return;
      state.busy = true;
      renderCalc();
      executeOrder(o, { approval: needsCode() ? codeFromPhrase(o.approval) : "" }).then(function (msg) {
        state.busy = false;
        clearTicket();
        toast(msg);
        var stillHeld = computePortfolio(state.trades).positions.some(function (p) { return p.code === state.order.code; });
        if (state.order.side === "sell" && !stillHeld) state.order.code = null;
        render();
      }).catch(function (e) { state.busy = false; renderCalc(); toast("Order not placed: " + e.message); });
    });
  }

  // ---------- trade proposals ----------
  // An analyst sends a trade with a short case. The fund manager approves or rejects it.
  function needsProposal() { return canTrade() && !isAdmin() && state.proposalsOn; }
  function pendingProposals() { return state.proposals.filter(function (x) { return x.status === "pending"; }); }
  function proposalOrder(x) {
    return { code: x.code, side: x.side, qtyMode: "shares", qty: String(x.quantity), amount: "", type: x.order_type === "limit" ? "limit" : "market", limit: x.limit_price ? String(x.limit_price) : "", sleeve: x.sleeve };
  }
  function reloadProposals() { return store.listProposals().then(function (list) { state.proposals = list; }); }
  function submitProposal() {
    var o = state.order, info = state.prices[o.code], n = orderNumbers(o, info);
    var verb = o.side === "buy" ? "buy" : "sell";
    var held = computePortfolio(state.trades).positions.filter(function (p) { return p.code === info.code; })[0];
    var sleeve = info.code === CFG.ETF_CODE ? "index" : o.side === "sell" && held ? held.sleeve : o.sleeve;
    state.busy = true;
    renderCalc();
    store.addProposal({ side: o.side, code: info.code, sleeve: sleeve, quantity: n.qty, order_type: n.isLimit ? "limit" : "market", limit_price: n.isLimit ? n.limit : null, ref_price: info.price, rationale: o.rationale.trim().slice(0, 600) })
      .then(reloadProposals)
      .then(function () { state.busy = false; clearTicket(); toast("Sent to the Fund Manager: " + verb + " " + fmtQty(n.qty) + " " + info.code); render(); })
      .catch(function (e) { state.busy = false; renderCalc(); toast("Not sent: " + e.message); });
  }
  function proposalLine(x) {
    return (x.side === "buy" ? "Buy " : "Sell ") + fmtQty(x.quantity) + " " + x.code + (x.order_type === "limit" && x.limit_price ? " at a limit of " + fmtMoney(x.limit_price) : " at market");
  }
  function renderProposals() {
    var el = $("#proposals");
    if (!el) return;
    if (!state.proposalsOn || !canTrade()) { el.innerHTML = ""; return; }
    var admin = isAdmin();
    var list = admin ? pendingProposals() : state.proposals.filter(function (x) { return state.user && x.created_by === state.user.id; }).slice(-6).reverse();
    if (!list.length) {
      el.innerHTML = admin ? '<div class="card proposal-empty"><h2>Trade proposals</h2><p class="muted" style="margin:0">Nothing is waiting for you. When an analyst proposes a trade it appears here for you to approve or reject.</p></div>' : "";
      return;
    }
    el.innerHTML = '<div class="card flush"><div class="card-head"><h2>' + (admin ? "Proposals waiting for you" : "Your proposals") + '</h2><span class="muted small">' +
      (admin ? "Approving places the order at the current price. Rejecting records nothing." : "The Fund Manager approves or rejects each one.") + "</span></div>" +
      '<div class="proposal-list">' + list.map(function (x) {
        var info = state.prices[x.code], est = info && info.price > 0 ? x.quantity * (x.order_type === "limit" && x.limit_price ? x.limit_price : quote(info, x.side)) : 0;
        var status = x.status === "pending" ? '<span class="pill">Waiting</span>' : x.status === "approved" ? '<span class="pill ok">Approved</span>' : '<span class="pill bad">Rejected</span>';
        return '<div class="proposal"><div class="proposal-main">' +
          '<div class="proposal-top"><span class="pill ' + x.side + '">' + (x.side === "buy" ? "Buy" : "Sell") + '</span><b>' + esc(proposalLine(x).replace(/^(Buy|Sell) /, "")) + "</b>" +
            (est ? '<span class="muted small">about ' + fmtMoney(est) + " · " + esc(sleeveLabel(x.sleeve)) + "</span>" : "") + (admin ? "" : status) + "</div>" +
          '<p class="proposal-case">' + esc(x.rationale || "") + "</p>" +
          '<div class="muted small">' + esc(x.trader_name || "") + ", " + esc(fmtDate(x.created_at)) + (x.ref_price > 0 ? " · " + esc(x.code) + " was " + fmtMoney(x.ref_price) + (info && info.price > 0 ? ", now " + fmtMoney(info.price) : "") : "") + "</div></div>" +
          (admin ? '<div class="proposal-actions"><button type="button" class="btn buy small-btn" data-approve="' + esc(x.id) + '">Approve</button><button type="button" class="btn secondary small-btn danger" data-reject="' + esc(x.id) + '">Reject</button></div>' : "") + "</div>";
      }).join("") + "</div></div>";
  }
  function approveProposal(id) {
    var x = state.proposals.filter(function (r) { return String(r.id) === String(id) && r.status === "pending"; })[0];
    if (!x) return;
    var o = proposalOrder(x), info = state.prices[x.code];
    if (!info || !(info.price > 0)) return toast("No price is available for " + x.code + " right now.");
    var issues = validateOrder(o, computePortfolio(state.trades));
    if (issues.length) return toast("Cannot approve: " + issues[0]);
    var text = orderConfirmText(o);
    confirmBox("Approve: " + proposalLine(x).toLowerCase() + "?", "Proposed by " + (x.trader_name || "an analyst") + ". " + text.body, "Approve").then(function (ok) {
      if (!ok) return;
      executeOrder(o, { trader_name: x.trader_name, note: ("Proposed by " + (x.trader_name || "an analyst") + ", approved by " + state.user.name + ": " + (x.rationale || "")).slice(0, 240) })
        .then(function (msg) { return store.decideProposal(x.id, "approved").then(function () { return msg; }); })
        .then(function (msg) { return reloadProposals().then(function () { toast("Approved. " + msg); render(); }); })
        .catch(function (e) { toast("Not approved: " + e.message); });
    });
  }
  function rejectProposal(id) {
    var x = state.proposals.filter(function (r) { return String(r.id) === String(id) && r.status === "pending"; })[0];
    if (!x) return;
    confirmBox("Reject this proposal?", proposalLine(x) + ", proposed by " + (x.trader_name || "an analyst") + ". Nothing is recorded as a trade.", "Reject", true).then(function (ok) {
      if (!ok) return;
      store.decideProposal(x.id, "rejected").then(reloadProposals).then(function () { toast("Proposal rejected"); render(); }).catch(function (e) { toast("Not rejected: " + e.message); });
    });
  }

  // A styled yes or no box in place of the browser's own pop-up. Resolves true or false.
  function confirmBox(title, body, okLabel, danger) {
    return new Promise(function (resolve) {
      var old = $("#confirm-modal"); if (old) old.remove();
      var el = document.createElement("div");
      el.className = "modal";
      el.id = "confirm-modal";
      el.innerHTML = '<div class="modal-box confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">' +
        '<h2 id="confirm-title">' + esc(title) + "</h2>" + (body ? '<p class="muted">' + esc(body) + "</p>" : "") +
        '<div class="modal-actions"><button type="button" class="btn secondary" data-confirm="no">Cancel</button>' +
        '<button type="button" class="btn' + (danger ? " danger-solid" : "") + '" data-confirm="yes">' + esc(okLabel || "Confirm") + "</button></div></div>";
      var done = function (v) { document.removeEventListener("keydown", onKey); el.remove(); resolve(v); };
      var onKey = function (e) { if (e.key === "Escape") done(false); };
      el.addEventListener("click", function (e) {
        var b = e.target.closest("[data-confirm]");
        if (b) { e.stopPropagation(); done(b.dataset.confirm === "yes"); }
        else if (e.target === el) done(false);
      });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(el);
      el.querySelector('[data-confirm="yes"]').focus();
    });
  }

  // True when a price is from today's session (sample prices in demo mode count as live).
  function liveToday(info) { return tradedToday(info) || (DEMO && state.pricesAreSample && !!info); }
  function fillsNow(info) { return marketOpen() && liveToday(info); }
  function sydneyToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date()); }
  // True when the feed's low and high are from today's session, not left over from the last one.
  function tradedToday(info) { return !!info && info.trade_date === sydneyToday(); }

  // The price a waiting limit order fills at now, or 0 if it has not been reached.
  // It fills at the current price when that is through the limit. Otherwise, if the day's
  // low (for a buy) or high (for a sell) touched the limit after the order was placed, it
  // fills at the limit price, as it would have on the market.
  function fillPriceFor(o, info) {
    if (!info || !(info.price > 0)) return 0;
    var buy = o.side === "buy";
    // A market order that was placed while the market was closed fills once it is trading again.
    if (o.kind === "market") return fillsNow(info) ? quote(info, o.side) : 0;
    if (!liveToday(info)) return 0;
    if (fillsNow(info) && (buy ? info.price <= o.limit_price : info.price >= o.limit_price)) return info.price;
    if (!tradedToday(info)) return 0;
    var extreme = buy ? info.day_low : info.day_high;
    if (!(extreme > 0) || (buy ? extreme > o.limit_price : extreme < o.limit_price)) return 0;
    var now = sydneyWallClock(new Date().toISOString()), placed = sydneyWallClock(o.created_at);
    if (!now || !placed) return 0;
    var open = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0);
    // Placed before today's open: the whole of today's range happened after the order.
    if (placed.getTime() < open) return o.limit_price;
    // Placed during today's session: only a new low or high since then counts.
    var ref = buy ? o.placed_low : o.placed_high;
    if (ref > 0 && (buy ? extreme < ref : extreme > ref)) return o.limit_price;
    return 0;
  }

  // Fills any open limit order whose price has been reached. Runs after each price refresh.
  var filling = false;
  function fillDueOrders() {
    if (filling || !canTrade() || !state.orders.length) return Promise.resolve();
    // The real record is never filled from sample prices.
    if (state.pricesAreSample && !DEMO) return Promise.resolve();
    var due = state.orders.filter(function (o) {
      o.fillAt = fillPriceFor(o, state.prices[o.code]);
      return o.fillAt > 0;
    });
    if (!due.length) return Promise.resolve();
    filling = true;
    var filled = [];
    return due.reduce(function (chain, o) {
      return chain.then(function () {
        var price = o.fillAt;
        return store.fillOrder(o.id, price).then(function () { filled.push((o.side === "buy" ? "bought " : "sold ") + fmtQty(o.quantity) + " " + o.code + " at " + fmtPrice(price)); }, function () { /* stays open, tried again next refresh */ });
      });
    }, Promise.resolve()).then(function () {
      return Promise.all([store.listTrades(), store.listOrders()]);
    }).then(function (r) {
      filling = false;
      state.trades = r[0];
      state.orders = r[1];
      if (filled.length) toast("Order filled: " + filled.join(", "));
    }).catch(function () { filling = false; });
  }

  // A Date whose UTC fields hold the Sydney wall-clock time, which is what Excel should show.
  function sydneyWallClock(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return null;
    var parts = {};
    new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
      .formatToParts(d).forEach(function (p) { parts[p.type] = Number(p.value); });
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second));
  }

  function exportExcel() {
    var cash = 0;
    var charged = state.trades.some(function (t) { return t.brokerage > 0; });
    var dropBrokerage = function (row) { if (!charged) row.splice(9, 1); return row; };
    var tradeRows = state.trades.map(function (t) {
      var value = (t.quantity || 0) * (t.price || 0);
      var effect = t.type === "buy" ? -(value + (t.brokerage || 0)) : t.type === "sell" ? value - (t.brokerage || 0) : (t.cash_amount || 0);
      cash += effect;
      var info = state.prices[t.code] || {};
      return dropBrokerage([t.id, sydneyWallClock(t.created_at), t.type.charAt(0).toUpperCase() + t.type.slice(1), t.code || "", info.name || "", sleeveLabel(t.sleeve),
        t.quantity, t.price, t.quantity != null ? round2(value) : null, t.brokerage || 0, round2(effect), round2(cash), t.trader_name || "", t.note || ""]);
    });
    var pf = computePortfolio(state.trades);
    var holdingRows = pf.positions.map(function (p) {
      return [p.code, p.name, p.sector, sleeveLabel(p.sleeve), p.qty, round2(p.qty > 0 ? p.cost / p.qty : 0), p.price, round2(p.value), round2(p.gain), Math.round(p.weight * 10000) / 100];
    });
    holdingRows.push(["Cash", "", "", "", null, null, null, round2(pf.cash), null, pf.total > 0 ? Math.round(pf.cash / pf.total * 10000) / 100 : 0]);
    holdingRows.push(["Fund total", "", "", "", null, null, null, round2(pf.total), round2(pf.total - CFG.STARTING_CAPITAL), 100]);

    var blob = window.XlsxLite.build([
      { name: "Trades", columns: dropBrokerage([
          { header: "No.", width: 7, type: "number" }, { header: "Date and time (Sydney)", width: 24, type: "datetime" }, { header: "Type", width: 10 },
          { header: "Code", width: 8 }, { header: "Company", width: 34 }, { header: "Sleeve", width: 13 }, { header: "Quantity", width: 10, type: "number" },
          { header: "Price", width: 11, type: "money" }, { header: "Trade value", width: 14, type: "money" }, { header: "Brokerage", width: 11, type: "money" },
          { header: "Cash effect", width: 14, type: "money" }, { header: "Cash balance", width: 14, type: "money" }, { header: "Placed by", width: 22 }, { header: "Note", width: 40 }
        ]), rows: tradeRows },
      { name: "Holdings", columns: [
          { header: "Code", width: 12 }, { header: "Company", width: 34 }, { header: "Sector", width: 24 }, { header: "Sleeve", width: 13 }, { header: "Quantity", width: 10, type: "number" },
          { header: "Average cost", width: 13, type: "money" }, { header: "Price", width: 11, type: "money" }, { header: "Value", width: 14, type: "money" },
          { header: "Gain or loss", width: 14, type: "money" }, { header: "Weight %", width: 10, type: "number" }
        ], rows: holdingRows }
    ]);
    var stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "lighthouse-fund-trades-" + stamp + ".xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast("Excel file downloaded");
  }

  var signupMode = false;
  function handleAuth(e) {
    e.preventDefault();
    var email = $("#email").value.trim(), password = $("#password").value, name = $("#name").value.trim();
    var msg = $("#auth-msg");
    if (!email || password.length < 8 || (signupMode && !name)) {
      msg.innerHTML = '<ul class="issues"><li>Enter your email' + (signupMode ? ", your name" : "") + " and a password of at least 8 characters.</li></ul>";
      return;
    }
    if (signupMode && !$("#agree").checked) {
      msg.innerHTML = '<ul class="issues"><li>Scroll to the end of the charter and tick the box to agree before creating an account.</li></ul>';
      return;
    }
    $("#auth-submit").disabled = true;
    var p = signupMode ? store.signUp(email, password, name) : store.signIn(email, password);
    p.then(function (data) {
      if (signupMode && data && !data.session) {
        msg.innerHTML = '<p class="notice">Check your email and click the link to confirm your account, then sign in here.</p>';
        $("#auth-submit").disabled = false;
      }
    }).catch(function (err) {
      msg.innerHTML = '<ul class="issues"><li>' + esc(err.message) + "</li></ul>";
      $("#auth-submit").disabled = false;
    });
  }

  function formMsg(id, text, bad) {
    var el = $("#" + id);
    if (el) el.innerHTML = text ? '<p class="' + (bad ? "form-bad" : "form-good") + '">' + esc(text) + "</p>" : "";
  }

  function handleProfileForm(e) {
    e.preventDefault();
    var id = e.target.id;
    var btn = e.target.querySelector("button[type=submit]");
    var done = function (msgId, text, bad) { if (btn.isConnected) btn.disabled = false; formMsg(msgId, text, bad); };
    if (id === "name-form") {
      var name = $("#p-name").value.trim();
      if (!name) return formMsg("name-msg", "Enter a name.", true);
      btn.disabled = true;
      store.updateName(name).then(function () { state.user.name = name; renderChrome(); done("name-msg", "Name saved. New trades will show this name."); })
        .catch(function (err) { done("name-msg", err.message, true); });
    } else if (id === "email-form") {
      var email = $("#p-email").value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return formMsg("email-msg", "Enter a valid email address.", true);
      if (email === state.user.email) return formMsg("email-msg", "That is already your email address.", true);
      btn.disabled = true;
      store.updateEmail(email).then(function (changed) {
        if (changed) { state.user.email = email; }
        done("email-msg", changed ? "Email changed." : "Check " + email + " for a confirmation link. Your email changes once you click it.");
      }).catch(function (err) { done("email-msg", err.message, true); });
    } else if (id === "password-form") {
      var p1 = $("#p-pass").value, p2 = $("#p-pass2").value;
      if (p1.length < 8) return formMsg("password-msg", "Use at least 8 characters.", true);
      if (p1 !== p2) return formMsg("password-msg", "The two passwords do not match.", true);
      btn.disabled = true;
      store.updatePassword(p1).then(function () { $("#p-pass").value = ""; $("#p-pass2").value = ""; done("password-msg", "Password changed."); })
        .catch(function (err) { done("password-msg", err.message, true); });
    }
  }

  // Photo cropper: the member drags the photo and zooms it inside a circle, then it is saved as a small square.
  var CROP_VIEW = 260, CROP_OUT = 160;
  var crop = null;

  function openCropper(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast("Choose a JPG, PNG or WebP image.");
    if (file.size > 15 * 1024 * 1024) return toast("That image is too large. Choose one under 15 MB.");
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      closeCropper();
      var base = CROP_VIEW / Math.min(img.naturalWidth, img.naturalHeight);
      crop = { img: img, url: url, w: img.naturalWidth, h: img.naturalHeight, base: base, zoom: 1, x: 0, y: 0, drag: null };
      var el = document.createElement("div");
      el.className = "modal";
      el.id = "crop-modal";
      el.innerHTML =
        '<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="crop-title">' +
          '<h2 id="crop-title">Position your photo</h2>' +
          '<p class="muted small">Drag the photo to move it. Use the slider to zoom.</p>' +
          '<div class="crop-stage" id="crop-stage"><img id="crop-img" alt="" draggable="false"></div>' +
          '<div class="crop-zoom"><span class="small muted">Smaller</span><input id="crop-zoom" type="range" min="1" max="4" step="0.01" value="1" aria-label="Zoom"><span class="small muted">Bigger</span></div>' +
          '<div class="modal-actions"><button type="button" class="btn secondary" data-action="crop-cancel">Cancel</button><button type="button" class="btn" data-action="crop-save">Save photo</button></div>' +
        "</div>";
      document.body.appendChild(el);
      $("#crop-img").src = url;
      var stage = $("#crop-stage");
      stage.addEventListener("pointerdown", function (e) {
        crop.drag = { px: e.clientX, py: e.clientY, x: crop.x, y: crop.y };
        stage.setPointerCapture(e.pointerId);
        stage.classList.add("dragging");
      });
      stage.addEventListener("pointermove", function (e) {
        if (!crop || !crop.drag) return;
        crop.x = crop.drag.x + e.clientX - crop.drag.px;
        crop.y = crop.drag.y + e.clientY - crop.drag.py;
        drawCrop();
      });
      var stop = function () { if (crop) crop.drag = null; stage.classList.remove("dragging"); };
      stage.addEventListener("pointerup", stop);
      stage.addEventListener("pointercancel", stop);
      stage.addEventListener("wheel", function (e) {
        e.preventDefault();
        crop.zoom = Math.min(4, Math.max(1, crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
        $("#crop-zoom").value = crop.zoom;
        drawCrop();
      }, { passive: false });
      drawCrop();
      $("#crop-zoom").focus();
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast("That file could not be read as an image."); };
    img.src = url;
  }

  // Keeps the photo covering the whole circle, then positions it.
  function drawCrop() {
    var scale = crop.base * crop.zoom;
    var maxX = Math.max(0, (crop.w * scale - CROP_VIEW) / 2), maxY = Math.max(0, (crop.h * scale - CROP_VIEW) / 2);
    crop.x = Math.min(maxX, Math.max(-maxX, crop.x));
    crop.y = Math.min(maxY, Math.max(-maxY, crop.y));
    var el = $("#crop-img");
    el.style.width = crop.w * scale + "px";
    el.style.height = crop.h * scale + "px";
    el.style.transform = "translate(calc(-50% + " + crop.x + "px), calc(-50% + " + crop.y + "px))";
  }

  function croppedDataUrl() {
    var k = CROP_OUT / CROP_VIEW, scale = crop.base * crop.zoom * k;
    var canvas = document.createElement("canvas");
    canvas.width = canvas.height = CROP_OUT;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, CROP_OUT, CROP_OUT);
    ctx.imageSmoothingQuality = "high";
    var dw = crop.w * scale, dh = crop.h * scale;
    ctx.drawImage(crop.img, CROP_OUT / 2 + crop.x * k - dw / 2, CROP_OUT / 2 + crop.y * k - dh / 2, dw, dh);
    return canvas.toDataURL("image/jpeg", 0.88);
  }

  function closeCropper() {
    var el = $("#crop-modal");
    if (el) el.remove();
    if (crop) URL.revokeObjectURL(crop.url);
    crop = null;
    var input = $("#avatar-file");
    if (input) input.value = "";
  }

  function saveAvatar(dataUrl) {
    return store.updateAvatar(dataUrl).then(function () {
      state.user.avatar = dataUrl;
      render();
      toast(dataUrl ? "Photo updated" : "Photo removed");
    }).catch(function (err) { toast("Photo not saved: " + err.message); });
  }

  // ---------- events ----------
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-view],[data-action],[data-side],[data-code],[data-trade],[data-qtymode],[data-otype],[data-cancel-order],[data-remove-member],[data-hist],[data-sector],[data-approve],[data-reject],[data-fill-order],[data-levels]");
    if (!t) return;
    if (t.dataset.view) { e.preventDefault(); return go(t.dataset.view); }
    if (t.dataset.side) {
      state.order.side = t.dataset.side;
      if (state.order.side === "sell") {
        var heldNow = computePortfolio(state.trades).positions.some(function (p) { return p.code === state.order.code; });
        if (!heldNow) { state.order.code = null; clearTicket(); }
      }
      return renderTrade();
    }
    if (t.dataset.sector) {
      state.sector = t.dataset.sector === "*" || state.sector === t.dataset.sector ? "" : t.dataset.sector;
      $("#sector-tiles").innerHTML = sectorTilesHtml();
      if ($("#co-sector")) $("#co-sector").value = state.sector;
      return renderCompanyRows();
    }
    if (t.dataset.hist) { state.histFilter = t.dataset.hist; return renderHistory(); }
    if (t.dataset.qtymode) { state.order.qtyMode = t.dataset.qtymode; renderTicket(); var f1 = $(state.order.qtyMode === "amount" ? "#amount" : "#qty"); if (f1) f1.focus(); return; }
    if (t.dataset.otype) { state.order.type = t.dataset.otype; renderTicket(); var f2 = $("#limit"); if (f2) f2.focus(); return; }
    if (t.dataset.approve) return approveProposal(t.dataset.approve);
    if (t.dataset.reject) return rejectProposal(t.dataset.reject);
    if (t.dataset.levels) return openLevels(t.dataset.levels);
    if (t.dataset.fillOrder) {
      var fo = state.orders.filter(function (x) { return String(x.id) === t.dataset.fillOrder; })[0], fi = fo && state.prices[fo.code];
      if (!fo || !fi) return;
      var fp = fo.kind === "market" ? quote(fi, fo.side) : fo.limit_price;
      store.fillOrder(fo.id, fp).then(function () { return Promise.all([store.listTrades(), store.listOrders()]); })
        .then(function (r) { state.trades = r[0]; state.orders = r[1]; toast("Order filled: " + fo.code + " at " + fmtPrice(fp)); render(); })
        .catch(function (err) { toast("Not filled: " + err.message); });
      return;
    }
    if (t.dataset.cancelOrder) {
      var oid = Number(t.dataset.cancelOrder);
      confirmBox("Cancel this order?", "It is taken off the open orders list. Nothing is recorded as a trade.", "Cancel order", true).then(function (ok) {
        if (!ok) return;
        t.disabled = true;
        store.cancelOrder(oid).then(function () { return store.listOrders(); }).then(function (list) { state.orders = list; renderOpenOrders(); toast("Order cancelled"); })
          .catch(function (err) { t.disabled = false; toast("Not cancelled: " + err.message); });
      });
      return;
    }
    if (t.dataset.removeMember) {
      var rid = t.dataset.removeMember;
      var who = state.members.filter(function (m) { return m.id === rid; })[0] || {};
      confirmBox("Remove " + (who.display_name || who.email || "this account") + "?", "Their login is deleted and they lose access. Trades they placed stay on the record under their name. This cannot be undone.", "Remove account", true).then(function (ok) {
        if (!ok) return;
        t.disabled = true;
      store.removeMember(rid).then(function () {
        state.members = state.members.filter(function (m) { return m.id !== rid; });
        toast("Account removed");
        if (state.view === "members") render();
      }).catch(function (err) { t.disabled = false; toast("Not removed: " + err.message); });
      });
      return;
    }
    if (t.dataset.trade) {
      state.order.code = t.dataset.trade;
      state.order.side = "buy";
      clearTicket();
      state.search = "";
      return go("trade");
    }
    if (t.dataset.code) { selectStock(t.dataset.code); return; }
    var a = t.dataset.action;
    if (a === "submit-order") submitOrder();
    else if (a === "export") exportExcel();
    else if (a === "dividend-open") openDividend();
    else if (a === "dividend-cancel") closeDividend();
    else if (a === "levels-cancel") closeLevels();
    else if (a === "levels-save") saveLevels();
    else if (a === "print-report") window.print();
    else if (a === "comment-open") openComment();
    else if (a === "comment-cancel") closeComment();
    else if (a === "comment-save") saveComment();
    else if (a === "dividend-save") saveDividend();
    else if (a === "signout") store.signOut().then(function () { state.user = null; state.trades = []; state.orders = []; state.snapshots = []; state.orderCheck = null; state.view = "home"; render(); });
    else if (a === "pick-avatar") $("#avatar-file").click();
    else if (a === "remove-avatar") saveAvatar(null);
    else if (a === "crop-cancel") closeCropper();
    else if (a === "crop-save") { var dataUrl = croppedDataUrl(); closeCropper(); saveAvatar(dataUrl); }
    else if (a === "agree-charter") {
      t.disabled = true;
      store.agreeCharter().then(function () { state.user.needsCharter = false; render(); toast("Thanks. Your agreement has been recorded."); })
        .catch(function (err) { t.disabled = false; toast("Not saved: " + err.message); });
    }
    else if (a === "copy-code") {
      if (codeState.code && navigator.clipboard) navigator.clipboard.writeText(phraseFor(codeState.code).join(" ")).then(function () { toast("Codephrase copied"); }, function () { toast("Could not copy. Read it out instead."); });
    }
    else if (a === "enter-demo") setDemo(true);
    else if (a === "seed-demo") {
      confirmBox("Load the sample portfolio?", "This replaces the demo trades in this browser. The real fund is not touched.", "Load sample").then(function (ok) { if (ok) { demoStore.seed(); state.order.code = null; refreshAll().then(function () { go("portfolio"); toast("Sample portfolio loaded"); }); } });
    }
    else if (a === "exit-demo") setDemo(false);
    else if (a === "reset-demo") {
      confirmBox("Start the demo again?", "This clears all demo trades and goes back to " + fmtMoney(CFG.STARTING_CAPITAL) + " in cash.", "Start again", true).then(function (ok) { if (ok) { demoStore.reset(); refreshAll(); } });
    } else if (a === "toggle-signup") {
      signupMode = !signupMode;
      renderSignin();
    }
  });

  function selectStock(code) {
    state.order.code = code;
    var body = $("#universe");
    if (body) body.innerHTML = universeRows();
    renderTicket();
    var qty = $("#qty") || $("#amount");
    if (qty) qty.focus({ preventScroll: window.innerWidth > 860 });
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && crop) return closeCropper();
    if (e.key !== "Enter") return;
    var row = e.target.closest && e.target.closest("tr[data-code]");
    if (row) selectStock(row.dataset.code);
  });

  document.addEventListener("input", function (e) {
    var id = e.target.id;
    if (id === "crop-zoom") { crop.zoom = Number(e.target.value); drawCrop(); }
    else if (id === "search") { state.search = e.target.value; $("#universe").innerHTML = universeRows(); }
    else if (id === "co-search") { state.coSearch = e.target.value; renderCompanyRows(); }
    else if (id === "div-cents" || id === "div-code" || id === "div-cash" || id === "div-reinvest") renderDividendCalc();
    else if (id === "qty") { state.order.qty = e.target.value; renderCalc(); }
    else if (id === "amount") { state.order.amount = e.target.value; renderCalc(); }
    else if (id === "limit") { state.order.limit = e.target.value; renderCalc(); }
    else if (id === "rationale") { state.order.rationale = e.target.value; renderCalc(); }
    else if (id === "approval") { state.order.approval = e.target.value; renderCalc(); }
  });

  document.addEventListener("change", function (e) {
    if (e.target.id === "sleeve") { state.order.sleeve = e.target.value; renderCalc(); }
    else if (e.target.id === "charter-check") { $('[data-action="agree-charter"]').disabled = !e.target.checked; }
    else if (e.target.dataset.titleFor) {
      var mid = e.target.dataset.titleFor, title = e.target.value.trim();
      store.setTitle(mid, title).then(function () {
        state.members.forEach(function (m) { if (m.id === mid) m.title = title; });
        toast("Job title saved");
        if (state.view === "members") render();
      }).catch(function (err) { toast("Not saved: " + err.message); });
    }
    else if (e.target.id === "co-sector") { state.sector = e.target.value; $("#sector-tiles").innerHTML = sectorTilesHtml(); renderCompanyRows(); }
    else if (e.target.id === "avatar-file") {
      var file = e.target.files && e.target.files[0];
      if (file) openCropper(file);
    } else if (e.target.dataset.member) {
      var id = e.target.dataset.member, role = e.target.value;
      store.setRole(id, role).then(function () {
        state.members.forEach(function (m) { if (m.id === id) m.role = role; });
        toast("Role updated to " + roleLabel(role));
        if (state.view === "members") render();
      }).catch(function (err) { toast("Could not update role: " + err.message); go("members"); });
    }
  });

  document.addEventListener("submit", function (e) {
    if (e.target.id === "auth-form") handleAuth(e);
    else if (/^(name|email|password)-form$/.test(e.target.id)) handleProfileForm(e);
  });

  // ---------- start ----------
  store.init()
    .catch(function (e) { toast("Could not connect: " + e.message); })
    .then(refreshAll)
    .then(function () {
      setInterval(refreshAll, Math.max(30, CFG.PRICE_REFRESH_SECONDS) * 1000);
    });

  // Exposed for automated tests.
  window.__lighthouse = { state: state, computePortfolio: computePortfolio, validateOrder: validateOrder, parseCsv: parseCsv, go: go, render: render, refreshAll: refreshAll, fillPriceFor: fillPriceFor, phraseFor: phraseFor, codeFromPhrase: codeFromPhrase, attribution: attribution, riskStats: riskStats, orderNumbers: orderNumbers, quote: quote };
})();
