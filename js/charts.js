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

// points: [{ label, value }]. goal (optional) draws a dashed reference line.
export function lineChart(canvas, points, { goal = null } = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) { drawEmpty(ctx, w, h); return; }

  const padL = 38, padR = 10, padT = 12, padB = 22;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const values = points.map(p => p.value);
  let max = Math.max(...values, goal || 0);
  let min = Math.min(...values, 0);
  if (max === min) max = min + 1;
  const x = i => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = v => padT + plotH - ((v - min) / (max - min)) * plotH;

  const grid = cssVar('--border', '#e2e2e2');
  const accent = cssVar('--accent', '#2e7d32');
  const text = cssVar('--muted', '#777');

  // axes labels (min / max)
  ctx.fillStyle = text;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(Math.round(max), padL - 6, padT + 8);
  ctx.fillText(Math.round(min), padL - 6, padT + plotH);

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
  points.forEach((p, i) => { i === 0 ? ctx.moveTo(x(i), y(p.value)) : ctx.lineTo(x(i), y(p.value)); });
  ctx.stroke();

  // dots
  ctx.fillStyle = accent;
  points.forEach((p, i) => { ctx.beginPath(); ctx.arc(x(i), y(p.value), 3, 0, Math.PI * 2); ctx.fill(); });

  // x labels (first, middle, last)
  ctx.fillStyle = text;
  ctx.textAlign = 'center';
  const idxs = points.length <= 2 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  idxs.forEach(i => ctx.fillText(points[i].label, x(i), h - 6));
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
