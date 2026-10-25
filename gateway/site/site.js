// Bold editor lettering with ambient streams and green particles that repair
// reserved amber regions on arrival. Reduced motion shows a healed still frame.
import { planRepairs } from "./wordmark-repairs.js";

for (const button of document.querySelectorAll("button.copy")) {
  let reset;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      clearTimeout(reset);
      button.classList.add("copied");
      button.setAttribute("aria-label", "Command copied");
      button.title = "Copied";
      reset = setTimeout(() => {
        button.classList.remove("copied");
        button.setAttribute("aria-label", "Copy command");
        button.title = "Copy command";
      }, 1600);
    } catch {
      button.setAttribute("aria-label", "Copy failed. Select and copy the command.");
      button.title = "Select and copy the command";
    }
  });
}

const filter = document.getElementById("filter");
if (filter) {
  filter.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    let matches = 0;
    for (const li of document.querySelectorAll("#pkgs li")) {
      li.hidden = q !== "" && !li.dataset.name.toLowerCase().includes(q);
      if (!li.hidden) matches++;
    }
    document.getElementById("package-empty").hidden = matches !== 0;
  });
}

const canvas = document.getElementById("wordmark");
if (canvas && window.UNSTALE_WORDMARK_POINTS) {
  const ctx = canvas.getContext("2d");
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const smooth = (p) => { p = Math.min(1, Math.max(0, p)); return p * p * (3 - 2 * p); };
  const GREEN = [103, 220, 145], AMBER = [232, 172, 94];
  const STREAM = [37, 80, 80], STREAM_HI = [23, 150, 145];
  const light = matchMedia("(prefers-color-scheme: light)").matches;
  const GW = 256, GH = 80;

  // The same sampled Menlo Bold geometry is embedded in the CLI and README.
  const letters = window.UNSTALE_WORDMARK_POINTS;

  const repairs = planRepairs(letters, hash, smooth, GW, GH);

  function cloud(t, ambient) {
    const w = GW, h = GH, phase = t % 32;
    const px = Array.from({ length: h }, () => new Array(w).fill(null));
    const dot = (x, y, c) => {
      x = Math.round(x); y = Math.round(y);
      if (x >= 0 && x < w && y >= 0 && y < h) px[y][x] = c;
    };
    if (ambient) {
      for (let side = 0; side < 2; side++) {
        for (let i = 0; i < 360; i++) {
          const seed = i + side * 701;
          const x = ((hash(seed + 50) * (w + 16) + t * (7 + hash(seed + 90) * 4)) % (w + 16)) - 8;
          const arc = Math.sin(Math.PI * Math.min(1, Math.max(0, x / w)));
          const core = side === 0 ? h * 0.12 - arc * h * 0.04 : h * 0.85 + arc * h * 0.045;
          const spread = hash(seed + 200) + hash(seed + 400) + hash(seed + 600) - 1.5;
          const y = core + spread * 6 + Math.sin((x / w) * 9 - t * 0.35 + side * 2) * 0.7;
          dot(x, y, Math.abs(spread) < 0.24 && i % 7 === 0 ? STREAM_HI : STREAM);
        }
      }
    }
    const staleness = new Float64Array(letters.length);
    const flights = [];
    for (const repair of repairs) {
      const { birth, landing, duration, seed, destination: [tx, ty], claims } = repair;
      if (phase < birth || phase >= landing) continue;
      const growth = smooth((phase - birth) / 0.65);
      for (const { index, amount } of claims) staleness[index] += amount * growth;
      const flight = (phase - (landing - duration)) / duration;
      if (flight < 0) continue;
      const p = smooth(flight);
      const sx = tx - 7 - hash(seed + 3201) * 12;
      const sy = (ty > h * 0.5 ? h * 0.87 : h * 0.08) + (hash(seed + 3401) - 0.5) * 3;
      const curl = Math.sin(Math.PI * flight);
      flights.push([
        sx + (tx - sx) * p + curl * (hash(seed + 3501) - 0.5) * 3,
        sy + (ty - sy) * p + curl * (hash(seed + 3601) - 0.5) * 3,
      ]);
    }
    const assembled = smooth(t / 5.5);
    letters.forEach(([tx, ty], i) => {
      const stale = Math.min(1, staleness[i]);
      const c = GREEN.map((g, k) => Math.floor(g + (AMBER[k] - g) * stale));
      dot((0.04 + hash(i + 401) * 0.92) * w * (1 - assembled) + tx * assembled,
        (0.04 + hash(i + 1601) * 0.92) * h * (1 - assembled) + ty * assembled, c);
    });
    for (const [x, y] of flights) dot(x, y, GREEN);
    return px;
  }

  // Braille cells are 2×4 dots in a terminal cell about twice as tall as it is wide.
  let cw, ch, ox, oy, r;
  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * ratio; canvas.height = H * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    cw = Math.min(W / (GW / 2), H / (GH / 4) / 2);
    ch = cw * 2;
    ox = (W - (GW / 2) * cw) / 2; oy = (H - (GH / 4) * ch) / 2;
    r = Math.max(0.35, cw * 0.20);
  }
  const shade = (c) => (light && (c === STREAM || c === STREAM_HI) ? [190, 214, 210] : c);
  function draw(t, ambient = true) {
    const px = cloud(t, ambient);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (let row = 0; row < GH / 4; row++) {
      for (let col = 0; col < GW / 2; col++) {
        // Color each dot independently: a nearby amber letter must never tint
        // a passing green repair particle in the same braille cell.
        for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
          const c = px[row * 4 + y][col * 2 + x];
          if (!c) continue;
          const [cr, cg, cb] = shade(c);
          ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
          ctx.beginPath();
          ctx.arc(ox + (col + (x ? 0.68 : 0.32)) * cw, oy + row * ch + (y + 0.5) * (ch / 4), r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // Two-thirds of the terminal's pace: calmer on a page that stays open.
  const SPEED = 0.67;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  resize();
  window.addEventListener("resize", () => { resize(); if (still) draw(31, false); });
  if (still) draw(31, false);
  else {
    // The CLI starts its clock at 5.5 s: the word is assembled from the first frame.
    let visible = true, running = false;
    const start = performance.now();
    const loop = (now) => {
      if (!visible || document.hidden) { running = false; return; }
      draw(((now - start) / 1000) * SPEED + 5.5);
      requestAnimationFrame(loop);
    };
    const wake = () => { if (!running && visible && !document.hidden) { running = true; requestAnimationFrame(loop); } };
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; wake(); }).observe(canvas);
    document.addEventListener("visibilitychange", wake);
    wake();
  }
}
