(function () {
  "use strict";

  var CFG = window.LIGHTHOUSE_CONFIG;
  var DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;

  var state = {
    view: "portfolio",
    user: null, // { id, email, name, role }
    trades: [],
    prices: {}, // code -> { code, name, sector, price, change_pct, market_cap, excluded }
    priceList: [],
    pricesUpdated: null,
    pricesAreSample: false,
    priceError: null,
    order: { code: null, side: "buy", qty: "", sleeve: "competition", note: "" },
    search: "",
    members: [],
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

  var demoStore = {
    init: function () {
      state.user = { id: "demo", email: "demo@example.com", name: "Demo manager", role: "admin" };
      return Promise.resolve();
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
    signOut: function () { return Promise.resolve(); },
    listMembers: function () { return Promise.resolve([]); },
    reset: function () { try { localStorage.removeItem(LS_TRADES); } catch (e) { /* ignore */ } }
  };

  var sb = null;
  var liveStore = {
    init: function () {
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
      sb.auth.onAuthStateChange(function (event) {
        if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
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
        return sb.from("profiles").select("id,email,display_name,role").eq("id", u.id).maybeSingle().then(function (r) {
          var p = r.data || {};
          state.user = { id: u.id, email: u.email, name: p.display_name || u.email, role: p.role || "viewer" };
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
      return sb.from("trades").insert({
        type: t.type, code: t.code, sleeve: t.sleeve, quantity: t.quantity, price: t.price, note: t.note || null, trader_name: state.user.name
      }).select().single().then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      });
    },
    signIn: function (email, password) {
      return sb.auth.signInWithPassword({ email: email, password: password }).then(function (r) { if (r.error) throw new Error(r.error.message); });
    },
    signUp: function (email, password, name) {
      return sb.auth.signUp({ email: email, password: password, options: { data: { display_name: name } } }).then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      });
    },
    signOut: function () { return sb.auth.signOut(); },
    listMembers: function () {
      return sb.from("profiles").select("id,email,display_name,role,created_at").order("created_at", { ascending: true }).then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      });
    },
    setRole: function (id, role) {
      return sb.from("profiles").update({ role: role }).eq("id", id).then(function (r) { if (r.error) throw new Error(r.error.message); });
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

  // Checks an order against the fund's mandate. Returns a list of plain-language problems.
  function validateOrder(order, pf) {
    var issues = [];
    var info = state.prices[order.code];
    var qty = Number(order.qty);
    if (!info) { issues.push("Choose a stock from the list."); return issues; }
    if (!(info.price > 0)) { issues.push("No price is available for " + info.code + " right now."); return issues; }
    if (!(qty > 0) || Math.floor(qty) !== qty) { issues.push("Enter a whole number of shares."); return issues; }

    var isEtf = info.code === CFG.ETF_CODE;
    var value = qty * info.price;
    var brokerage = brokerageFor(value);
    var held = pf.positions.filter(function (p) { return p.code === info.code; })[0];
    var heldQty = held ? held.qty : 0;
    var heldValue = held ? held.value : 0;

    if (order.side === "buy") {
      if (!isEtf && info.excluded) issues.push(info.code + " is outside the mandate: " + info.excluded + ".");
      if (value + brokerage > pf.cash + 0.005) issues.push("Not enough cash. This order costs " + fmtMoney(value + brokerage) + " and the fund has " + fmtMoney(pf.cash) + ". Sell some of the index ETF first.");
      if (!isEtf) {
        if (pf.etfValue < CFG.MIN_ETF_VALUE) issues.push("The index ETF holding is below the " + fmtMoney(CFG.MIN_ETF_VALUE) + " floor. Buy " + CFG.ETF_CODE + " first.");
        var totalAfter = pf.total - brokerage;
        var weightAfter = totalAfter > 0 ? (heldValue + value) / totalAfter : 1;
        if (weightAfter > CFG.MAX_STOCK_WEIGHT + 1e-9) issues.push("This would take " + info.code + " to " + fmtPct(weightAfter) + " of the fund. The limit is " + fmtPct(CFG.MAX_STOCK_WEIGHT, 0) + ".");
        if (order.sleeve === "active" && pf.activeValue + value > CFG.ACTIVE_SLEEVE_CAP + 0.005) issues.push("This would take the active sleeve to " + fmtMoney(pf.activeValue + value) + ". The cap is " + fmtMoney(CFG.ACTIVE_SLEEVE_CAP) + ".");
      }
    } else {
      if (qty > heldQty) issues.push("The fund holds " + fmtQty(heldQty) + " " + info.code + ". You cannot sell more than that.");
      else if (isEtf && pf.etfValue - value < CFG.MIN_ETF_VALUE - 0.005) issues.push("This would leave " + fmtMoney(pf.etfValue - value) + " in the index ETF. The floor is " + fmtMoney(CFG.MIN_ETF_VALUE) + ".");
    }
    return issues;
  }

  // ---------- rendering ----------
  function renderChrome() {
    var tabs = [["portfolio", "Portfolio"], ["trade", "Trade"], ["history", "History"]];
    if (isAdmin() && !DEMO) tabs.push(["members", "Members"]);
    $("#nav").innerHTML = tabs.map(function (t) {
      return '<button type="button" data-view="' + t[0] + '"' + (state.view === t[0] ? ' aria-current="page"' : "") + ">" + t[1] + "</button>";
    }).join("");

    var acc = "";
    if (state.user) {
      acc = "<span>" + esc(state.user.name) + '</span><span class="role">' + esc(state.user.role) + "</span>";
      if (!DEMO) acc += '<button type="button" class="btn ghost" data-action="signout">Sign out</button>';
    } else {
      acc = '<button type="button" class="btn ghost" data-view="signin">Sign in</button>';
    }
    $("#account").innerHTML = acc;

    var notes = [];
    if (DEMO) notes.push("Demo mode: trades are saved in this browser only and nobody else can see them.");
    if (state.pricesAreSample) notes.push("Showing sample prices, not real market prices.");
    if (state.priceError) notes.push("Price feed problem: " + state.priceError + ".");
    $("#banner").innerHTML = notes.length ? '<div class="banner"><div class="wrap">' + esc(notes.join(" ")) + "</div></div>" : "";
  }

  function pricesStamp() {
    if (state.pricesAreSample) return "Sample prices";
    return state.pricesUpdated ? "Prices as at " + esc(state.pricesUpdated) + ", delayed" : "Prices delayed";
  }

  function renderPortfolio() {
    var pf = computePortfolio(state.trades);
    var colors = { index: "#33373e", competition: "#a21c31", active: "#d98a96", cash: "#c9ccd2" };
    var parts = [
      ["Index ETF", pf.etfValue, colors.index],
      ["Competition stocks", pf.competitionValue, colors.competition],
      ["Active sleeve", pf.activeValue, colors.active],
      ["Cash", Math.max(pf.cash, 0), colors.cash]
    ];
    var totalForBar = parts.reduce(function (a, p) { return a + p[1]; }, 0) || 1;

    var rows = pf.positions.map(function (p) {
      var over = p.code !== CFG.ETF_CODE && p.weight > CFG.MAX_STOCK_WEIGHT;
      return "<tr>" +
        '<td><span class="code">' + esc(p.code) + '</span><div class="muted small">' + esc(p.name) + "</div></td>" +
        "<td>" + esc(sleeveLabel(p.sleeve)) + "</td>" +
        '<td class="num">' + fmtQty(p.qty) + "</td>" +
        '<td class="num">' + (p.priced ? fmtMoney(p.price) : "No price") + "</td>" +
        '<td class="num">' + fmtMoney(p.value) + "</td>" +
        '<td class="num ' + signClass(p.gain) + '">' + fmtMoney(p.gain) + '<div class="small">' + fmtPct(p.gainPct) + "</div></td>" +
        '<td class="num">' + fmtPct(p.weight) + (over ? ' <span class="pill bad">Over limit</span>' : "") + "</td>" +
        "</tr>";
    }).join("");

    var invested = pf.holdingsValue > 0;
    var checks = [
      ["Index ETF at least " + fmtMoney(CFG.MIN_ETF_VALUE), invested ? pf.etfValue >= CFG.MIN_ETF_VALUE : null, fmtMoney(pf.etfValue)],
      ["No stock above " + fmtPct(CFG.MAX_STOCK_WEIGHT, 0), invested ? pf.maxWeight <= CFG.MAX_STOCK_WEIGHT : null, fmtPct(pf.maxWeight)],
      ["Active sleeve within " + fmtMoney(CFG.ACTIVE_SLEEVE_CAP), invested ? pf.activeValue <= CFG.ACTIVE_SLEEVE_CAP : null, fmtMoney(pf.activeValue)],
      ["Competition stocks in different sectors", pf.competitionCount > 0 ? pf.competitionSectors === pf.competitionCount : null, pf.competitionSectors + " of " + pf.competitionCount]
    ].map(function (c) {
      var pill = c[1] === null ? '<span class="pill">Not yet invested</span>' : c[1] ? '<span class="pill ok">OK</span>' : '<span class="pill bad">Breach</span>';
      return "<li><span>" + esc(c[0]) + '<div class="muted small">' + esc(c[2]) + "</div></span>" + pill + "</li>";
    }).join("");

    $("#main").innerHTML =
      '<div class="page-head"><div><h1>Portfolio</h1><div class="muted small">' + pricesStamp() + "</div></div></div>" +
      '<div class="cards">' +
        statCard("Fund value", fmtMoney(pf.total), "Started with " + fmtMoney(CFG.STARTING_CAPITAL)) +
        statCard("Return since inception", '<span class="' + signClass(pf.ret) + '">' + fmtPct(pf.ret, 2) + "</span>", fmtMoney(pf.total - CFG.STARTING_CAPITAL)) +
        statCard("Invested", fmtMoney(pf.holdingsValue), pf.positions.length + (pf.positions.length === 1 ? " holding" : " holdings")) +
        statCard("Cash", fmtMoney(pf.cash), fmtPct(pf.total > 0 ? pf.cash / pf.total : 0) + " of the fund") +
      "</div>" +
      (pf.unpriced.length ? '<p class="notice">No price is available for ' + esc(pf.unpriced.join(", ")) + ", so the fund value is understated.</p>" : "") +
      '<div class="grid-2">' +
        '<div class="card"><h2>Holdings</h2><div class="table-scroll"><table><thead><tr><th>Stock</th><th>Sleeve</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Value</th><th class="num">Gain or loss</th><th class="num">Weight</th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="7" class="empty">The fund holds no shares yet. It is all in cash.</td></tr>') +
        "</tbody></table></div></div>" +
        '<div class="stack">' +
          '<div class="card"><h2>Allocation</h2><div class="alloc" role="img" aria-label="Allocation by sleeve">' +
            parts.map(function (p) { return '<span style="width:' + (p[1] / totalForBar * 100).toFixed(2) + "%;background:" + p[2] + '"></span>'; }).join("") +
          '</div><div class="legend">' +
            parts.map(function (p) { return '<span><i style="background:' + p[2] + '"></i>' + esc(p[0]) + " " + fmtPct(p[1] / totalForBar) + "</span>"; }).join("") +
          "</div></div>" +
          '<div class="card"><h2>Mandate checks</h2><ul class="checks">' + checks + "</ul></div>" +
        "</div>" +
      "</div>";
  }

  function statCard(label, value, sub) {
    return '<div class="card"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + value + '</div><div class="stat-sub">' + esc(sub) + "</div></div>";
  }
  function sleeveLabel(s) { return { index: "Index ETF", competition: "Competition", active: "Active" }[s] || ""; }

  function universeRows() {
    var q = state.search.trim().toLowerCase();
    var list = state.priceList.filter(function (p) {
      return !q || p.code.toLowerCase().indexOf(q) >= 0 || p.name.toLowerCase().indexOf(q) >= 0 || p.sector.toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) return '<tr><td colspan="5" class="empty">No stocks match that search.</td></tr>';
    return list.slice(0, 400).map(function (p) {
      var status = p.code === CFG.ETF_CODE ? '<span class="pill">Index ETF</span>' : p.excluded ? '<span class="pill bad">' + esc(p.excluded) + "</span>" : '<span class="pill ok">Eligible</span>';
      return '<tr class="clickable' + (state.order.code === p.code ? " selected" : "") + '" data-code="' + esc(p.code) + '" tabindex="0">' +
        '<td><span class="code">' + esc(p.code) + '</span><div class="muted small">' + esc(p.name) + "</div></td>" +
        "<td>" + esc(p.sector) + "</td>" +
        '<td class="num">' + (p.price > 0 ? fmtMoney(p.price) : "No price") + "</td>" +
        '<td class="num ' + signClass(p.change_pct) + '">' + (p.change_pct > 0 ? "+" : "") + p.change_pct.toFixed(2) + "%</td>" +
        "<td>" + status + "</td></tr>";
    }).join("");
  }

  function renderTrade() {
    if (!canTrade()) {
      $("#main").innerHTML = '<div class="page-head"><h1>Trade</h1></div><div class="card"><p>' +
        (state.user ? "Your account can view the fund but cannot place trades. Ask the fund manager to make you a trader." : "Sign in with a trader account to place trades.") +
        "</p>" + (state.user ? "" : '<button type="button" class="btn" data-view="signin">Sign in</button>') + "</div>";
      return;
    }
    $("#main").innerHTML =
      '<div class="page-head"><div><h1>Trade</h1><div class="muted small">' + pricesStamp() + ". Orders fill straight away at the price shown.</div></div></div>" +
      '<div class="grid-trade">' +
        '<div class="card"><div class="field"><label for="search">Find a stock</label><input id="search" type="search" placeholder="Code, company or sector" value="' + esc(state.search) + '" autocomplete="off"></div>' +
          '<div class="table-scroll" style="max-height:520px;overflow-y:auto"><table><thead><tr><th>Stock</th><th>Sector</th><th class="num">Price</th><th class="num">Change</th><th>Status</th></tr></thead><tbody id="universe">' + universeRows() + "</tbody></table></div></div>" +
        '<div class="card" id="ticket"></div>' +
      "</div>";
    renderTicket();
  }

  function renderTicket() {
    var el = $("#ticket");
    if (!el) return;
    var o = state.order;
    var info = state.prices[o.code];
    if (!info) {
      el.innerHTML = "<h2>Order</h2><p class=\"muted\">Choose a stock from the list to start an order.</p>";
      return;
    }
    var isEtf = info.code === CFG.ETF_CODE;
    var sleeveField = o.side === "buy" && !isEtf
      ? '<div class="field"><label for="sleeve">Sleeve</label><select id="sleeve"><option value="competition"' + (o.sleeve === "competition" ? " selected" : "") + '>Competition stock</option><option value="active"' + (o.sleeve === "active" ? " selected" : "") + ">Active sleeve</option></select></div>"
      : "";
    el.innerHTML =
      "<h2>Order</h2>" +
      '<p><span class="code">' + esc(info.code) + "</span> " + esc(info.name) + '<br><span class="muted small">' + esc(info.sector) + "</span></p>" +
      '<p class="small"><a href="https://www.tmxaustralia.com/market-data/book-viewer?symbol=' + encodeURIComponent(info.code) + '" target="_blank" rel="noopener noreferrer">Live order book on TMX Australia</a> (opens in a new tab)</p>' +
      '<div class="field"><div class="seg" role="group" aria-label="Buy or sell">' +
        '<button type="button" class="buy" data-side="buy" aria-pressed="' + (o.side === "buy") + '">Buy</button>' +
        '<button type="button" class="sell" data-side="sell" aria-pressed="' + (o.side === "sell") + '">Sell</button></div></div>' +
      '<div class="field"><label for="qty">Number of shares</label><input id="qty" type="number" min="1" step="1" inputmode="numeric" value="' + esc(o.qty) + '"></div>' +
      sleeveField +
      '<div class="field"><label for="note">Reason for the trade</label><textarea id="note" rows="2" placeholder="One line on why">' + esc(o.note) + "</textarea></div>" +
      '<div id="calc"></div>';
    renderCalc();
  }

  function renderCalc() {
    var el = $("#calc");
    if (!el) return;
    var o = state.order;
    var info = state.prices[o.code];
    var pf = computePortfolio(state.trades);
    var qty = Number(o.qty) || 0;
    var value = qty * info.price;
    var brokerage = qty > 0 ? brokerageFor(value) : 0;
    var total = o.side === "buy" ? value + brokerage : value - brokerage;
    var cashAfter = o.side === "buy" ? pf.cash - total : pf.cash + total;
    var held = pf.positions.filter(function (p) { return p.code === info.code; })[0];
    var issues = qty > 0 ? validateOrder(o, pf) : [];
    var ok = qty > 0 && !issues.length && !state.busy;

    el.innerHTML =
      '<div class="summary">' +
        "<div><span>Price</span><span>" + fmtMoney(info.price) + "</span></div>" +
        "<div><span>Currently held</span><span>" + fmtQty(held ? held.qty : 0) + " shares</span></div>" +
        "<div><span>Trade value</span><span>" + fmtMoney(value) + "</span></div>" +
        "<div><span>Brokerage</span><span>" + fmtMoney(brokerage) + "</span></div>" +
        '<div class="total"><span>' + (o.side === "buy" ? "Total cost" : "Cash received") + "</span><span>" + fmtMoney(total) + "</span></div>" +
        "<div><span>Cash after</span><span>" + fmtMoney(cashAfter) + "</span></div>" +
      "</div>" +
      (issues.length ? '<ul class="issues">' + issues.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>" : "") +
      '<button type="button" class="btn block" data-action="submit-order"' + (ok ? "" : " disabled") + ">" +
        (state.busy ? "Placing order…" : (o.side === "buy" ? "Buy " : "Sell ") + (qty > 0 ? fmtQty(qty) + " " : "") + esc(info.code)) + "</button>";
  }

  function renderHistory() {
    var rows = state.trades.slice().reverse().map(function (t) {
      var value = (t.quantity || 0) * (t.price || 0);
      var cashEffect = t.type === "buy" ? -(value + (t.brokerage || 0)) : t.type === "sell" ? value - (t.brokerage || 0) : (t.cash_amount || 0);
      var pillClass = t.type === "buy" ? "buy" : t.type === "sell" ? "sell" : "";
      return "<tr>" +
        '<td class="num">' + esc(t.id) + "</td>" +
        "<td>" + esc(fmtDate(t.created_at)) + "</td>" +
        '<td><span class="pill ' + pillClass + '">' + esc(t.type.charAt(0).toUpperCase() + t.type.slice(1)) + "</span></td>" +
        '<td class="code">' + esc(t.code || "") + "</td>" +
        "<td>" + esc(sleeveLabel(t.sleeve)) + "</td>" +
        '<td class="num">' + (t.quantity != null ? fmtQty(t.quantity) : "") + "</td>" +
        '<td class="num">' + (t.price != null ? fmtMoney(t.price) : "") + "</td>" +
        '<td class="num">' + (t.brokerage ? fmtMoney(t.brokerage) : "") + "</td>" +
        '<td class="num ' + signClass(cashEffect) + '">' + fmtMoney(cashEffect) + "</td>" +
        "<td>" + esc(t.trader_name || "") + "</td>" +
        "<td>" + esc(t.note || "") + "</td></tr>";
    }).join("");
    $("#main").innerHTML =
      '<div class="page-head"><div><h1>History</h1><div class="muted small">Every trade the fund has made, newest first. Entries cannot be edited or deleted.</div></div>' +
      '<button type="button" class="btn secondary" data-action="export">Download CSV</button></div>' +
      '<div class="card"><div class="table-scroll"><table><thead><tr><th class="num">No.</th><th>When</th><th>Type</th><th>Stock</th><th>Sleeve</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Brokerage</th><th class="num">Cash effect</th><th>By</th><th>Reason</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="11" class="empty">No trades yet.</td></tr>') + "</tbody></table></div></div>" +
      (DEMO ? '<p class="small muted" style="margin-top:12px"><button type="button" class="btn secondary" data-action="reset-demo">Reset demo data</button></p>' : "");
  }

  function renderMembers() {
    if (!isAdmin()) { state.view = "portfolio"; return render(); }
    var rows = state.members.map(function (m) {
      var opts = ["viewer", "trader", "admin"].map(function (r) { return '<option value="' + r + '"' + (m.role === r ? " selected" : "") + ">" + r + "</option>"; }).join("");
      return "<tr><td>" + esc(m.display_name || "") + "</td><td>" + esc(m.email || "") + '</td><td><select data-member="' + esc(m.id) + '" aria-label="Role for ' + esc(m.email || "") + '"' + (m.id === state.user.id ? " disabled" : "") + ">" + opts + "</select></td></tr>";
    }).join("");
    $("#main").innerHTML =
      '<div class="page-head"><div><h1>Members</h1><div class="muted small">Viewers can see the fund. Traders can place trades. Admins can also change roles.</div></div></div>' +
      '<div class="card"><div class="table-scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="3" class="empty">No members yet.</td></tr>') + "</tbody></table></div></div>";
  }

  function renderSignin() {
    if (DEMO) {
      $("#main").innerHTML = '<div class="card auth"><h2>Sign in</h2><p>Sign-in is switched off in demo mode. You are using the app as the fund manager.</p></div>';
      return;
    }
    $("#main").innerHTML =
      '<div class="card auth"><h2>Sign in</h2>' +
      '<form id="auth-form" novalidate>' +
        '<div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email" required></div>' +
        '<div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" minlength="8" required></div>' +
        '<div class="field" id="name-field" hidden><label for="name">Your name</label><input id="name" type="text" autocomplete="name"></div>' +
        '<div id="auth-msg"></div>' +
        '<button type="submit" class="btn block" id="auth-submit">Sign in</button>' +
      "</form>" +
      '<p class="small muted" style="margin-top:12px"><button type="button" class="btn secondary" data-action="toggle-signup">Create an account instead</button></p></div>';
  }

  function render() {
    renderChrome();
    if (state.view === "trade") renderTrade();
    else if (state.view === "history") renderHistory();
    else if (state.view === "members") renderMembers();
    else if (state.view === "signin") renderSignin();
    else renderPortfolio();
  }

  function go(view) {
    state.view = view;
    if (view === "members" && isAdmin() && !DEMO) {
      store.listMembers().then(function (m) { state.members = m; render(); }).catch(function (e) { toast(e.message); });
    }
    render();
    $("#main").focus({ preventScroll: true });
  }

  // ---------- actions ----------
  function refreshAll() {
    return Promise.all([
      loadPrices(),
      store.listTrades().then(function (t) { state.trades = t; }).catch(function (e) { toast("Could not load trades: " + e.message); })
    ]).then(function () {
      if (state.view === "signin" && state.user) state.view = "portfolio";
      // Avoid wiping an order the trader is in the middle of typing.
      if (state.view === "trade" && canTrade() && $("#ticket")) {
        renderChrome();
        $("#universe").innerHTML = universeRows();
        if (state.order.code) renderCalc();
      } else {
        render();
      }
    });
  }

  function submitOrder() {
    var o = state.order;
    var info = state.prices[o.code];
    var pf = computePortfolio(state.trades);
    var issues = validateOrder(o, pf);
    if (issues.length) { renderCalc(); return; }
    var qty = Number(o.qty);
    var isEtf = info.code === CFG.ETF_CODE;
    var held = pf.positions.filter(function (p) { return p.code === info.code; })[0];
    var sleeve = isEtf ? "index" : o.side === "sell" && held ? held.sleeve : o.sleeve;
    var verb = o.side === "buy" ? "Buy" : "Sell";
    if (!window.confirm(verb + " " + fmtQty(qty) + " " + info.code + " at " + fmtMoney(info.price) + "?\n\nThis is recorded permanently and cannot be undone.")) return;

    state.busy = true;
    renderCalc();
    store.addTrade({ type: o.side, code: info.code, sleeve: sleeve, quantity: qty, price: info.price, note: o.note.trim() })
      .then(function () {
        state.busy = false;
        state.order.qty = "";
        state.order.note = "";
        toast(verb + " order filled: " + fmtQty(qty) + " " + info.code + " at " + fmtMoney(info.price));
        return store.listTrades();
      })
      .then(function (t) { state.trades = t; render(); })
      .catch(function (e) {
        state.busy = false;
        renderCalc();
        toast("Order not placed: " + e.message);
      });
  }

  function exportCsv() {
    var head = ["id", "created_at", "type", "code", "sleeve", "quantity", "price", "brokerage", "cash_amount", "trader_name", "note"];
    var lines = [head.join(",")].concat(state.trades.map(function (t) {
      return head.map(function (k) {
        var v = t[k] == null ? "" : String(t[k]);
        if (/^[=+\-@]/.test(v) && isNaN(Number(v))) v = "'" + v; // stop spreadsheet formula injection
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(",");
    }));
    var blob = new Blob([lines.join("\n")], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "lighthouse-fund-trades.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
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

  // ---------- events ----------
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-view],[data-action],[data-side],[data-code]");
    if (!t) return;
    if (t.dataset.view) return go(t.dataset.view);
    if (t.dataset.side) { state.order.side = t.dataset.side; return renderTicket(); }
    if (t.dataset.code) { selectStock(t.dataset.code); return; }
    var a = t.dataset.action;
    if (a === "submit-order") submitOrder();
    else if (a === "export") exportCsv();
    else if (a === "signout") store.signOut().then(function () { state.user = null; state.view = "portfolio"; render(); });
    else if (a === "reset-demo") {
      if (window.confirm("Clear all demo trades and start again with " + fmtMoney(CFG.STARTING_CAPITAL) + "?")) { demoStore.reset(); refreshAll(); }
    } else if (a === "toggle-signup") {
      signupMode = !signupMode;
      $("#name-field").hidden = !signupMode;
      $("#auth-submit").textContent = signupMode ? "Create account" : "Sign in";
      t.textContent = signupMode ? "I already have an account" : "Create an account instead";
      $("#auth-msg").innerHTML = "";
    }
  });

  function selectStock(code) {
    state.order.code = code;
    var pf = computePortfolio(state.trades);
    var held = pf.positions.some(function (p) { return p.code === code; });
    if (!held) state.order.side = "buy";
    var body = $("#universe");
    if (body) body.innerHTML = universeRows();
    renderTicket();
    var qty = $("#qty");
    if (qty) qty.focus();
  }

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var row = e.target.closest && e.target.closest("tr[data-code]");
    if (row) selectStock(row.dataset.code);
  });

  document.addEventListener("input", function (e) {
    var id = e.target.id;
    if (id === "search") { state.search = e.target.value; $("#universe").innerHTML = universeRows(); }
    else if (id === "qty") { state.order.qty = e.target.value; renderCalc(); }
    else if (id === "note") { state.order.note = e.target.value; }
  });

  document.addEventListener("change", function (e) {
    if (e.target.id === "sleeve") { state.order.sleeve = e.target.value; renderCalc(); }
    else if (e.target.dataset.member) {
      var id = e.target.dataset.member, role = e.target.value;
      store.setRole(id, role).then(function () { toast("Role updated"); }).catch(function (err) { toast("Could not update role: " + err.message); go("members"); });
    }
  });

  document.addEventListener("submit", function (e) { if (e.target.id === "auth-form") handleAuth(e); });

  // ---------- start ----------
  store.init()
    .catch(function (e) { toast("Could not connect: " + e.message); })
    .then(refreshAll)
    .then(function () {
      setInterval(refreshAll, Math.max(30, CFG.PRICE_REFRESH_SECONDS) * 1000);
    });

  // Exposed for automated tests.
  window.__lighthouse = { state: state, computePortfolio: computePortfolio, validateOrder: validateOrder, parseCsv: parseCsv };
})();
