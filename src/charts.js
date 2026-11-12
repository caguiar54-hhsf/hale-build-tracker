// Small, dependency-free SVG charts drawn at the container's real width.
// Colors come from CSS classes (theme tokens), so light/dark follow the app.
// Every chart: one y-axis, recessive grid, legend for 2+ series, hover/tap tooltip, keyboard steps.

const NS = "http://www.w3.org/2000/svg";
const fmtShort = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `$${Math.round(n)}`;
};
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* Months from the first key to the later of the last key or `until` (YYYY-MM strings) */
export function monthRange(keys, until) {
  const ks = [...keys].filter(Boolean).sort();
  if (!ks.length) return [];
  let [y, m] = ks[0].split("-").map(Number);
  const end = [ks[ks.length - 1], until].filter(Boolean).sort().pop();
  const out = [];
  while (true) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    out.push(k);
    if (k >= end || out.length > 120) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
export const monthLabel = (k, long) => {
  const [y, m] = k.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("en-US", long ? { month: "long", year: "numeric" } : { month: "short" });
};

function frame(el, opts) {
  const W = Math.max(260, Math.floor(el.clientWidth));
  const H = opts.height || (W < 480 ? 190 : 220);
  const pad = { l: 44, r: opts.padRight ?? 14, t: 14, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  return { W, H, pad, iw, ih };
}
function axes({ W, pad, iw, ih }, ymax, xLabels, xAt) {
  // pick a tick count that gives round steps ($50k, not $62.5k)
  const ticks = [4, 5, 3, 2].find((t) => { const s = ymax / t, m = s / Math.pow(10, Math.floor(Math.log10(s))); return [1, 2, 2.5, 5].some((x) => Math.abs(m - x) < 1e-9); }) || 4;
  let g = "";
  for (let i = 0; i <= ticks; i++) {
    const v = (ymax / ticks) * i, y = pad.t + ih - (v / ymax) * ih;
    g += `<line class="ch-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>`;
    g += `<text class="ch-ylab" x="${pad.l - 8}" y="${y + 4}" text-anchor="end">${fmtShort(v)}</text>`;
  }
  const minGap = 38; let last = -1e9;
  xLabels.forEach((lab, i) => {
    const x = xAt(i);
    if (x - last < minGap && i !== xLabels.length - 1) return;
    if (i === xLabels.length - 1 && x - last < minGap && last > -1e9) return;
    g += `<text class="ch-xlab" x="${x}" y="${pad.t + ih + 18}" text-anchor="middle">${esc(lab)}</text>`;
    last = x;
  });
  return g;
}
function wireHover(el, svg, n, xAt, html, onIndex) {
  const tip = el.querySelector(".ch-tip");
  let cur = -1;
  const show = (i) => {
    if (i < 0 || i >= n) return hide();
    cur = i; onIndex(i);
    tip.innerHTML = html(i); tip.hidden = false;
    const x = xAt(i) * (el.clientWidth / svg.viewBox.baseVal.width);
    const tw = tip.offsetWidth, cw = el.clientWidth;
    const right = x + 16 + tw <= cw; tip.style.left = `${right ? x + 16 : Math.max(0, x - 16 - tw)}px`;
  };
  const hide = () => { cur = -1; tip.hidden = true; onIndex(-1); };
  const idxAt = (clientX) => {
    const r = svg.getBoundingClientRect(); const x = (clientX - r.left) * (svg.viewBox.baseVal.width / r.width);
    let best = 0, bd = Infinity; for (let i = 0; i < n; i++) { const d = Math.abs(xAt(i) - x); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  svg.addEventListener("pointermove", (e) => show(idxAt(e.clientX)));
  svg.addEventListener("pointerdown", (e) => show(idxAt(e.clientX)));
  svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
  el.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { show(Math.min(n - 1, cur + 1)); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { show(Math.max(0, cur < 0 ? n - 1 : cur - 1)); e.preventDefault(); }
    else if (e.key === "Escape") hide();
  });
  el.addEventListener("blur", hide);
}
function mount(el, svgMarkup, { W, H }, label) {
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(label)}">${svgMarkup}</svg><div class="ch-tip" hidden></div>`;
  return el.querySelector("svg");
}
const roundTop = (x, y, w, h, r) => {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

/* Stacked monthly columns. series: [{key,label,cls}], rows: [{month, values:{key:n}}] */
export function stackedColumns(el, { series, rows, label }) {
  const f = frame(el, {}); const { pad, iw, ih } = f; const n = rows.length;
  const tot = rows.map((r) => series.reduce((a, s) => a + (r.values[s.key] || 0), 0));
  const ymax = niceMax(Math.max(...tot, 1));
  const band = iw / n, bw = Math.max(6, Math.min(30, band * 0.62));
  const xAt = (i) => pad.l + band * i + band / 2;
  const yOf = (v) => (v / ymax) * ih;
  let g = axes(f, ymax, rows.map((r, i) => (r.month.endsWith("-01") || i === 0 ? `${monthLabel(r.month)} ’${r.month.slice(2, 4)}` : monthLabel(r.month))), xAt);
  rows.forEach((r, i) => {
    let base = pad.t + ih; const x = xAt(i) - bw / 2;
    const segs = series.map((s) => ({ s, v: r.values[s.key] || 0 })).filter((z) => z.v > 0);
    g += `<g class="ch-col" data-i="${i}">`;
    segs.forEach((z, j) => {
      const h = yOf(z.v); const top = j === segs.length - 1;
      const y = base - h; const gap = j > 0 ? 2 : 0;           // 2px surface gap between stacked segments
      const hh = Math.max(0, h - gap);
      g += top ? `<path class="${z.s.cls}" d="${roundTop(x, y, bw, hh, 4)}"/>` : `<rect class="${z.s.cls}" x="${x}" y="${y}" width="${bw}" height="${hh}"/>`;
      base = y;
    });
    g += `</g>`;
  });
  g += `<line class="ch-base" x1="${pad.l}" x2="${f.W - pad.r}" y1="${pad.t + ih}" y2="${pad.t + ih}"/>`;
  const svg = mount(el, g, f, label);
  const cols = [...svg.querySelectorAll(".ch-col")];
  wireHover(el, svg, n, xAt, (i) => {
    const r = rows[i];
    return `<b>${monthLabel(r.month, true)}</b>${series.map((s) => `<div><i class="sw ${s.cls}"></i>${esc(s.label)}<span>${fmt(r.values[s.key] || 0)}</span></div>`).join("")}<div class="tot">Total<span>${fmt(tot[i])}</span></div>`;
  }, (i) => cols.forEach((c, j) => c.classList.toggle("dim", i >= 0 && j !== i)));
}

/* Lines over months, with optional dashed reference lines (budget, loan amount). */
export function lines(el, { series, months, refs = [], label, height }) {
  const f = frame(el, { height, padRight: 64 }); const { pad, iw, ih, W } = f; const n = months.length;
  const allV = series.flatMap((s) => s.values).concat(refs.map((r) => r.value));
  const ymax = niceMax(Math.max(...allV, 1) * 1.04);
  const xAt = (i) => (n === 1 ? pad.l + iw / 2 : pad.l + (iw * i) / (n - 1));
  const yAt = (v) => pad.t + ih - (v / ymax) * ih;
  let g = axes(f, ymax, months.map((m, i) => (m.endsWith("-01") || i === 0 ? `${monthLabel(m)} ’${m.slice(2, 4)}` : monthLabel(m))), xAt);
  refs.forEach((r) => {
    const y = yAt(r.value);
    g += `<line class="ch-ref" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text class="ch-reflab" x="${W - pad.r + 6}" y="${y + 4}">${esc(r.label)}</text>`;
  });
  series.forEach((s) => {
    const pts = s.values.map((v, i) => [xAt(i), yAt(v)]);
    let d = "";
    pts.forEach(([x, y], i) => {
      if (i === 0) d += `M${x},${y}`;
      else if (s.step) d += `H${x}V${y}`;
      else d += `L${x},${y}`;
    });
    if (s.area && n > 1) g += `<path class="${s.cls} ch-area" d="${d}L${pts[n - 1][0]},${pad.t + ih}L${pts[0][0]},${pad.t + ih}Z"/>`;
    g += `<path class="${s.cls} ch-line" d="${d}"/>`;
    if (s.dots && n <= 24) pts.slice(0, -1).forEach(([x, y]) => { g += `<circle class="${s.cls} ch-pt" cx="${x}" cy="${y}" r="3"/>`; });
    const [lx, ly] = pts[n - 1];
    g += `<circle class="${s.cls} ch-end" cx="${lx}" cy="${ly}" r="4"/>`;
    if (s.endLabel !== false) g += `<text class="ch-endlab" x="${lx + 8}" y="${ly + 4}">${fmtShort(s.values[n - 1])}</text>`;
  });
  g += `<line class="ch-cross" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>`;
  g += series.map((s) => `<circle class="${s.cls} ch-dot" r="4" cx="0" cy="0" visibility="hidden"/>`).join("");
  const svg = mount(el, g, f, label);
  const cross = svg.querySelector(".ch-cross"); const dots = [...svg.querySelectorAll(".ch-dot")];
  wireHover(el, svg, n, xAt, (i) =>
    `<b>${monthLabel(months[i], true)}</b>${series.map((s) => `<div>${series.length > 1 ? `<i class="sw ${s.cls}"></i>` : ""}${esc(s.label)}<span>${fmt(s.values[i])}</span></div>`).join("")}`,
    (i) => {
      const on = i >= 0; cross.setAttribute("visibility", on ? "visible" : "hidden");
      dots.forEach((d, j) => { d.setAttribute("visibility", on ? "visible" : "hidden"); if (on) { d.setAttribute("cx", xAt(i)); d.setAttribute("cy", yAt(series[j].values[i])); } });
      if (on) { cross.setAttribute("x1", xAt(i)); cross.setAttribute("x2", xAt(i)); }
    });
}

/* Overlaid monthly columns: a pale "back" total (e.g. funded to date) with a solid "front" amount inside it
   (e.g. spent to date). The pale part showing above the solid part is what's left. */
export function overlayColumns(el, { rows, back, front, refs = [], label, gapLabel = "Left" }) {
  const f = frame(el, { padRight: refs.length ? 52 : 14 }); const { pad, iw, ih, W } = f; const n = rows.length;
  const ymax = niceMax(Math.max(...rows.map((r) => Math.max(r.back, r.front)), ...refs.map((r) => r.value), 1) * 1.04);
  const band = iw / n, bw = Math.max(8, Math.min(34, band * 0.6));
  const xAt = (i) => pad.l + band * i + band / 2;
  const yAt = (v) => pad.t + ih - (v / ymax) * ih;
  let g = axes(f, ymax, rows.map((r, i) => (r.month.endsWith("-01") || i === 0 ? `${monthLabel(r.month)} ’${r.month.slice(2, 4)}` : monthLabel(r.month))), xAt);
  refs.forEach((r) => { const y = yAt(r.value);
    g += `<line class="ch-ref" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text class="ch-reflab" x="${W - pad.r + 6}" y="${y + 4}">${esc(r.label)}</text>`; });
  rows.forEach((r, i) => {
    const x = xAt(i) - bw / 2; const base = pad.t + ih;
    g += `<g class="ch-col" data-i="${i}">`;
    if (r.back > 0) { const h = base - yAt(r.back); g += `<path class="${back.cls} ch-back" d="${roundTop(x, base - h, bw, h, 4)}"/>`; }
    if (r.front > 0) { const h = base - yAt(r.front); g += `<path class="${front.cls}" d="${roundTop(x, base - h, bw, h, r.front >= r.back ? 4 : 0)}"/>`; }
    g += `</g>`;
  });
  g += `<line class="ch-base" x1="${pad.l}" x2="${W - pad.r}" y1="${pad.t + ih}" y2="${pad.t + ih}"/>`;
  const svg = mount(el, g, f, label);
  const cols = [...svg.querySelectorAll(".ch-col")];
  wireHover(el, svg, n, xAt, (i) => { const r = rows[i]; const gap = r.back - r.front;
    return `<b>${monthLabel(r.month, true)}</b><div><i class="sw ${back.cls} ch-backsw"></i>${esc(back.label)}<span>${fmt(r.back)}</span></div><div><i class="sw ${front.cls}"></i>${esc(front.label)}<span>${fmt(r.front)}</span></div><div class="tot">${gap < 0 ? "Paid ahead of funding" : esc(gapLabel)}<span>${fmt(Math.abs(gap))}</span></div>`;
  }, (i) => cols.forEach((c, j) => c.classList.toggle("dim", i >= 0 && j !== i)));
}

let fmt = (n) => `$${Math.round(n).toLocaleString()}`;
export const setMoneyFormat = (f) => { fmt = f; };
