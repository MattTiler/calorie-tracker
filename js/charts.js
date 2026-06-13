// charts.js — minimal dependency-free canvas charts (line + bars).

function setupCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || canvas.clientWidth || 300;
  const h = rect.height || canvas.clientHeight || 160;
  canvas.width = w * ratio;
  canvas.height = h * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  return { ctx, w, h };
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Round a range to a "nice" number (1/2/5 × 10ⁿ) for clean axis ticks.
function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range));
  const f = range / Math.pow(10, exp);
  const nf = round
    ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10)
    : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
  return nf * Math.pow(10, exp);
}

// Given a data range, return tidy axis bounds + step for ~maxTicks gridlines.
function niceScale(lo, hi, maxTicks = 4) {
  const step = niceNum(niceNum(hi - lo || 1, false) / Math.max(1, maxTicks - 1), true);
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

// Format a tick value with just enough decimals for its step size.
function fmtTick(v, step) {
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return v.toFixed(dec);
}

// points: [{ label, value }]. goal (optional) draws a dashed reference line.
export function lineChart(canvas, points, { goal = null } = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) { drawEmpty(ctx, w, h); return; }

  const padL = 42, padR = 10, padT = 12, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const values = points.map(p => p.value);
  // Scale to the data range (not 0) so small changes are visible, rounded to
  // nice steps so the axis can be labelled with clear, evenly-spaced values.
  let lo = Math.min(...values, goal != null ? goal : Infinity);
  let hi = Math.max(...values, goal != null ? goal : -Infinity);
  if (lo === hi) { lo -= 1; hi += 1; }
  const { min, max, step } = niceScale(lo, hi, 4);
  // Position points along x by their actual time (if given) so a 6-day gap is
  // six times wider than a 1-day gap; otherwise fall back to even spacing.
  const useTime = points.every(p => typeof p.t === 'number');
  const ts = useTime ? points.map(p => p.t) : [];
  const tMin = useTime ? Math.min(...ts) : 0, tMax = useTime ? Math.max(...ts) : 0;
  const x = (p, i) => {
    if (points.length === 1) return padL + plotW / 2;
    if (useTime) return padL + (tMax === tMin ? plotW / 2 : ((p.t - tMin) / (tMax - tMin)) * plotW);
    return padL + (i / (points.length - 1)) * plotW;
  };
  const y = v => padT + plotH - ((v - min) / (max - min)) * plotH;

  const grid = cssVar('--border', '#e2e2e2');
  const accent = cssVar('--accent', '#2e7d32');
  const text = cssVar('--muted', '#777');

  // horizontal gridlines + y-axis labels at each nice tick
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  const nTicks = Math.round((max - min) / step);
  for (let i = 0; i <= nTicks; i++) {
    const v = min + i * step;
    const gy = y(v);
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(w - padR, gy);
    ctx.stroke();
    ctx.fillStyle = text;
    ctx.textAlign = 'right';
    ctx.fillText(fmtTick(v, step), padL - 6, gy + 4);
  }

  // goal line
  if (goal != null) {
    ctx.strokeStyle = text;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y(goal));
    ctx.lineTo(w - padR, y(goal));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // line
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => { i === 0 ? ctx.moveTo(x(p, i), y(p.value)) : ctx.lineTo(x(p, i), y(p.value)); });
  ctx.stroke();

  // dots (skipped when crowded so dense ranges stay readable)
  if (points.length <= 31) {
    ctx.fillStyle = accent;
    points.forEach((p, i) => { ctx.beginPath(); ctx.arc(x(p, i), y(p.value), 3, 0, Math.PI * 2); ctx.fill(); });
  }

  // x labels (first, middle, last)
  ctx.fillStyle = text;
  ctx.textAlign = 'center';
  const idxs = points.length <= 2 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  idxs.forEach(i => ctx.fillText(points[i].label, x(points[i], i), h - 6));
}

// points: [{ label, value }]. goal (optional) tints bars over goal.
export function barChart(canvas, points, { goal = null } = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) { drawEmpty(ctx, w, h); return; }

  const padL = 38, padR = 10, padT = 12, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const max = Math.max(...points.map(p => p.value), goal || 0, 1);
  const accent = cssVar('--accent', '#2e7d32');
  const over = cssVar('--danger', '#c62828');
  const text = cssVar('--muted', '#777');

  ctx.fillStyle = text;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(Math.round(max), padL - 6, padT + 8);

  const gap = 4;
  const bw = plotW / points.length;
  points.forEach((p, i) => {
    const bh = (p.value / max) * plotH;
    const bx = padL + i * bw + gap / 2;
    const by = padT + plotH - bh;
    ctx.fillStyle = (goal && p.value > goal) ? over : accent;
    ctx.fillRect(bx, by, bw - gap, bh);
  });

  if (goal != null) {
    const gy = padT + plotH - (goal / max) * plotH;
    ctx.strokeStyle = text;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(w - padR, gy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = text;
  ctx.textAlign = 'center';
  const idxs = points.length <= 2 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  idxs.forEach(i => ctx.fillText(points[i].label, padL + i * bw + bw / 2, h - 6));
}

function drawEmpty(ctx, w, h) {
  ctx.fillStyle = cssVar('--muted', '#999');
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('No data yet', w / 2, h / 2);
}
