// A small line chart of the fund against its benchmark, drawn as SVG with no library.
// points: [{ day: "2026-11-13", fund: 100396.17, bench: 100120.5 }], oldest first.
(function () {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";
  var SERIES = [
    { key: "fund", name: "Lighthouse Fund", color: "#f0526b" },
    { key: "bench", name: "ASX 300 index ETF", color: "#5aa2f5" }
  ];

  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function money(n) { return "$" + Math.round(n).toLocaleString("en-AU"); }
  function dayLabel(day, long) {
    var d = new Date(day + "T00:00:00Z");
    return d.toLocaleDateString("en-AU", long ? { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" } : { timeZone: "UTC", day: "numeric", month: "short" });
  }
  // Round steps for the value axis: 1, 2 or 5 times a power of ten.
  function niceStep(span, count) {
    var raw = span / count, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  }

  function render(host, points) {
    host.textContent = "";
    var W = Math.max(320, Math.round(host.clientWidth || 640)), H = 280;
    var m = { top: 14, right: 16, bottom: 28, left: 62 };
    var iw = W - m.left - m.right, ih = H - m.top - m.bottom;
    var lo = Infinity, hi = -Infinity;
    points.forEach(function (p) { SERIES.forEach(function (s) { lo = Math.min(lo, p[s.key]); hi = Math.max(hi, p[s.key]); }); });
    if (hi - lo < 1) { hi += 500; lo -= 500; }
    var step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    var x = function (i) { return m.left + (points.length === 1 ? iw / 2 : iw * i / (points.length - 1)); };
    var y = function (v) { return m.top + ih * (1 - (v - lo) / (hi - lo)); };

    var wrap = document.createElement("div");
    wrap.className = "chart-wrap";
    host.appendChild(wrap);
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": "Line chart of the fund's value against the ASX 300 index ETF" }, wrap);

    for (var v = lo; v <= hi + 1e-6; v += step) {
      el("line", { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v), class: "chart-grid" }, svg);
      var t = el("text", { x: m.left - 10, y: y(v) + 4, "text-anchor": "end", class: "chart-tick" }, svg);
      t.textContent = money(v);
    }
    var ticks = Math.min(points.length, W < 520 ? 3 : 5);
    for (var k = 0; k < ticks; k++) {
      var i = ticks === 1 ? 0 : Math.round(k * (points.length - 1) / (ticks - 1));
      var tx = el("text", { x: x(i), y: H - 8, "text-anchor": k === 0 ? "start" : k === ticks - 1 ? "end" : "middle", class: "chart-tick" }, svg);
      tx.textContent = dayLabel(points[i].day);
    }
    SERIES.slice().reverse().forEach(function (s) {
      var d = points.map(function (p, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p[s.key]).toFixed(1); }).join(" ");
      el("path", { d: d, class: "chart-line", pathLength: 1, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      var last = points.length - 1;
      el("circle", { cx: x(last), cy: y(points[last][s.key]), r: 4, class: "chart-end", fill: s.color, stroke: "#1c2029", "stroke-width": 2 }, svg);
    });

    // Hover: a hairline snaps to the nearest day and one tooltip lists both series.
    var hair = el("line", { y1: m.top, y2: m.top + ih, class: "chart-hair", visibility: "hidden" }, svg);
    var dots = SERIES.map(function (s) { return el("circle", { r: 4.5, fill: s.color, stroke: "#1c2029", "stroke-width": 2, visibility: "hidden" }, svg); });
    var tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    wrap.appendChild(tip);
    function show(i) {
      var p = points[i];
      hair.setAttribute("x1", x(i)); hair.setAttribute("x2", x(i)); hair.setAttribute("visibility", "visible");
      SERIES.forEach(function (s, n) { dots[n].setAttribute("cx", x(i)); dots[n].setAttribute("cy", y(p[s.key])); dots[n].setAttribute("visibility", "visible"); });
      tip.textContent = "";
      var head = document.createElement("div"); head.className = "chart-tip-head"; head.textContent = dayLabel(p.day, true); tip.appendChild(head);
      SERIES.forEach(function (s) {
        var row = document.createElement("div"); row.className = "chart-tip-row";
        var key = document.createElement("span"); key.className = "chart-key"; key.style.background = s.color;
        var val = document.createElement("strong"); val.textContent = money(p[s.key]);
        var name = document.createElement("span"); name.textContent = s.name;
        row.appendChild(key); row.appendChild(val); row.appendChild(name); tip.appendChild(row);
      });
      tip.hidden = false;
      var left = x(i) / W * wrap.clientWidth, tw = tip.offsetWidth;
      tip.style.left = Math.max(0, Math.min(wrap.clientWidth - tw, left > wrap.clientWidth / 2 ? left - tw - 12 : left + 12)) + "px";
    }
    function hide() { hair.setAttribute("visibility", "hidden"); dots.forEach(function (d) { d.setAttribute("visibility", "hidden"); }); tip.hidden = true; }
    var hit = el("rect", { x: m.left, y: m.top, width: iw, height: ih, fill: "transparent", tabindex: 0, "aria-label": "Fund value by day. Use the left and right arrow keys." }, svg);
    var current = points.length - 1;
    hit.addEventListener("pointermove", function (e) {
      var r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * W;
      current = Math.max(0, Math.min(points.length - 1, Math.round((px - m.left) / iw * (points.length - 1))));
      show(current);
    });
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("focus", function () { show(current); });
    hit.addEventListener("blur", hide);
    hit.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      current = Math.max(0, Math.min(points.length - 1, current + (e.key === "ArrowLeft" ? -1 : 1)));
      show(current);
    });

    // The same numbers as a table, for anyone who would rather read than hover.
    var details = document.createElement("details");
    details.className = "chart-table";
    var sum = document.createElement("summary"); sum.textContent = "Show these numbers as a table"; details.appendChild(sum);
    var table = document.createElement("table"), head = table.createTHead().insertRow();
    ["Day"].concat(SERIES.map(function (s) { return s.name; })).forEach(function (h, n) { var th = document.createElement("th"); th.textContent = h; if (n) th.className = "num"; head.appendChild(th); });
    var body = table.createTBody();
    points.slice().reverse().forEach(function (p) {
      var r = body.insertRow();
      r.insertCell().textContent = dayLabel(p.day, true);
      SERIES.forEach(function (s) { var c = r.insertCell(); c.className = "num"; c.textContent = money(p[s.key]); });
    });
    var scroll = document.createElement("div"); scroll.className = "table-scroll"; scroll.appendChild(table); details.appendChild(scroll);
    host.appendChild(details);
  }

  window.LighthouseChart = { render: render, series: SERIES };
})();
