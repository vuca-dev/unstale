// Copy buttons, the package filter, and the home page's wordmark: a port of the CLI's init animation
// (`cloud_with` in local/cli/src/onboarding_ui.rs): the same 128×40 grid of braille sub-dots, ambient streams, and
// patches that go stale amber until green repair particles land on them. Each braille cell takes the colour of its
// brightest dot, as in the terminal. A still, healed frame when the visitor prefers reduced motion.
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
if (canvas && window.UNSTALE_GLYPHS) {
  const ctx = canvas.getContext("2d");
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const smooth = (p) => { p = Math.min(1, Math.max(0, p)); return p * p * (3 - 2 * p); };
  const GREEN = [103, 220, 145], AMBER = [232, 172, 94], REPAIR = [45, 151, 123];
  const STREAM = [37, 80, 80], STREAM_HI = [23, 150, 145];
  const light = matchMedia("(prefers-color-scheme: light)").matches;
  const SCALE = 3, GW = 128, GH = 40;

  // The letters' sub-dots, ordered as the CLI's BTreeSet orders them (x, then y): the order feeds the hashes.
  const set = new Set();
  window.UNSTALE_GLYPHS.forEach((glyph, letter) => glyph.forEach((row, y) => [...row].forEach((c, x) => {
    if (c !== "1") return;
    for (let dy = 0; dy < SCALE; dy++)
      for (let dx = 0; dx <= SCALE; dx++) set.add((3 + (letter * 6 + x) * SCALE + dx) * 1000 + 7 + y * SCALE + dy);
  })));
  const letters = [...set].sort((a, b) => a - b).map((k) => [Math.floor(k / 1000), k % 1000]);

  function cloud(t, ambient) {
    const w = GW, h = GH, phase = t % 32;
    const px = Array.from({ length: h }, () => new Array(w).fill(null));
    const dot = (x, y, c) => {
      x = Math.round(x); y = Math.round(y);
      if (x >= 0 && x < w && y >= 0 && y < h) px[y][x] = c;
    };
    if (ambient) {
      for (let side = 0; side < 2; side++) {
        for (let i = 0; i < 180; i++) {
          const seed = i + side * 701;
          const x = ((hash(seed + 50) * (w + 16) + t * (7 + hash(seed + 90) * 4)) % (w + 16)) - 8;
          const arc = Math.sin(Math.PI * Math.min(1, Math.max(0, x / w)));
          const core = side === 0 ? h * 0.12 - arc * h * 0.04 : h * 0.85 + arc * h * 0.045;
          const spread = hash(seed + 200) + hash(seed + 400) + hash(seed + 600) - 1.5;
          const y = core + spread * 3 + Math.sin((x / w) * 9 - t * 0.35 + side * 2) * 0.7;
          dot(x, y, Math.abs(spread) < 0.24 && i % 7 === 0 ? STREAM_HI : STREAM);
        }
      }
    }
    const flurries = new Map();
    const assembled = smooth(t / 5.5);
    letters.forEach(([tx, ty], i) => {
      let stale = 0;
      for (let event = 0; event < 9; event++) {
        const birth = 6.2 + event * 2.2 + hash(event + 701) * 0.5;
        if (phase < birth) continue;
        const target = letters[Math.floor(hash(event + 101) * letters.length)];
        const radius = ((tx - target[0]) / (w * (0.05 + hash(event + 201) * 0.1))) ** 2
          + ((ty - target[1]) / (h * (0.11 + hash(event + 301) * 0.22))) ** 2;
        if (hash(i + event * 911) > 0.78 + hash(event + 401) * 0.22) continue;
        const area = 1 - smooth((radius - 0.3) / 1.1);
        const seed = Math.floor(tx / 3) + Math.floor(ty / 3) * Math.ceil(w / 3) + event * 1999;
        const landing = birth + 2.5 + hash(seed + 3001) * 2.4;
        const duration = 1.2 + hash(seed + 3101) * 0.8;
        const flight = (phase - (landing - duration)) / duration;
        const healed = smooth((phase - landing) / 0.25);
        stale = Math.max(stale, area * smooth((phase - birth) / 0.65) * (1 - healed));
        if (area > 0.25 && flight >= 0 && flight < 1 && !flurries.has(seed)) {
          const p = smooth(flight);
          const sx = tx - 7 - hash(seed + 3201) * 12;
          const low = ty + (hash(seed + 3301) - 0.5) * 5 > h * 0.5;
          const sy = (low ? h * 0.87 : h * 0.08) + (hash(seed + 3401) - 0.5) * 3;
          const curl = Math.sin(Math.PI * flight);
          flurries.set(seed, [
            sx + (tx - sx) * p + curl * (hash(seed + 3501) - 0.5) * 3,
            sy + (ty - sy) * p + curl * (hash(seed + 3601) - 0.5) * 3,
            flight > 0.65 ? GREEN : REPAIR,
          ]);
        }
      }
      const c = GREEN.map((g, k) => Math.floor(g + (AMBER[k] - g) * stale));
      dot((0.04 + hash(i + 401) * 0.92) * w * (1 - assembled) + tx * assembled,
        (0.04 + hash(i + 1601) * 0.92) * h * (1 - assembled) + ty * assembled, c);
    });
    for (const [x, y, c] of [...flurries.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) dot(x, y, c);
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
    r = Math.max(0.7, cw * 0.17);
  }
  const shade = (c) => (light && (c === STREAM || c === STREAM_HI) ? [190, 214, 210] : c);
  function draw(t, ambient = true) {
    const px = cloud(t, ambient);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (let row = 0; row < GH / 4; row++) {
      for (let col = 0; col < GW / 2; col++) {
        let best = null, sum = -1;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
          const c = px[row * 4 + y][col * 2 + x];
          if (c && c[0] + c[1] + c[2] > sum) { best = c; sum = c[0] + c[1] + c[2]; }
        }
        if (!best) continue;
        const [cr, cg, cb] = shade(best);
        ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
          if (!px[row * 4 + y][col * 2 + x]) continue;
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
