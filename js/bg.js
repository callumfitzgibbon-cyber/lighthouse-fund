// The moving page background: slow price-chart waves and drifting points of light.
(function () {
  "use strict";
  var host = document.querySelector(".bg-fx");
  if (!host || !host.getContext && !document.createElement("canvas").getContext) return;
  var c = document.createElement("canvas");
  c.className = "bg-canvas";
  host.insertBefore(c, host.firstChild);
  var ctx = c.getContext("2d"), W = 0, H = 0, dpr = 1, t = 0, raf = 0, last = 0;
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var LINES = [
    { y: 0.30, amp: 70, speed: 0.050, color: "240, 82, 107", alpha: 0.50, width: 1.6, seed: 1.3 },
    { y: 0.52, amp: 90, speed: 0.036, color: "90, 162, 245", alpha: 0.34, width: 1.4, seed: 4.1 },
    { y: 0.72, amp: 60, speed: 0.062, color: "240, 82, 107", alpha: 0.26, width: 1.2, seed: 7.7 },
    { y: 0.88, amp: 80, speed: 0.028, color: "255, 255, 255", alpha: 0.14, width: 1.0, seed: 9.9 }
  ];
  var dots = [];
  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    c.width = W * dpr; c.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var n = Math.round(Math.min(70, W * H / 26000));
    dots = [];
    for (var i = 0; i < n; i++) dots.push({ x: Math.random() * W, y: Math.random() * H, r: 0.6 + Math.random() * 1.6, vx: (Math.random() - 0.5) * 0.18, vy: -0.05 - Math.random() * 0.22, p: Math.random() * 6.28 });
    if (still) draw();
  }
  // A wandering line that looks like a share price: a few sine waves of different lengths added together.
  function level(l, x) {
    var k = x / 260 + t * l.speed + l.seed;
    return Math.sin(k) * 0.55 + Math.sin(k * 2.3 + l.seed) * 0.28 + Math.sin(k * 5.1 + l.seed * 2) * 0.12 + Math.sin(k * 11.7) * 0.05;
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    LINES.forEach(function (l) {
      var base = H * l.y, x, y;
      ctx.beginPath();
      for (x = -10; x <= W + 10; x += 8) { y = base + level(l, x) * l.amp; if (x === -10) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.strokeStyle = "rgba(" + l.color + "," + l.alpha + ")"; ctx.lineWidth = l.width; ctx.lineJoin = "round"; ctx.stroke();
      ctx.lineTo(W + 10, base + l.amp + 180); ctx.lineTo(-10, base + l.amp + 180); ctx.closePath();
      var g = ctx.createLinearGradient(0, base - l.amp, 0, base + l.amp + 180);
      g.addColorStop(0, "rgba(" + l.color + "," + (l.alpha * 0.22) + ")"); g.addColorStop(1, "rgba(" + l.color + ",0)");
      ctx.fillStyle = g; ctx.fill();
      // A bright point riding the front of the line, like the latest price.
      var px = W * (0.62 + 0.3 * Math.sin(t * 0.07 + l.seed)), py = base + level(l, px) * l.amp;
      ctx.beginPath(); ctx.arc(px, py, 3, 0, 6.2832); ctx.fillStyle = "rgba(" + l.color + "," + Math.min(1, l.alpha * 1.8) + ")"; ctx.fill();
      ctx.beginPath(); ctx.arc(px, py, 9, 0, 6.2832); ctx.fillStyle = "rgba(" + l.color + "," + (l.alpha * 0.25) + ")"; ctx.fill();
    });
    dots.forEach(function (d) {
      var a = 0.18 + 0.32 * (0.5 + 0.5 * Math.sin(t * 1.4 + d.p));
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 6.2832); ctx.fillStyle = "rgba(255,255,255," + a.toFixed(3) + ")"; ctx.fill();
    });
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 33) return;
    var dt = Math.min(0.1, (now - last) / 1000); last = now; t += dt * 6;
    dots.forEach(function (d) {
      d.x += d.vx; d.y += d.vy;
      if (d.y < -4) { d.y = H + 4; d.x = Math.random() * W; }
      if (d.x < -4) d.x = W + 4; else if (d.x > W + 4) d.x = -4;
    });
    draw();
  }
  window.addEventListener("resize", size);
  document.addEventListener("visibilitychange", function () {
    cancelAnimationFrame(raf);
    if (!document.hidden && !still) raf = requestAnimationFrame(frame);
  });
  size();
  if (!still) raf = requestAnimationFrame(frame);
})();
