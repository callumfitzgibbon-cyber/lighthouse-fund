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
    view: "portfolio",
    user: null, // { id, email, name, role }
    trades: [],
    prices: {}, // code -> { code, name, sector, price, change_pct, market_cap, excluded }
    priceList: [],
    pricesUpdated: null,
    pricesAreSample: false,
    priceError: null,
    order: { code: null, side: "buy", qtyMode: "shares", qty: "", amount: "", type: "market", limit: "", sleeve: "competition", approval: "" },
    orders: [], // open limit orders
    ordersOff: false, // true until the database has the orders table
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
  function isAdmin() { return !!state.user && state.user.role === "admin"; }
  function brokerageFor(value) { return Math.max(CFG.BROKERAGE_FLAT, value * CFG.BROKERAGE_RATE); }
  function round2(n) { return Math.round(n * 100) / 100; }

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
    listTrades: function () {
      var list;
      try { list = JSON.parse(localStorage.getItem(LS_TRADES) || "null"); } catch (e) { list = null; }
      if (!list) {
        list = [{ id: 1, created_at: new Date().toISOString(), type: "deposit", code: null, sleeve: null, quantity: null, price: null, brokerage: 0, cash_amount: CFG.STARTING_CAPITAL, note: "Notional starting capital", trader_name: "System" }];
        try { localStorage.setItem(LS_TRADES, JSON.stringify(list)); } catch (e) { /* storage unavailable */ }
      }
      return Promise.resolve(list);
    },
    addTrade: function (t) {
      return demoStore.listTrades().then(function (list) {
        var value = t.quantity * t.price;
        var row = Object.assign({}, t, {
          id: list.length ? list[list.length - 1].id + 1 : 1,
          created_at: new Date().toISOString(),
          brokerage: round2(brokerageFor(value)),
          cash_amount: null,
          trader_name: state.user.name
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
      list.push({ id: list.length + 1, created_at: new Date().toISOString(), side: o.side, code: o.code, sleeve: o.sleeve, quantity: o.quantity, limit_price: o.limit_price, status: "open", trader_name: state.user.name, created_by: state.user.id });
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
      return demoStore.addTrade({ type: o.side, code: o.code, sleeve: o.sleeve, quantity: o.quantity, price: price, note: "Limit order at " + fmtMoney(o.limit_price) })
        .then(function () { demoStore.closeOrder(id, "filled"); });
    },
    signOut: function () { return Promise.resolve(); },
    listMembers: function () { return Promise.resolve([]); },
    reset: function () { try { localStorage.removeItem(LS_TRADES); localStorage.removeItem(LS_ORDERS); } catch (e) { /* ignore */ } },
    // Fills the demo with a realistic starting portfolio at today's prices.
    seed: function () {
      var day = 86400000, now = Date.now();
      var list = [{ id: 1, created_at: new Date(now - 12 * day).toISOString(), type: "deposit", code: null, sleeve: null, quantity: null, price: null, brokerage: 0, cash_amount: CFG.STARTING_CAPITAL, note: "Notional starting capital", trader_name: "System" }];
      var plan = [
        [CFG.ETF_CODE, "index", 45000, 11, "Core index holding"],
        ["JBH", "competition", 10000, 9, "Competition winner: retail earnings momentum"],
        ["XRO", "competition", 10000, 9, "Competition runner-up: subscriber growth"],
        ["COH", "competition", 10000, 9, "Competition third place: implant demand"],
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
    listTrades: function () {
      return sb.from("trades").select("*").order("id", { ascending: true }).then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data.map(function (t) {
          ["quantity", "price", "brokerage", "cash_amount"].forEach(function (k) { if (t[k] != null) t[k] = Number(t[k]); });
          return t;
        });
      });
    },
    addTrade: function (t) {
      return sb.from("trades").insert(Object.assign({
        type: t.type, code: t.code, sleeve: t.sleeve, quantity: t.quantity, price: t.price, note: t.note || null, trader_name: state.user.name
      }, t.approval ? { approval_code: t.approval } : {})).select().single().then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      });
    },
    listOrders: function () {
      return sb.from("orders").select("*").eq("status", "open").order("id", { ascending: true }).then(function (r) {
        if (r.error) { state.ordersOff = true; return []; }
        state.ordersOff = false;
        return r.data.map(function (o) { o.quantity = Number(o.quantity); o.limit_price = Number(o.limit_price); return o; });
      });
    },
    placeOrder: function (o) {
      return sb.from("orders").insert(Object.assign({
        side: o.side, code: o.code, sleeve: o.sleeve, quantity: o.quantity, limit_price: o.limit_price, trader_name: state.user.name
      }, o.approval ? { approval_code: o.approval } : {})).then(function (r) { if (r.error) throw new Error(r.error.message); });
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
    var marketable = isLimit && limit > 0 && (order.side === "buy" ? limit >= info.price : limit <= info.price);
    var pending = isLimit && !marketable;
    var price = pending ? limit : info.price;
    var qty = order.qtyMode === "amount" ? (price > 0 ? Math.floor(Number(order.amount) / price) : 0) : Number(order.qty);
    return { qty: qty || 0, price: price, limit: limit, isLimit: isLimit, pending: pending, marketable: marketable, value: (qty || 0) * price };
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
        if (weightAfter > CFG.MAX_STOCK_WEIGHT + 1e-9) issues.push("This would take " + info.code + " to " + fmtPct(weightAfter) + " of the fund. The limit is " + fmtPct(CFG.MAX_STOCK_WEIGHT, 0) + ".");
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
  function needsCode() { return !DEMO && canTrade() && !isAdmin(); }
  var codeState = { code: null, expires: 0, error: null, loading: false, tried: 0 };

  function codeCardHtml() {
    if (!isAdmin()) return "";
    return '<div class="card code-card" id="code-card">' + codeCardInner() + "</div>";
  }
  function codeCardInner() {
    var head = '<div class="eyebrow light">Trade approval code</div>';
    if (codeState.error) return head + '<p class="code-note">' + esc(codeState.error) + "</p>";
    if (!codeState.code) return head + '<div class="code-digits">··· ···</div><p class="code-note">Loading…</p>';
    var left = Math.max(0, Math.ceil((codeState.expires - Date.now()) / 1000));
    return head +
      '<div class="code-digits" aria-label="Approval code ' + codeState.code.split("").join(" ") + '">' + codeState.code.slice(0, 3) + " " + codeState.code.slice(3) + "</div>" +
      '<div class="code-bar"><span style="width:' + Math.min(100, left / 3) + '%"></span></div>' +
      '<div class="code-foot"><span>New code in ' + Math.floor(left / 60) + ":" + ("0" + (left % 60)).slice(-2) + '</span><button type="button" class="link" data-action="copy-code">Copy</button></div>' +
      '<p class="code-note">Only you can see this. Give it to an analyst to approve their trade.</p>';
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

  function renderChrome() {
    document.body.classList.toggle("auth-page", state.view === "signin");

    var tabs = [["portfolio", "Portfolio"], ["trade", "Trade"], ["companies", "Companies"], ["history", "History"]];
    if (isAdmin() && !DEMO) tabs.push(["members", "Members"]);
    var unseen = isAdmin() && state.view !== "members" ? unseenMembers().length : 0;
    $("#nav").innerHTML = tabs.map(function (t) {
      return '<button type="button" data-view="' + t[0] + '"' + (state.view === t[0] ? ' aria-current="page"' : "") + ">" + t[1] +
        (t[0] === "members" && unseen ? '<span class="count" title="New members">' + unseen + "</span>" : "") + "</button>";
    }).join("");

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
      '<span class="strip-gap"></span>' +
      '<span class="strip-item"><b>Fund</b> ' + fmtMoney(pf.total) + "</span>" +
      '<span class="strip-item"><b>Return</b> <span class="' + signClass(pf.ret) + '">' + (pf.ret > 0 ? "+" : "") + fmtPct(pf.ret, 2) + "</span></span>" +
      '<span class="strip-item hide-sm"><b>Cash</b> ' + fmtMoney(pf.cash) + "</span>";

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
    return '<svg class="donut" viewBox="0 0 42 42" role="img" aria-label="Allocation of the fund"><circle cx="21" cy="21" r="15.915" fill="none" stroke="#eceef1" stroke-width="5"/>' + rings + "</svg>";
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

    var rows = pf.positions.map(function (p) {
      var over = p.code !== CFG.ETF_CODE && p.weight > CFG.MAX_STOCK_WEIGHT;
      return "<tr>" +
        '<td><a class="code" href="' + infoUrl(p.code) + '" target="_blank" rel="noopener noreferrer">' + esc(p.code) + '</a><div class="muted small">' + esc(p.name) + "</div></td>" +
        "<td>" + esc(sleeveLabel(p.sleeve)) + "</td>" +
        '<td class="num">' + fmtQty(p.qty) + "</td>" +
        '<td class="num">' + (p.priced ? fmtMoney(p.price) : "No price") + "</td>" +
        '<td class="num">' + fmtMoney(p.value) + "</td>" +
        '<td class="num ' + signClass(p.gain) + '">' + fmtMoney(p.gain) + '<div class="small">' + fmtPct(p.gainPct) + "</div></td>" +
        '<td class="num">' + fmtPct(p.weight) + (over ? '<div><span class="pill bad">Over limit</span></div>' : "") + "</td>" +
        "</tr>";
    }).join("");

    var invested = pf.holdingsValue > 0;
    var checkList = [];
    if (CFG.MIN_ETF_VALUE > 0) checkList.push(["Index ETF at least " + fmtMoney(CFG.MIN_ETF_VALUE), invested ? pf.etfValue >= CFG.MIN_ETF_VALUE : null, fmtMoney(pf.etfValue)]);
    checkList.push(["No stock above " + fmtPct(CFG.MAX_STOCK_WEIGHT, 0), invested ? pf.maxWeight <= CFG.MAX_STOCK_WEIGHT : null, "Largest is " + fmtPct(pf.maxWeight)]);
    checkList.push(["Active sleeve within " + fmtMoney(CFG.ACTIVE_SLEEVE_CAP, 0), invested ? pf.activeValue <= CFG.ACTIVE_SLEEVE_CAP : null, fmtMoney(pf.activeValue) + " used"]);
    checkList.push(["Competition stocks in different sectors", pf.competitionCount > 0 ? pf.competitionSectors === pf.competitionCount : null, pf.competitionSectors + (pf.competitionSectors === 1 ? " sector across " : " sectors across ") + pf.competitionCount + (pf.competitionCount === 1 ? " stock" : " stocks")]);
    var checks = checkList.map(function (c) {
      var kind = c[1] === null ? "none" : c[1] ? "ok" : "bad";
      var word = c[1] === null ? "Nothing held yet" : c[1] ? "Within the limit" : "Breach";
      return '<li class="check ' + kind + '"><span class="check-icon">' + (kind === "ok" ? ICON.ok : kind === "bad" ? ICON.bad : ICON.dash) + "</span>" +
        '<span class="check-text"><span class="check-title">' + esc(c[0]) + '</span><span class="muted small">' + esc(c[1] === null ? word : c[2]) + "</span></span>" +
        (kind === "bad" ? '<span class="pill bad">Breach</span>' : "") + "</li>";
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
          '<div class="hero-value">' + fmtMoney(pf.total) + "</div>" +
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
        '<div class="card flush"><div class="card-head"><h2>Holdings</h2>' + (canTrade() ? '<button type="button" class="btn small-btn" data-view="trade">New trade</button>' : "") + "</div>" +
          '<div class="table-scroll"><table><thead><tr><th>Stock</th><th>Sleeve</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Value</th><th class="num">Gain or loss</th><th class="num">Weight</th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="7" class="empty">The fund holds no shares yet. It is all in cash.</td></tr>') +
        "</tbody></table></div></div>" +
        '<div class="stack">' + codeCardHtml() +
          '<div class="card"><h2>Mandate checks</h2><ul class="checks">' + checks + "</ul></div>" +
          '<div class="card"><h2>Latest trades</h2>' + (recent ? '<ul class="recent">' + recent + "</ul>" : '<p class="muted small" style="margin:0">No trades yet.</p>') + "</div>" +
        "</div>" +
      "</div>";
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
        '<td><span class="code">' + esc(p.code) + '</span><div class="muted small">' + esc(p.name) + "</div></td>" +
        '<td class="hide-sm">' + esc(p.sector) + "</td>" +
        '<td class="num">' + (p.price > 0 ? fmtMoney(p.price) : "No price") + '<div class="small ' + signClass(p.change_pct) + '">' + fmtChange(p.change_pct) + "</div></td>" +
        '<td class="num">' + tag + "</td></tr>";
    }).join("");
  }

  function renderTrade() {
    if (!canTrade()) {
      $("#main").innerHTML = '<div class="page-head"><h1>Trade</h1></div><div class="card"><p>' +
        (state.user ? "Your account can view the fund but cannot place trades. Ask the fund manager to make you an analyst." : "Sign in with an analyst or fund manager account to place trades.") +
        "</p>" + (state.user ? "" : '<button type="button" class="btn" data-view="signin">Sign in</button>') + "</div>";
      return;
    }
    var free = brokerageFor(1000) === 0;
    $("#main").innerHTML =
      '<div class="page-head"><div><h1>Trade</h1><div class="muted small">' + pricesStamp() + ". Market orders fill straight away at the price shown" + (free ? ", with no brokerage" : "") + ".</div></div></div>" +
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
  }

  function renderOpenOrders() {
    var el = $("#open-orders");
    if (!el) return;
    if (!state.orders.length) { el.innerHTML = ""; return; }
    el.innerHTML = '<div class="card flush" style="margin-top:16px"><div class="card-head"><h2>Open limit orders</h2><span class="muted small">These fill when the price reaches the limit while the site is open.</span></div>' +
      '<div class="table-scroll"><table><thead><tr><th>Placed</th><th>Order</th><th>Stock</th><th class="num">Quantity</th><th class="num">Limit</th><th class="num">Price now</th><th>By</th><th class="num"></th></tr></thead><tbody>' +
      state.orders.map(function (o) {
        var info = state.prices[o.code];
        var mine = isAdmin() || (state.user && o.created_by === state.user.id);
        return '<tr><td class="nowrap">' + esc(fmtDate(o.created_at)) + '</td><td><span class="pill ' + o.side + '">' + (o.side === "buy" ? "Buy" : "Sell") + "</span></td>" +
          '<td class="code">' + esc(o.code) + '</td><td class="num">' + fmtQty(o.quantity) + '</td><td class="num">' + fmtMoney(o.limit_price) + "</td>" +
          '<td class="num">' + (info && info.price > 0 ? fmtMoney(info.price) : "No price") + '</td><td class="nowrap">' + esc(o.trader_name || "") + "</td>" +
          '<td class="num">' + (mine ? '<button type="button" class="btn secondary small-btn" data-cancel-order="' + esc(o.id) + '">Cancel</button>' : "") + "</td></tr>";
      }).join("") + "</tbody></table></div></div>";
  }

  function renderTicket() {
    var el = $("#ticket");
    if (!el) return;
    var o = state.order;
    var info = state.prices[o.code];
    el.className = "card ticket " + o.side;
    if (!info) {
      el.innerHTML = "<h2>" + (o.side === "sell" ? "Sell order" : "Buy order") + '</h2><p class="muted" style="margin:0">' + (o.side === "sell" ? "Choose one of the fund's holdings to sell." : "Choose a stock from the list to buy.") + "</p>";
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
          : '<div class="static-field">' + fmtMoney(info.price) + ' <span class="muted small">current price, fills straight away</span></div>') + "</div>" +
      sleeveField +
      (needsCode() ? '<div class="field"><label for="approval">Approval code from the fund manager</label><input id="approval" class="code-input" type="text" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="6 digits" value="' + esc(o.approval) + '"><div class="muted small" style="margin-top:5px">Every trade goes through the fund manager. Ask them for the current code. It changes every 5 minutes.</div></div>' : "") +
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
    var ok = typed && qty > 0 && !issues.length && !state.busy && (!needsCode() || /^\d{6}$/.test(o.approval));
    var limitNote = "";
    if (n.isLimit && n.limit > 0) {
      limitNote = n.pending
        ? "This order waits until " + info.code + " is at " + fmtMoney(n.limit) + " or " + (o.side === "buy" ? "lower" : "higher") + ". You can cancel it before then."
        : "The price is already " + (o.side === "buy" ? "at or below" : "at or above") + " your limit, so this fills straight away at " + fmtMoney(info.price) + ".";
    }

    el.innerHTML =
      '<div class="summary">' +
        "<div><span>Currently held</span><span>" + fmtQty(held ? held.qty : 0) + " shares</span></div>" +
        "<div><span>Shares in this order</span><span>" + fmtQty(qty) + " at " + fmtMoney(n.price) + "</span></div>" +
        (brokerageFor(1000) > 0 ? "<div><span>Brokerage</span><span>" + fmtMoney(brokerage) + "</span></div>" : "") +
        '<div class="total"><span>' + (o.side === "buy" ? (n.pending ? "Cost if filled" : "Total cost") : (n.pending ? "Cash if filled" : "Cash received")) + "</span><span>" + fmtMoney(total) + "</span></div>" +
        "<div><span>Cash after</span><span>" + fmtMoney(cashAfter) + "</span></div>" +
      "</div>" +
      (limitNote ? '<p class="muted small" style="margin:-4px 0 12px">' + esc(limitNote) + "</p>" : "") +
      (issues.length ? '<ul class="issues">' + issues.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>" : "") +
      '<button type="button" class="btn block ' + (o.side === "sell" ? "sell" : "buy") + '" data-action="submit-order"' + (ok ? "" : " disabled") + ">" +
        (state.busy ? "Placing order…" : (n.pending ? "Place limit order: " : "") + (o.side === "buy" ? (n.pending ? "buy " : "Buy ") : (n.pending ? "sell " : "Sell ")) + (qty > 0 ? fmtQty(qty) + " " : "") + esc(info.code)) + "</button>";
  }

  function renderCompanies() {
    var sectors = {};
    state.priceList.forEach(function (p) { if (p.sector) sectors[p.sector] = true; });
    var sectorOpts = '<option value="">All sectors</option>' + Object.keys(sectors).sort().map(function (s) {
      return '<option value="' + esc(s) + '"' + (state.sector === s ? " selected" : "") + ">" + esc(s) + "</option>";
    }).join("");
    $("#main").innerHTML =
      '<div class="page-head"><div><h1>Companies</h1><div class="muted small">Every company the fund can buy. Click a company to open its full profile on Market Index in a new tab.</div></div></div>' +
      '<div class="card flush"><div class="card-pad filters">' +
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
    $("#co-count").textContent = list.length + (list.length === 1 ? " company" : " companies");
    body.innerHTML = list.map(function (p) {
      return "<tr>" +
        '<td><a class="co-link" href="' + infoUrl(p.code) + '" target="_blank" rel="noopener noreferrer"><span class="code">' + esc(p.code) + '</span><span class="muted small">' + esc(p.name) + "</span></a></td>" +
        "<td>" + esc(p.sector) + "</td>" +
        '<td class="num">' + (p.price > 0 ? fmtMoney(p.price) : "No price") + "</td>" +
        '<td class="num ' + signClass(p.change_pct) + '">' + fmtChange(p.change_pct) + "</td>" +
        '<td class="num">' + fmtCap(p.market_cap) + "</td>" +
        '<td class="num"><div class="row-links"><a href="' + infoUrl(p.code) + '" target="_blank" rel="noopener noreferrer">Info' + ICON.ext + "</a>" +
          '<a href="' + bookUrl(p.code) + '" target="_blank" rel="noopener noreferrer">Order book' + ICON.ext + "</a>" +
          (canTrade() ? '<button type="button" class="btn small-btn" data-trade="' + esc(p.code) + '">Trade</button>' : "") + "</div></td></tr>";
    }).join("") || '<tr><td colspan="6" class="empty">No companies match.</td></tr>';
  }

  function renderHistory() {
    var showBrokerage = state.trades.some(function (t) { return t.brokerage > 0; });
    var showNote = state.trades.some(function (t) { return t.note && t.type !== "deposit"; });
    var rows = state.trades.slice().reverse().map(function (t) {
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
      '<div class="page-head"><div><h1>History</h1><div class="muted small">Every trade the fund has made, newest first, with who placed it and when (Sydney time). Entries cannot be edited or deleted.</div></div>' +
      '<button type="button" class="btn" data-action="export">' + ICON.down + "Download Excel</button></div>" +
      '<div class="card flush"><div class="table-scroll"><table><thead><tr><th class="num">No.</th><th>When</th><th>Type</th><th>Stock</th><th>Sleeve</th><th class="num">Quantity</th><th class="num">Price</th>' + (showBrokerage ? '<th class="num">Brokerage</th>' : "") + '<th class="num">Cash effect</th><th>By</th>' + (showNote ? "<th>Note</th>" : "") + '</tr></thead><tbody>' +
      (rows || '<tr><td colspan="11" class="empty">No trades yet.</td></tr>') + "</tbody></table></div></div>" +
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
      '<div class="page-head"><div><h1>Members</h1><div class="muted small">Everyone who has created an account. New accounts start as viewers. Only fund managers can see this page.</div></div></div>' +
      (freshCount ? '<p class="notice">' + freshCount + (freshCount === 1 ? " person has" : " people have") + " joined since you last looked. They are marked New below.</p>" : "") +
      '<div class="members-top"><div class="card"><h2>Org chart</h2>' + orgChart() + "</div>" + codeCardHtml() + "</div>" +
      '<div class="card flush"><div class="card-head"><h2>Roles and job titles</h2></div><div class="table-scroll"><table><thead><tr><th>Member</th><th>Job title</th><th>Joined</th><th>Charter</th><th class="num">Access</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="empty">No members yet.</td></tr>') + "</tbody></table></div></div>" +
      '<p class="muted small" style="margin-top:12px">Access decides what someone can do on the site. The job title is free text for the org chart, for example Head of Research or Risk Officer. Your own access is locked so the fund can never be left without a fund manager. To hand over, make someone else a fund manager and ask them to change yours. Other people appear here once they create an account on the sign-in page.</p>';
  }

  function renderProfile() {
    if (!state.user) { state.view = "signin"; return render(); }
    var u = state.user;
    $("#main").innerHTML =
      '<div class="page-head"><div><h1>Your profile</h1><div class="muted small">Your name is recorded against every trade you place.</div></div></div>' +
      '<div class="profile-grid">' +
        '<div class="card"><h2>Photo and name</h2>' +
          '<div class="photo-row">' + avatarHtml(u, "xl") +
            '<div><input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden>' +
            '<button type="button" class="btn secondary" data-action="pick-avatar">' + (safeAvatar(u.avatar) ? "Change photo" : "Upload a photo") + '</button> ' +
            (safeAvatar(u.avatar) ? '<button type="button" class="btn quiet" data-action="remove-avatar">Remove</button>' : "") +
            "</div></div>" +
          '<form id="name-form" novalidate><div class="field"><label for="p-name">Display name</label><input id="p-name" type="text" maxlength="60" autocomplete="name" value="' + esc(u.name) + '"></div>' +
          '<div class="form-msg" id="name-msg"></div><button type="submit" class="btn">Save name</button></form></div>' +
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
          '<img class="auth-logo" src="img/logo-full.png" alt="The Lighthouse Fund, Macquarie University" width="230" height="202">' +
          "<h2>" + (signupMode ? "Create your account" : "Sign in") + "</h2>" +
          '<p class="muted small">' + (signupMode ? "New accounts can view the fund. The fund manager can then make you an analyst." : "Welcome back. Sign in to manage the fund.") + "</p>" +
          form +
          '<p class="auth-back"><button type="button" class="link" data-view="portfolio">View the fund without signing in</button>' +
            (DEMO ? "" : ' <span aria-hidden="true">·</span> <button type="button" class="link" data-action="enter-demo">Try demo mode</button>') + "</p>" +
        "</div></div>" +
      "</div>";
  }

  function render() {
    renderChrome();
    if (state.view === "trade") renderTrade();
    else if (state.view === "companies") renderCompanies();
    else if (state.view === "history") renderHistory();
    else if (state.view === "members") renderMembers();
    else if (state.view === "profile") renderProfile();
    else if (state.view === "signin") renderSignin();
    else renderPortfolio();
    renderCharterGate();
    tickCode();
  }

  function go(view) {
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
      store.listTrades().then(function (t) { state.trades = t; }).catch(function (e) { toast("Could not load trades: " + e.message); }),
      store.listOrders().then(function (o) { state.orders = o; }).catch(function () { state.orders = []; }),
      // The fund manager's member list, so the Members tab can flag new sign-ups.
      isAdmin() && !DEMO ? store.listMembers().then(function (m) {
        state.members = m;
        if (!membersSeenAt()) markMembersSeen();
      }).catch(function () { /* shown when the Members page is opened */ }) : null
    ]).then(fillDueOrders).then(function () {
      if (state.view === "signin" && state.user) state.view = "portfolio";
      // Avoid wiping anything the person is in the middle of typing.
      if (state.view === "trade" && canTrade() && $("#ticket")) {
        renderChrome();
        $("#universe").innerHTML = universeRows();
        if (state.order.code) renderCalc();
        renderOpenOrders();
      } else if (state.view === "companies" && $("#companies")) {
        renderChrome();
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
  }

  function submitOrder() {
    var o = state.order;
    var info = state.prices[o.code];
    var pf = computePortfolio(state.trades);
    var issues = validateOrder(o, pf);
    if (issues.length) { renderCalc(); return; }
    var n = orderNumbers(o, info);
    var qty = n.qty;
    var isEtf = info.code === CFG.ETF_CODE;
    var held = pf.positions.filter(function (p) { return p.code === info.code; })[0];
    var sleeve = isEtf ? "index" : o.side === "sell" && held ? held.sleeve : o.sleeve;
    var verb = o.side === "buy" ? "Buy" : "Sell";
    var approval = needsCode() ? o.approval : "";

    if (n.pending) {
      if (!window.confirm("Place a limit order to " + verb.toLowerCase() + " " + fmtQty(qty) + " " + info.code + " at " + fmtMoney(n.limit) + " or " + (o.side === "buy" ? "lower" : "higher") + "?")) return;
      state.busy = true;
      renderCalc();
      store.placeOrder({ side: o.side, code: info.code, sleeve: sleeve, quantity: qty, limit_price: n.limit, approval: approval })
        .then(function () { return store.listOrders(); })
        .then(function (list) {
          state.busy = false;
          state.orders = list;
          clearTicket();
          toast("Limit order placed: " + verb.toLowerCase() + " " + fmtQty(qty) + " " + info.code + " at " + fmtMoney(n.limit));
          render();
        })
        .catch(function (e) { state.busy = false; renderCalc(); toast("Order not placed: " + e.message); });
      return;
    }

    if (!window.confirm(verb + " " + fmtQty(qty) + " " + info.code + " at " + fmtMoney(info.price) + "?\n\nThis is recorded permanently and cannot be undone.")) return;
    state.busy = true;
    renderCalc();
    store.addTrade({ type: o.side, code: info.code, sleeve: sleeve, quantity: qty, price: info.price, note: "", approval: approval })
      .then(function () {
        state.busy = false;
        clearTicket();
        toast(verb + " order filled: " + fmtQty(qty) + " " + info.code + " at " + fmtMoney(info.price));
        return store.listTrades();
      })
      .then(function (t) {
        state.trades = t;
        var stillHeld = computePortfolio(t).positions.some(function (p) { return p.code === state.order.code; });
        if (state.order.side === "sell" && !stillHeld) state.order.code = null;
        render();
      })
      .catch(function (e) {
        state.busy = false;
        renderCalc();
        toast("Order not placed: " + e.message);
      });
  }

  // Fills any open limit order whose price has been reached. Runs after each price refresh.
  var filling = false;
  function fillDueOrders() {
    if (filling || !canTrade() || !state.orders.length) return Promise.resolve();
    // The real record is never filled from sample prices.
    if (state.pricesAreSample && !DEMO) return Promise.resolve();
    var due = state.orders.filter(function (o) {
      var info = state.prices[o.code];
      if (!info || !(info.price > 0)) return false;
      return o.side === "buy" ? info.price <= o.limit_price : info.price >= o.limit_price;
    });
    if (!due.length) return Promise.resolve();
    filling = true;
    var filled = [];
    return due.reduce(function (chain, o) {
      return chain.then(function () {
        var price = state.prices[o.code].price;
        return store.fillOrder(o.id, price).then(function () { filled.push((o.side === "buy" ? "bought " : "sold ") + fmtQty(o.quantity) + " " + o.code + " at " + fmtMoney(price)); }, function () { /* stays open, tried again next refresh */ });
      });
    }, Promise.resolve()).then(function () {
      return Promise.all([store.listTrades(), store.listOrders()]);
    }).then(function (r) {
      filling = false;
      state.trades = r[0];
      state.orders = r[1];
      if (filled.length) toast("Limit order filled: " + filled.join(", "));
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
    var t = e.target.closest("[data-view],[data-action],[data-side],[data-code],[data-trade],[data-qtymode],[data-otype],[data-cancel-order],[data-remove-member]");
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
    if (t.dataset.qtymode) { state.order.qtyMode = t.dataset.qtymode; renderTicket(); var f1 = $(state.order.qtyMode === "amount" ? "#amount" : "#qty"); if (f1) f1.focus(); return; }
    if (t.dataset.otype) { state.order.type = t.dataset.otype; renderTicket(); var f2 = $("#limit"); if (f2) f2.focus(); return; }
    if (t.dataset.cancelOrder) {
      var oid = Number(t.dataset.cancelOrder);
      if (!window.confirm("Cancel this limit order?")) return;
      t.disabled = true;
      store.cancelOrder(oid).then(function () { return store.listOrders(); }).then(function (list) { state.orders = list; renderOpenOrders(); toast("Order cancelled"); })
        .catch(function (err) { t.disabled = false; toast("Not cancelled: " + err.message); });
      return;
    }
    if (t.dataset.removeMember) {
      var rid = t.dataset.removeMember;
      var who = state.members.filter(function (m) { return m.id === rid; })[0] || {};
      if (!window.confirm("Remove " + (who.display_name || who.email || "this account") + "?\n\nTheir login is deleted and they lose access. Trades they placed stay on the record under their name. This cannot be undone.")) return;
      t.disabled = true;
      store.removeMember(rid).then(function () {
        state.members = state.members.filter(function (m) { return m.id !== rid; });
        toast("Account removed");
        if (state.view === "members") render();
      }).catch(function (err) { t.disabled = false; toast("Not removed: " + err.message); });
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
    else if (a === "signout") store.signOut().then(function () { state.user = null; state.view = "portfolio"; render(); });
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
      if (codeState.code && navigator.clipboard) navigator.clipboard.writeText(codeState.code).then(function () { toast("Code copied"); }, function () { toast("Could not copy. Read it out instead."); });
    }
    else if (a === "enter-demo") setDemo(true);
    else if (a === "seed-demo") {
      if (window.confirm("Replace the demo trades with a sample portfolio?")) { demoStore.seed(); state.order.code = null; refreshAll().then(function () { go("portfolio"); toast("Sample portfolio loaded"); }); }
    }
    else if (a === "exit-demo") setDemo(false);
    else if (a === "reset-demo") {
      if (window.confirm("Clear all demo trades and start again with " + fmtMoney(CFG.STARTING_CAPITAL) + "?")) { demoStore.reset(); refreshAll(); }
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
    else if (id === "qty") { state.order.qty = e.target.value; renderCalc(); }
    else if (id === "amount") { state.order.amount = e.target.value; renderCalc(); }
    else if (id === "limit") { state.order.limit = e.target.value; renderCalc(); }
    else if (id === "approval") { e.target.value = e.target.value.replace(/\D/g, ""); state.order.approval = e.target.value; renderCalc(); }
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
    else if (e.target.id === "co-sector") { state.sector = e.target.value; renderCompanyRows(); }
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
  window.__lighthouse = { state: state, computePortfolio: computePortfolio, validateOrder: validateOrder, parseCsv: parseCsv, go: go, render: render, refreshAll: refreshAll };
})();
