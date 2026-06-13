// app.js — Calorie Tracker main application.
import { DB } from './db.js';
import { lineChart, barChart } from './charts.js';
import { OFF } from './off.js';

// Shown in Settings so you can confirm which deployed build the device is running.
// Bump this together with the cache version in sw.js on every deploy.
const APP_VERSION = 'v0.48';

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (n) => Math.round(n);
const round1 = (n) => Math.round(n * 10) / 10;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => toISO(new Date());
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return toISO(d); };

function prettyDate(s) {
  const t = todayStr();
  if (s === t) return 'Today';
  if (s === addDays(t, -1)) return 'Yesterday';
  if (s === addDays(t, 1)) return 'Tomorrow';
  return parseISO(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

// Traffic-light colour for a bar by how close the value is to its target.
// Green within ±15% of target, amber to ±30%, red beyond — same for every bar.
function targetColor(val, target) {
  if (!target) return 'var(--border)';
  const pct = (val / target) * 100;
  if (pct < 70 || pct > 130) return 'var(--danger)';
  if (pct < 85 || pct > 115) return 'var(--warn)';
  return 'var(--ok)';
}

// Label for the Log tab day switcher: always the date, with "(Today)" appended for today.
function dayNavLabel(s) {
  const d = parseISO(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return s === todayStr() ? `${d} (Today)` : d;
}

// You can look back up to a year, and only a few days ahead.
const MAX_FUTURE_DAYS = 3;
const MAX_PAST_DAYS = 365;
const maxLogDate = () => addDays(todayStr(), MAX_FUTURE_DAYS);
const minLogDate = () => addDays(todayStr(), -MAX_PAST_DAYS);

// All tracked per-100g nutrient keys (kcal + macros + extras).
const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'satFat', 'sugars', 'fibre', 'salt'];
const zeroNutrients = () => Object.fromEntries(NUTRIENTS.map(k => [k, 0]));

// nutrition for a given gram amount from a per-100g food (handles missing fields)
const forGrams = (food, grams) => {
  const f = grams / 100;
  const out = {};
  for (const k of NUTRIENTS) out[k] = (food[k] || 0) * f;
  return out;
};

// ---------------------------------------------------------------- state
const state = {
  tab: 'today',
  date: todayStr(),
  foods: [],   // cached food list
  meals: [],   // cached meal list
  goals: null, // set from DEFAULT_GOALS merged with saved
  draftMeal: null,
};

// Sugars & sat fat are daily limits (NHS guide: ~30g free sugars, ~20g sat fat).
const DEFAULT_GOALS = { kcal: 2000, protein: 100, carbs: 250, fat: 70, sugars: 30, satFat: 20, fibre: 30, salt: 6 };

// ---------------------------------------------------------------- init
async function init() {
  await cleanupLegacySeeds();
  const savedGoals = await DB.getSetting('goals', null);
  state.goals = { ...DEFAULT_GOALS, ...(savedGoals || {}) };
  await refreshCaches();

  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $$('[data-close]', $('#modal-root')).forEach(b => b.addEventListener('click', closeModal));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  // Ask the browser to keep our data durable (less likely to be auto-evicted).
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  registerSW();
  switchTab('today');
}

// Remove the old bundled starter foods so the database starts empty.
// Everything added now (search/barcode/manual) is isCustom:true, so any
// isCustom===false record is a legacy seed. Runs every load (cheap, and
// bulletproof against caching), and is a no-op once they're gone.
async function cleanupLegacySeeds() {
  const foods = await DB.getAll('foods');
  const legacy = foods.filter(f => f.isCustom === false);
  for (const f of legacy) await DB.delete('foods', f.id);
}

// Debounced auto-search of Open Food Facts as the user types (polite to the API).
function attachOnlineAutoSearch(input, container, onPick) {
  const run = debounce(() => {
    const q = input.value.trim();
    if (q.length < 3) { container.innerHTML = ''; return; }
    runOnlineSearch(q, container, onPick);
  }, 500);
  input.addEventListener('input', run);
}

async function refreshCaches() {
  state.foods = (await DB.getAll('foods')).sort((a, b) => a.name.localeCompare(b.name));
  state.meals = (await DB.getAll('meals')).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- routing
const TITLES = { today: 'Calorie Log', foods: 'Foods', meals: 'Meals', trends: 'Trends', settings: 'Settings' };

function switchTab(tab) {
  state.tab = tab;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#header-title').textContent = TITLES[tab];
  $('#header-actions').innerHTML = '';
  ({ today: renderToday, foods: renderFoods, meals: renderMeals, trends: renderTrends, settings: renderSettings }[tab])();
}

// ---------------------------------------------------------------- modal & toast
function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal-root').classList.remove('hidden');
  return $('#modal-body');
}
let _modalCleanup = null; // e.g. stop the camera stream when a scan modal closes
function closeModal() {
  if (_modalCleanup) { try { _modalCleanup(); } catch (e) {} _modalCleanup = null; }
  $('#modal-root').classList.add('hidden');
  $('#modal-body').innerHTML = '';
}

let toastTimer = null;
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1900);
}

// ============================================== ONLINE SEARCH & BARCODE
// Combine a product name with its brand for a clear, unique label.
function displayName(food) {
  if (food.brand && !food.name.toLowerCase().includes(food.brand.toLowerCase())) return `${food.name} (${food.brand})`;
  return food.name;
}

// Save a normalized food (from Open Food Facts or a barcode) into the local DB
// if we don't already have it. Returns the stored record (with an id).
async function ensureFoodSaved(food) {
  let existing = null;
  if (food.barcode) existing = state.foods.find(f => f.barcode === food.barcode);
  const label = displayName(food);
  if (!existing) existing = state.foods.find(f => f.name.toLowerCase() === label.toLowerCase());
  if (existing) return existing;

  const rec = { name: label, isCustom: true, source: food.source || 'manual' };
  for (const k of NUTRIENTS) rec[k] = food[k] || 0;
  if (food.barcode) rec.barcode = food.barcode;
  if (food.serving) rec.serving = food.serving;
  const id = await DB.add('foods', rec);
  await refreshCaches();
  return state.foods.find(f => f.id === id) || { ...rec, id };
}

// What to do once we have a (saved) food, depending on where the search started.
async function proceedWithFood(food, mode) {
  if (mode === 'log') quantityStepFood(food);
  else if (mode === 'ingredient') ingredientGrams(food);
  else { await refreshCaches(); renderFoods(); showToast('Added to your foods'); }
}

// Render Open Food Facts results into `container`; onPick gets the normalized food.
async function runOnlineSearch(query, container, onPick) {
  const q = (query || '').trim();
  if (!q) { container.innerHTML = `<div class="empty tiny">Type something to search online.</div>`; return; }
  container.innerHTML = `<div class="empty">Searching Open Food Facts…</div>`;
  try {
    const results = await OFF.search(q);
    if (!results.length) { container.innerHTML = `<div class="empty">No online products found for “${esc(q)}”.</div>`; return; }
    container.innerHTML = `<div class="section-title">Online results</div><ul class="list">${results.map((r, i) => `
      <li class="list-item off-pick" data-i="${i}">
        <div class="li-main"><div class="li-title">🌐 ${esc(displayName(r))}</div>
        <div class="li-sub">${round(r.kcal)} kcal/100g · P ${round1(r.protein)} C ${round1(r.carbs)} F ${round1(r.fat)}</div></div>
        <span class="kcal-pill">+</span></li>`).join('')}</ul>`;
    $$('.off-pick', container).forEach(li => li.onclick = () => onPick(results[Number(li.dataset.i)]));
  } catch (e) {
    container.innerHTML = `<div class="empty">Couldn’t reach the online database.<br><span class="tiny muted">Check your internet connection. (${esc(e.message)})</span></div>`;
  }
}

// Look up a scanned/typed barcode: local first (offline), then Open Food Facts.
// Extract a product barcode (GTIN) from scanned text. Plain EAN/UPC barcodes arrive
// as digits; newer packs (M&S, etc.) use GS1 Digital Link QR codes — a URL with the
// barcode in the /01/<gtin> segment, e.g.
// https://id.gs1.org/01/05000168123456/10/LOT  →  5000168123456.
function gtinFromScan(text) {
  text = String(text).trim();
  if (/^\d{8,14}$/.test(text)) return text;             // plain barcode number
  const m = text.match(/(?:^|[/?&])01[/=](\d{8,14})/);  // GS1 Digital Link "01" AI
  let code = m && m[1];
  if (!code) { try { code = new URL(text).searchParams.get('01'); } catch (e) {} }
  if (!code || !/^\d{8,14}$/.test(code)) return null;   // e.g. a marketing/recycling URL
  // Digital Link uses GTIN-14 (zero-padded); the on-pack EAN-13 drops a leading zero.
  return code.length === 14 && code.startsWith('0') ? code.slice(1) : code;
}

async function handleBarcode(raw, mode) {
  const code = gtinFromScan(raw);
  if (!code) {
    // Some QR codes (marketing links, internal product codes) don't carry the
    // retail barcode. The striped barcode is the reliable thing to scan.
    showToast('No product barcode in this QR — scan the striped barcode instead');
    return;
  }
  const local = state.foods.find(f => f.barcode === code);
  if (local) { proceedWithFood(local, mode); return; }
  showToast('Looking up barcode…');
  try {
    const food = await OFF.barcode(code);
    if (!food) {
      showToast('Not found — add it manually');
      foodForm({ barcode: code });
      return;
    }
    const saved = await ensureFoodSaved(food);
    proceedWithFood(saved, mode);
  } catch (e) {
    alert('Barcode lookup failed: ' + e.message);
  }
}

// Camera barcode scanner using the bundled ZXing library (works in Safari/iOS,
// Chrome, etc.). Falls back to manual barcode entry if the camera is unavailable.
async function openScanModal(mode) {
  const canScan = !!(window.ZXing && navigator.mediaDevices?.getUserMedia && window.isSecureContext);
  const body = openModal('Scan barcode', `
    ${canScan
      ? `<video id="scan-vid" playsinline muted style="width:100%;border-radius:12px;background:#000;aspect-ratio:3/4;object-fit:cover"></video>
         <p class="tiny muted" id="scan-status" style="text-align:center">Point the camera at a barcode…</p>`
      : `<p class="muted tiny">Camera scanning needs an HTTPS page with camera permission. Type the barcode number below instead.</p>`}
    <div class="field"><label>Barcode number</label><input id="scan-manual" inputmode="numeric" placeholder="e.g. 5000119410436" /></div>
    <button class="btn btn-primary btn-block" id="scan-lookup">Look up</button>`);

  const finish = (code) => { closeModal(); handleBarcode(code, mode); };
  $('#scan-lookup', body).onclick = () => finish($('#scan-manual', body).value);

  if (!canScan) { setTimeout(() => $('#scan-manual', body).focus(), 50); return; }

  const reader = new ZXing.BrowserMultiFormatReader();
  let done = false;
  _modalCleanup = () => { try { reader.reset(); } catch (e) {} };
  try {
    await reader.decodeFromConstraints(
      // Higher resolution lets dense QR codes (e.g. GS1 Digital Link) decode from
      // further away instead of needing the phone right up against the pack.
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
      $('#scan-vid', body),
      (result) => { if (result && !done) { done = true; finish(result.getText()); } }
    );
  } catch (e) {
    const s = $('#scan-status', body);
    if (s) s.textContent = 'Camera unavailable — type the barcode below. (' + (e?.message || e) + ')';
  }
}

// ================================================================ TODAY
async function renderToday() {
  const view = $('#view');
  const entries = await DB.getLogByDate(state.date);
  const total = entries.reduce((a, e) => { for (const k of NUTRIENTS) a[k] += (e[k] || 0); return a; }, zeroNutrients());

  const g = state.goals;
  const pct = g.kcal ? Math.min(100, (total.kcal / g.kcal) * 100) : 0;
  const over = total.kcal > g.kcal;
  const remaining = g.kcal - total.kcal;

  // macro tile: bar fills toward goal; optional sub-figure (e.g. "sugars 12g")
  const macroBar = (cls, label, val, goal, extra = '') => `
    <div class="macro ${cls}">
      <div class="mlabel">${label}</div>
      <div class="mval">${round1(val)}g</div>
      <div class="mbar"><span style="width:${goal ? Math.min(100, (val / goal) * 100) : 0}%;background:${targetColor(val, goal)}"></span></div>
      <div class="tiny muted">${goal ? `/ ${goal}g` : ''}${extra ? `${goal ? ' · ' : ''}${extra}` : ''}</div>
    </div>`;

  // fibre = aim to reach goal; sugars/sat fat/salt = stay under a limit (red when over)
  const extraStat = (cls, label, val, goal, isLimit) => `
    <div class="macro ${cls}">
      <div class="mlabel">${label}</div>
      <div class="mval">${round1(val)}g</div>
      <div class="mbar"><span style="width:${goal ? Math.min(100, (val / goal) * 100) : 0}%;background:${targetColor(val, goal)}"></span></div>
      <div class="tiny muted">${isLimit ? `limit ${goal}g` : `aim ${goal}g`}</div>
    </div>`;

  view.innerHTML = `
    <div class="date-nav">
      <button class="icon-btn" id="prev-day" aria-label="Previous day" ${state.date <= minLogDate() ? 'disabled' : ''}>‹</button>
      <span class="date-label">${dayNavLabel(state.date)}</span>
      <button class="icon-btn" id="next-day" aria-label="Next day" ${state.date >= maxLogDate() ? 'disabled' : ''}>›</button>
    </div>

    <div class="card summary">
      <div class="big">${round(total.kcal)} <small>/ ${g.kcal} kcal</small></div>
      <div class="sub">${over ? `${round(-remaining)} kcal over goal` : `${round(remaining)} kcal remaining`}</div>
      <div class="progress"><span style="width:${pct}%;background:${targetColor(total.kcal, g.kcal)}"></span></div>
      <div class="macros">
        ${macroBar('p', 'Protein', total.protein, g.protein)}
        ${extraStat('p', 'Fibre', total.fibre, g.fibre, false)}
        ${extraStat('f', 'Salt', total.salt, g.salt, true)}
      </div>
      <div class="macros" style="grid-template-columns:repeat(2,1fr)">
        ${macroBar('c', 'Carbs', total.carbs, g.carbs)}
        ${macroBar('f', 'Fat', total.fat, g.fat)}
        ${extraStat('c', 'Sugars', total.sugars, g.sugars, true)}
        ${extraStat('f', 'Sat fat', total.satFat, g.satFat, true)}
      </div>
    </div>

    <button class="btn btn-primary btn-block" id="add-log">+ Add food / meal</button>

    <div class="section-title">Logged${entries.length ? ` (${entries.length})` : ''}</div>
    <div class="card">
      ${entries.length ? `<ul class="list">${entries.map(logRow).join('')}</ul>`
        : `<div class="empty">Nothing logged yet.<br>Tap “Add food / meal” to start.</div>`}
    </div>`;

  // Calendar jump lives in the header, top-right, level with the title.
  $('#header-actions').innerHTML = `<button class="icon-btn" id="cal-day" aria-label="Pick a date">📅</button>`;
  $('#cal-day').onclick = openDatePicker;

  $('#prev-day').onclick = () => {
    if (state.date <= minLogDate()) return; // capped a year back
    state.date = addDays(state.date, -1); renderToday();
  };
  $('#next-day').onclick = () => {
    if (state.date >= maxLogDate()) return; // capped a few days ahead
    state.date = addDays(state.date, 1); renderToday();
  };
  $('#add-log').onclick = openAddToLog;

  $$('.log-del', view).forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    await DB.delete('log', Number(b.dataset.id));
    showToast('Removed');
    renderToday();
  });
  $$('.log-row[data-kind="food"]', view).forEach(row => row.onclick = () => editFoodLogEntry(Number(row.dataset.id)));
}

// Custom month calendar so dates outside the allowed range are genuinely
// unselectable (the native iOS picker ignores min/max and lets you spin freely).
// Tap a day to highlight it, then Select to confirm — a misclick is recoverable.
function openDatePicker() {
  const max = maxLogDate(), min = minLogDate();
  const start = parseISO(state.date);
  let vy = start.getFullYear(), vm = start.getMonth();
  let selected = state.date;

  const body = openModal('Pick a date', `
    <div id="cal-wrap"></div>
    <button class="btn btn-primary btn-block" id="cal-confirm" style="margin-top:14px">Select</button>`);

  const draw = () => {
    const first = new Date(vy, vm, 1);
    const pad = (first.getDay() + 6) % 7;            // Monday-first offset
    const days = new Date(vy, vm + 1, 0).getDate();
    const canNext = toISO(new Date(vy, vm + 1, 1)) <= max;  // next month has selectable days?
    const canPrev = toISO(new Date(vy, vm, 0)) >= min;      // prev month's last day still allowed?

    // One grid for weekday labels + days, so columns can never drift out of line.
    const items = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<span class="cal-dowlabel">${d}</span>`);
    for (let i = 0; i < pad; i++) items.push('<span class="cal-cell empty"></span>');
    for (let d = 1; d <= days; d++) {
      const iso = toISO(new Date(vy, vm, d));
      const off = iso > max || iso < min;
      const cls = ['cal-cell'];
      if (off) cls.push('disabled');
      if (iso === todayStr()) cls.push('today');
      if (iso === selected) cls.push('sel');
      items.push(`<button class="${cls.join(' ')}" ${off ? 'disabled' : `data-iso="${iso}"`}>${d}</button>`);
    }

    $('#cal-wrap', body).innerHTML = `
      <div class="cal-head">
        <button class="icon-btn" id="cal-prev" aria-label="Previous month" ${canPrev ? '' : 'disabled'}>‹</button>
        <span class="cal-month">${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button class="icon-btn" id="cal-next" aria-label="Next month" ${canNext ? '' : 'disabled'}>›</button>
      </div>
      <div class="cal-grid">${items.join('')}</div>`;

    if (canPrev) $('#cal-prev', body).onclick = () => { if (--vm < 0) { vm = 11; vy--; } draw(); };
    if (canNext) $('#cal-next', body).onclick = () => { if (++vm > 11) { vm = 0; vy++; } draw(); };
    $$('.cal-cell[data-iso]', body).forEach(c => c.onclick = () => { selected = c.dataset.iso; draw(); });
  };

  $('#cal-confirm', body).onclick = () => { state.date = selected; closeModal(); renderToday(); };
  draw();
}

function logRow(e) {
  const sub = e.kind === 'food' ? `${round1(e.grams)} g` : `${round1(e.servings)} serving${e.servings === 1 ? '' : 's'}`;
  return `
    <li class="list-item log-row" data-id="${e.id}" data-kind="${e.kind}">
      <div class="li-main">
        <div class="li-title">${e.kind === 'meal' ? '🍲 ' : ''}${esc(e.name)}</div>
        <div class="li-sub">${sub} · P ${round1(e.protein)} · C ${round1(e.carbs)} · F ${round1(e.fat)}</div>
      </div>
      <div class="li-kcal">${round(e.kcal)}</div>
      <button class="icon-btn log-del" data-id="${e.id}" aria-label="Remove">✕</button>
    </li>`;
}

// ================================================================ ADD TO LOG
function openAddToLog() {
  // Log search is intentionally local-only: it looks up your saved foods/meals.
  // Add new products from the Foods tab (online search) or via barcode scan here.
  const body = openModal('Add to ' + prettyDate(state.date).toLowerCase(), `
    <div class="chips"><button class="chip" id="add-scan">📷 Scan barcode</button></div>
    <div class="section-title">Your foods & meals</div>
    <div class="search-box"><input id="add-search" placeholder="Search your foods & meals…" autocomplete="off" /></div>
    <div id="add-results"></div>`);
  const search = $('#add-search', body);
  const render = () => renderAddResults(search.value.trim().toLowerCase());
  search.addEventListener('input', render);
  render();
  $('#add-scan', body).onclick = () => openScanModal('log');
  setTimeout(() => search.focus(), 50);
}

function renderAddResults(q) {
  const matchF = (q ? state.foods.filter(f => f.name.toLowerCase().includes(q)) : state.foods).slice(0, 40);
  const matchM = (q ? state.meals.filter(m => m.name.toLowerCase().includes(q)) : state.meals).slice(0, 40);
  const box = $('#add-results');

  const sections = [];
  if (matchM.length) sections.push(`<ul class="list">${matchM.map(m => `
      <li class="list-item pick" data-type="meal" data-id="${m.id}">
        <div class="li-main"><div class="li-title">🍲 ${esc(m.name)}</div>
        <div class="li-sub">${round(m.perServing.kcal)} kcal / serving · makes ${m.portions}</div></div>
        <span class="kcal-pill">+</span></li>`).join('')}</ul>`);
  if (matchF.length) sections.push(`<ul class="list">${matchF.map(f => `
      <li class="list-item pick" data-type="food" data-id="${f.id}">
        <div class="li-main"><div class="li-title">${esc(f.name)}</div>
        <div class="li-sub">${round(f.kcal)} kcal / 100g</div></div>
        <span class="kcal-pill">+</span></li>`).join('')}</ul>`);

  box.innerHTML = sections.length ? sections.join('')
    : (q.length >= 1 ? `<div class="empty">No saved foods or meals match “${esc(q)}”.<br><span class="tiny">📷 Scan a barcode, or add it from the Foods tab to save it here.</span></div>`
      : `<div class="empty">Search your saved foods & meals.<br><span class="tiny">📷 Scan a barcode, or add new products from the Foods tab.</span></div>`);

  $$('.pick', box).forEach(li => li.onclick = () => {
    const id = Number(li.dataset.id);
    li.dataset.type === 'meal' ? quantityStepMeal(state.meals.find(m => m.id === id))
                               : quantityStepFood(state.foods.find(f => f.id === id));
  });
}

function quantityStepFood(food, existing = null) {
  const defGrams = existing ? existing.grams : (food.serving ? food.serving.grams : 100);
  const chips = [];
  if (food.serving) chips.push({ label: food.serving.label, g: food.serving.grams });
  [50, 100, 150, 200].forEach(g => chips.push({ label: g + 'g', g }));

  const body = openModal(existing ? 'Edit entry' : food.name, `
    <p class="muted tiny" style="margin-top:0">${round(food.kcal)} kcal · P ${round1(food.protein)} C ${round1(food.carbs)} F ${round1(food.fat)} per 100 g</p>
    <div class="chips" id="q-chips">${chips.map(c => `<button class="chip" data-g="${c.g}">${esc(c.label)}</button>`).join('')}</div>
    <div class="field"><label>Amount (grams)</label><input id="q-grams" type="number" inputmode="decimal" min="0" step="1" value="${defGrams}" /></div>
    <div class="card" id="q-preview" style="margin:0 0 14px"></div>
    <button class="btn btn-primary btn-block" id="q-add">${existing ? 'Save' : 'Add to day'}</button>`);

  const input = $('#q-grams', body);
  const preview = () => {
    const grams = parseFloat(input.value) || 0;
    const n = forGrams(food, grams);
    $('#q-preview', body).innerHTML = `<div class="summary"><div class="big">${round(n.kcal)} <small>kcal</small></div>
      <div class="tiny muted">Protein ${round1(n.protein)}g · Carbs ${round1(n.carbs)}g · Fat ${round1(n.fat)}g</div>
      <div class="tiny muted">Sat ${round1(n.satFat)}g · Sugars ${round1(n.sugars)}g · Fibre ${round1(n.fibre)}g · Salt ${round1(n.salt)}g</div></div>`;
  };
  input.addEventListener('input', preview); preview();
  $$('.chip', body).forEach(c => c.onclick = () => { input.value = c.dataset.g; preview(); });

  $('#q-add', body).onclick = async () => {
    const grams = parseFloat(input.value);
    if (!grams || grams <= 0) return showToast('Enter an amount');
    const n = forGrams(food, grams);
    const entry = { date: state.date, kind: 'food', foodId: food.id, name: food.name, grams, ...n };
    if (existing) { entry.id = existing.id; await DB.put('log', entry); }
    else await DB.add('log', entry);
    closeModal(); showToast(existing ? 'Updated' : 'Added'); renderToday();
  };
}

function quantityStepMeal(meal) {
  const body = openModal(meal.name, `
    <p class="muted tiny" style="margin-top:0">${round(meal.perServing.kcal)} kcal per serving · recipe makes ${meal.portions}</p>
    <div class="field"><label>Number of servings</label><input id="q-serv" type="number" inputmode="decimal" min="0" step="0.5" value="1" /></div>
    <div class="card" id="q-preview" style="margin:0 0 14px"></div>
    <button class="btn btn-primary btn-block" id="q-add">Add to day</button>`);
  const input = $('#q-serv', body);
  const preview = () => {
    const s = parseFloat(input.value) || 0;
    const p = meal.perServing;
    $('#q-preview', body).innerHTML = `<div class="summary"><div class="big">${round((p.kcal || 0) * s)} <small>kcal</small></div>
      <div class="tiny muted">Protein ${round1((p.protein || 0) * s)}g · Carbs ${round1((p.carbs || 0) * s)}g · Fat ${round1((p.fat || 0) * s)}g</div>
      <div class="tiny muted">Sat ${round1((p.satFat || 0) * s)}g · Sugars ${round1((p.sugars || 0) * s)}g · Fibre ${round1((p.fibre || 0) * s)}g · Salt ${round1((p.salt || 0) * s)}g</div></div>`;
  };
  input.addEventListener('input', preview); preview();

  $('#q-add', body).onclick = async () => {
    const s = parseFloat(input.value);
    if (!s || s <= 0) return showToast('Enter servings');
    const p = meal.perServing;
    const entry = { date: state.date, kind: 'meal', mealId: meal.id, name: meal.name, servings: s };
    for (const k of NUTRIENTS) entry[k] = (p[k] || 0) * s;
    await DB.add('log', entry);
    closeModal(); showToast('Added'); renderToday();
  };
}

async function editFoodLogEntry(id) {
  const entry = (await DB.getLogByDate(state.date)).find(e => e.id === id);
  if (!entry) return;
  let food = state.foods.find(f => f.id === entry.foodId);
  if (!food) { // food was deleted — rebuild per-100g values from the snapshot
    food = { name: entry.name };
    for (const k of NUTRIENTS) food[k] = entry.grams ? (entry[k] || 0) / entry.grams * 100 : 0;
  }
  quantityStepFood(food, entry);
}

// ================================================================ FOODS
function renderFoods() {
  $('#header-actions').innerHTML = '<button class="icon-btn" id="new-food" aria-label="Add food">＋</button>';
  $('#new-food').onclick = () => foodForm();

  const view = $('#view');
  view.innerHTML = `
    <div class="section-title">Search foods</div>
    <div class="chips">
      <button class="chip" id="food-scan">📷 Scan barcode</button>
      <button class="chip" id="food-manual">✎ Add manually</button>
    </div>
    <div class="search-box"><input id="food-search" placeholder="Search a product or food…" autocomplete="off" /></div>
    <div class="card hidden" id="food-list-card"><ul class="list" id="food-list"></ul></div>
    <div id="food-online-results"></div>`;
  const search = $('#food-search', view);
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const list = q ? state.foods.filter(f => f.name.toLowerCase().includes(q)) : state.foods;
    const card = $('#food-list-card', view);
    if (!list.length) {
      card.classList.add('hidden');
      $('#food-list').innerHTML = '';
    } else {
      card.classList.remove('hidden');
      $('#food-list').innerHTML = list.map(f => `
        <li class="list-item">
          <div class="li-main"><div class="li-title">${esc(f.name)}</div>
          <div class="li-sub">${round(f.kcal)} kcal · P ${round1(f.protein)} C ${round1(f.carbs)} F ${round1(f.fat)} / 100g</div></div>
          <div class="row-actions"><button class="icon-btn food-edit" data-id="${f.id}" aria-label="Edit">✎</button></div>
        </li>`).join('');
      $$('.food-edit', view).forEach(b => b.onclick = () => foodForm(state.foods.find(f => f.id === Number(b.dataset.id))));
    }
    // Hint in the online area when there's nothing to show yet.
    const oc = $('#food-online-results', view);
    if (q.length < 3) oc.innerHTML = state.foods.length
      ? (q ? '' : '')
      : `<div class="empty">Search a product name or 📷 scan a barcode to add your first food.<br><span class="tiny">Anything you add is saved here and works offline next time.</span></div>`;
  };
  search.addEventListener('input', render);
  attachOnlineAutoSearch(search, $('#food-online-results', view), async (food) => {
    await ensureFoodSaved(food);
    showToast('Added to your foods');
    search.value = '';
    $('#food-online-results', view).innerHTML = '';
    render();
  });
  $('#food-scan', view).onclick = () => openScanModal('save');
  $('#food-manual', view).onclick = () => foodForm();
  render();
}

function foodForm(food = null) {
  const f = food || {};
  const isEdit = f.id != null;
  const body = openModal(isEdit ? 'Edit food' : 'New food', `
    ${f.barcode ? `<p class="tiny muted" style="margin-top:0">Barcode ${esc(f.barcode)} — not in the online database, so add its details below.</p>` : ''}
    <div class="field"><label>Name</label><input id="f-name" value="${esc(f.name || '')}" placeholder="e.g. Mature cheddar" /></div>
    <p class="section-title" style="margin-left:0">Per 100 g</p>
    <div class="field-row">
      <div class="field"><label>Calories (kcal)</label><input id="f-kcal" type="number" inputmode="decimal" value="${f.kcal ?? ''}" /></div>
      <div class="field"><label>Protein (g)</label><input id="f-protein" type="number" inputmode="decimal" value="${f.protein ?? ''}" /></div>
      <div class="field"><label>Carbs (g)</label><input id="f-carbs" type="number" inputmode="decimal" value="${f.carbs ?? ''}" /></div>
      <div class="field"><label>&nbsp;&nbsp;of which sugars (g)</label><input id="f-sugars" type="number" inputmode="decimal" value="${f.sugars ?? ''}" /></div>
      <div class="field"><label>Fat (g)</label><input id="f-fat" type="number" inputmode="decimal" value="${f.fat ?? ''}" /></div>
      <div class="field"><label>&nbsp;&nbsp;of which saturates (g)</label><input id="f-satfat" type="number" inputmode="decimal" value="${f.satFat ?? ''}" /></div>
      <div class="field"><label>Fibre (g)</label><input id="f-fibre" type="number" inputmode="decimal" value="${f.fibre ?? ''}" /></div>
      <div class="field"><label>Salt (g)</label><input id="f-salt" type="number" inputmode="decimal" value="${f.salt ?? ''}" /></div>
    </div>
    <p class="tiny muted" style="margin-top:-6px">Only calories are required — leave the rest blank if unknown.</p>
    <p class="section-title" style="margin-left:0">Quick serving (optional)</p>
    <div class="field-row">
      <div class="field"><label>Label</label><input id="f-slabel" value="${esc(f.serving?.label || '')}" placeholder="e.g. 1 slice" /></div>
      <div class="field"><label>Weighs (g)</label><input id="f-sgrams" type="number" inputmode="decimal" value="${f.serving?.grams || ''}" /></div>
    </div>
    <button class="btn btn-primary btn-block" id="f-save">${isEdit ? 'Save changes' : 'Add food'}</button>
    ${isEdit && f.isCustom ? '<button class="btn btn-danger btn-block" id="f-del" style="margin-top:8px">Delete food</button>' : ''}`);

  $('#f-save', body).onclick = async () => {
    const num = (id) => parseFloat($(id, body).value) || 0;
    const rec = {
      name: $('#f-name', body).value.trim(),
      kcal: num('#f-kcal'), protein: num('#f-protein'), carbs: num('#f-carbs'), fat: num('#f-fat'),
      satFat: num('#f-satfat'), sugars: num('#f-sugars'), fibre: num('#f-fibre'), salt: num('#f-salt'),
      isCustom: isEdit ? f.isCustom : true,
    };
    if (!rec.name) return showToast('Enter a name');
    if (f.barcode) rec.barcode = f.barcode;
    if (f.source) rec.source = f.source;
    const sl = $('#f-slabel', body).value.trim(), sg = parseFloat($('#f-sgrams', body).value);
    if (sl && sg > 0) rec.serving = { label: sl, grams: sg };
    if (isEdit) { rec.id = f.id; await DB.put('foods', rec); } else await DB.add('foods', rec);
    await refreshCaches(); closeModal(); showToast('Saved'); renderFoods();
  };
  const del = $('#f-del', body);
  if (del) del.onclick = async () => {
    if (!confirm(`Delete “${f.name}”?`)) return;
    await DB.delete('foods', f.id);
    await refreshCaches(); closeModal(); showToast('Deleted'); renderFoods();
  };
}

// ================================================================ MEALS
function computeMealTotals(ingredients) {
  return ingredients.reduce((a, ing) => {
    const n = forGrams(ing.per100, ing.grams);
    for (const k of NUTRIENTS) a[k] += n[k];
    return a;
  }, zeroNutrients());
}

function renderMeals() {
  $('#header-actions').innerHTML = '<button class="icon-btn" id="new-meal" aria-label="New meal">＋</button>';
  $('#new-meal').onclick = () => mealBuilder();

  const view = $('#view');
  view.innerHTML = state.meals.length ? `<div class="card"><ul class="list">${state.meals.map(m => `
    <li class="list-item">
      <div class="li-main"><div class="li-title">🍲 ${esc(m.name)}</div>
      <div class="li-sub">${round(m.perServing.kcal)} kcal / serving · ${m.ingredients.length} ingredients · makes ${m.portions}</div></div>
      <div class="row-actions">
        <button class="icon-btn meal-edit" data-id="${m.id}" aria-label="Edit">✎</button>
      </div>
    </li>`).join('')}</ul></div>`
    : `<div class="empty">No meals yet.<br>Tap ＋ to build one from ingredients.</div>`;

  $$('.meal-edit', view).forEach(b => b.onclick = () => mealBuilder(state.meals.find(m => m.id === Number(b.dataset.id))));
}

function mealBuilder(meal = null) {
  state.draftMeal = meal
    ? { id: meal.id, name: meal.name, portions: meal.portions, ingredients: meal.ingredients.map(i => ({ ...i })) }
    : { name: '', portions: 1, ingredients: [] };
  renderMealBuilder(meal != null);
}

function renderMealBuilder(isEdit) {
  const d = state.draftMeal;
  const totals = computeMealTotals(d.ingredients);
  const portions = d.portions || 1;
  const per = { kcal: totals.kcal / portions, protein: totals.protein / portions, carbs: totals.carbs / portions, fat: totals.fat / portions };

  const body = openModal(isEdit ? 'Edit meal' : 'New meal', `
    <div class="field"><label>Meal name</label><input id="m-name" value="${esc(d.name)}" placeholder="e.g. Chicken curry" /></div>
    <div class="field"><label>How many servings does it make?</label><input id="m-portions" type="number" inputmode="decimal" min="0.5" step="0.5" value="${portions}" /></div>

    <div class="section-title" style="margin-left:0">Ingredients</div>
    <div class="card" style="margin:0 0 12px">
      ${d.ingredients.length ? d.ingredients.map((ing, i) => `
        <div class="ingredient-row">
          <div class="ir-main"><div>${esc(ing.name)}</div>
          <div class="ir-sub">${round1(ing.grams)} g · ${round(forGrams(ing.per100, ing.grams).kcal)} kcal</div></div>
          <button class="icon-btn ing-del" data-i="${i}" aria-label="Remove">✕</button>
        </div>`).join('') : '<div class="muted tiny">No ingredients yet.</div>'}
      <button class="btn btn-block" id="m-add-ing" style="margin-top:10px">+ Add ingredient</button>
    </div>

    <div class="card summary" style="margin:0 0 14px">
      <div class="tiny muted">WHOLE MEAL</div>
      <div class="big">${round(totals.kcal)} <small>kcal</small></div>
      <div class="tiny muted">P ${round1(totals.protein)} · C ${round1(totals.carbs)} · F ${round1(totals.fat)}</div>
      <hr style="border:none;border-top:1px solid var(--border);margin:12px 0">
      <div class="tiny muted">PER SERVING (÷ <span id="m-pcount">${portions}</span>)</div>
      <div class="big" style="color:var(--accent)"><span id="m-pkcal">${round(per.kcal)}</span> <small>kcal</small></div>
      <div class="tiny muted" id="m-pmacro">P ${round1(per.protein)} · C ${round1(per.carbs)} · F ${round1(per.fat)}</div>
    </div>

    <button class="btn btn-primary btn-block" id="m-save">${isEdit ? 'Save meal' : 'Create meal'}</button>
    ${isEdit ? '<button class="btn btn-danger btn-block" id="m-del" style="margin-top:8px">Delete meal</button>' : ''}`);

  // keep field edits in the draft; update per-serving numbers in place (no full re-render → keeps focus)
  $('#m-name', body).addEventListener('input', e => { d.name = e.target.value; });
  $('#m-portions', body).addEventListener('input', e => {
    const p = parseFloat(e.target.value) || 1;
    d.portions = p;
    $('#m-pcount', body).textContent = round1(p);
    $('#m-pkcal', body).textContent = round(totals.kcal / p);
    $('#m-pmacro', body).textContent = `P ${round1(totals.protein / p)} · C ${round1(totals.carbs / p)} · F ${round1(totals.fat / p)}`;
  });

  $$('.ing-del', body).forEach(b => b.onclick = () => { d.ingredients.splice(Number(b.dataset.i), 1); renderMealBuilder(isEdit); });
  $('#m-add-ing', body).onclick = () => pickIngredient(isEdit);

  $('#m-save', body).onclick = async () => {
    d.name = $('#m-name', body).value.trim();
    d.portions = parseFloat($('#m-portions', body).value) || 1;
    if (!d.name) return showToast('Name your meal');
    if (!d.ingredients.length) return showToast('Add at least one ingredient');
    const t = computeMealTotals(d.ingredients);
    const perServing = {};
    for (const k of NUTRIENTS) perServing[k] = t[k] / d.portions;
    const rec = { name: d.name, portions: d.portions, ingredients: d.ingredients, total: t, perServing };
    if (d.id) { rec.id = d.id; await DB.put('meals', rec); } else await DB.add('meals', rec);
    await refreshCaches(); state.draftMeal = null; closeModal(); showToast('Saved'); renderMeals();
  };
  const del = $('#m-del', body);
  if (del) del.onclick = async () => {
    if (!confirm(`Delete “${d.name}”?`)) return;
    await DB.delete('meals', d.id); await refreshCaches(); state.draftMeal = null; closeModal(); showToast('Deleted'); renderMeals();
  };
}

function pickIngredient() {
  const body = openModal('Add ingredient', `
    <div class="section-title">Search foods</div>
    <div class="chips"><button class="chip" id="ing-scan">📷 Scan barcode</button></div>
    <div class="search-box"><input id="ing-search" placeholder="Search a product or food…" autocomplete="off" /></div>
    <div id="ing-results"></div>
    <div id="ing-online-results"></div>`);
  const search = $('#ing-search', body);
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const list = (q ? state.foods.filter(f => f.name.toLowerCase().includes(q)) : state.foods).slice(0, 50);
    $('#ing-results').innerHTML = list.length ? `<ul class="list">${list.map(f => `
      <li class="list-item pick-ing" data-id="${f.id}">
        <div class="li-main"><div class="li-title">${esc(f.name)}</div><div class="li-sub">${round(f.kcal)} kcal / 100g</div></div>
        <span class="kcal-pill">+</span></li>`).join('')}</ul>`
      : (q.length >= 3 ? `<div class="empty tiny">No saved matches — searching online…</div>`
        : `<div class="empty tiny">Search a product, or 📷 scan a barcode.</div>`);
    $$('.pick-ing', body).forEach(li => li.onclick = () => ingredientGrams(state.foods.find(f => f.id === Number(li.dataset.id))));
  };
  search.addEventListener('input', render); render();
  attachOnlineAutoSearch(search, $('#ing-online-results', body),
    async (food) => proceedWithFood(await ensureFoodSaved(food), 'ingredient'));
  $('#ing-scan', body).onclick = () => openScanModal('ingredient');
  setTimeout(() => search.focus(), 50);
}

function ingredientGrams(food) {
  const def = food.serving ? food.serving.grams : 100;
  const body = openModal(food.name, `
    <p class="muted tiny" style="margin-top:0">${round(food.kcal)} kcal / 100 g</p>
    <div class="field"><label>How much did you add? (grams)</label><input id="ing-g" type="number" inputmode="decimal" min="0" value="${def}" /></div>
    <button class="btn btn-primary btn-block" id="ing-ok">Add to meal</button>`);
  $('#ing-ok', body).onclick = () => {
    const grams = parseFloat($('#ing-g', body).value);
    if (!grams || grams <= 0) return showToast('Enter an amount');
    const per100 = {};
    for (const k of NUTRIENTS) per100[k] = food[k] || 0;
    state.draftMeal.ingredients.push({ foodId: food.id, name: food.name, grams, per100 });
    renderMealBuilder(!!state.draftMeal.id);
  };
}

// Log/edit a weight: pick a day on a calendar, then enter the weight. Selecting a
// day that already has a weigh-in pre-fills its value, so you can see and change it.
function openWeightLogger(weightsByDate, initialDate = todayStr()) {
  const max = todayStr(); // no future weigh-ins
  let selected = initialDate;
  const start = parseISO(selected);
  let vy = start.getFullYear(), vm = start.getMonth();

  const body = openModal('Log weight', `
    <div id="wcal"></div>
    <div class="field" style="margin-top:14px">
      <label>Weight (kg) · <span id="w-when"></span></label>
      <input id="w-input" type="number" inputmode="decimal" step="0.1" placeholder="e.g. 78.5" />
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" id="w-confirm" style="flex:1">Log weight</button>
      <button class="btn" id="w-delete" aria-label="Delete this day's weight" style="flex:0 0 56px;background:var(--danger);color:#fff;display:flex;align-items:center;justify-content:center;padding:0">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>`);

  const whenLabel = () => selected === todayStr()
    ? 'today'
    : parseISO(selected).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  const sync = () => {
    const existing = weightsByDate[selected];
    $('#w-input', body).value = existing != null ? existing : '';
    $('#w-when', body).textContent = whenLabel();
    $('#w-delete', body).disabled = existing == null; // only deletable when the day has data
  };

  const draw = () => {
    const first = new Date(vy, vm, 1);
    const pad = (first.getDay() + 6) % 7;
    const days = new Date(vy, vm + 1, 0).getDate();
    const canNext = toISO(new Date(vy, vm + 1, 1)) <= max;
    const items = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<span class="cal-dowlabel">${d}</span>`);
    for (let i = 0; i < pad; i++) items.push('<span class="cal-cell empty"></span>');
    for (let d = 1; d <= days; d++) {
      const iso = toISO(new Date(vy, vm, d));
      const off = iso > max;
      const cls = ['cal-cell'];
      if (off) cls.push('disabled');
      if (iso === todayStr()) cls.push('today');
      if (iso === selected) cls.push('sel');
      if (weightsByDate[iso] != null) cls.push('has-data');
      items.push(`<button class="${cls.join(' ')}" ${off ? 'disabled' : `data-iso="${iso}"`}>${d}</button>`);
    }
    $('#wcal', body).innerHTML = `
      <div class="cal-head">
        <button class="icon-btn" id="wc-prev" aria-label="Previous month">‹</button>
        <span class="cal-month">${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button class="icon-btn" id="wc-next" aria-label="Next month" ${canNext ? '' : 'disabled'}>›</button>
      </div>
      <div class="cal-grid">${items.join('')}</div>`;
    $('#wc-prev', body).onclick = () => { if (--vm < 0) { vm = 11; vy--; } draw(); };
    if (canNext) $('#wc-next', body).onclick = () => { if (++vm > 11) { vm = 0; vy++; } draw(); };
    $$('.cal-cell[data-iso]', body).forEach(c => c.onclick = () => { selected = c.dataset.iso; draw(); sync(); });
  };

  draw(); sync();
  $('#w-confirm', body).onclick = async () => {
    const val = parseFloat($('#w-input', body).value);
    if (!val || val <= 0) return showToast('Enter a weight');
    await DB.put('weights', { date: selected, weight: round1(val) });
    closeModal(); showToast('Weight logged'); renderTrends();
  };
  $('#w-delete', body).onclick = async () => {
    if (weightsByDate[selected] == null) return;
    if (!confirm(`Delete the weight logged for ${whenLabel()}?`)) return;
    await DB.delete('weights', selected);
    closeModal(); showToast('Removed'); renderTrends();
  };
}

// ================================================================ TRENDS
// Weight chart time windows. `days: null` = everything.
// mode 'daily' = one point per day (gaps interpolated); 'sample' = N even points.
// dots: 'real' = mark only real weigh-ins; false = none.
const WEIGHT_RANGES = [
  { key: '1M', days: 30, mode: 'daily', dots: 'real' },
  { key: '3M', days: 90, mode: 'daily', dots: false },
  { key: '1Y', days: 365, mode: 'sample', dots: false },
  { key: 'All', days: null, mode: 'sample', dots: false },
];
let weightRange = '1M';

// Value on the weigh-in line at time `td`: interpolate between the surrounding
// weigh-ins; hold flat after the last; null before the first (sorted asc by t).
function interpAt(points, td) {
  if (td <= points[0].t) return td === points[0].t ? points[0].value : null;
  const last = points[points.length - 1];
  if (td >= last.t) return last.value;
  let i = 0;
  while (i < points.length - 1 && points[i + 1].t <= td) i++;
  const a = points[i], b = points[i + 1];
  return a.value + (b.value - a.value) * ((td - a.t) / (b.t - a.t));
}

// One point per day across the last `windowDays` (clamped to start at the first
// weigh-in). Real weigh-in days are flagged so only they get dots.
function fillDaily(points, windowDays) {
  if (!points.length) return [];
  const today = todayStr();
  const firstDate = toISO(new Date(points[0].t));
  const windowStart = addDays(today, -(windowDays - 1));
  const realDates = new Set(points.map(p => toISO(new Date(p.t))));
  const out = [];
  for (let d = windowStart > firstDate ? windowStart : firstDate; d <= today; d = addDays(d, 1)) {
    const value = interpAt(points, parseISO(d).getTime());
    if (value == null) continue;
    out.push({
      t: parseISO(d).getTime(), value,
      label: parseISO(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      real: realDates.has(d),
    });
  }
  return out;
}

// Sample `n` evenly-spaced points across the view's window (clamped to start at
// the first weigh-in, ending today), interpolating from ALL weigh-ins — so a
// point just outside the window still anchors the start of the line.
function sampleWindow(points, windowDays, n) {
  if (points.length < 2) return points;
  const today = todayStr();
  const firstT = points[0].t;
  const windowStartT = windowDays == null ? firstT : parseISO(addDays(today, -(windowDays - 1))).getTime();
  const startT = Math.max(firstT, windowStartT);
  const endT = Math.max(parseISO(today).getTime(), points[points.length - 1].t);
  if (endT <= startT) return points.filter(p => p.t >= startT);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = startT + (endT - startT) * (i / (n - 1));
    const value = interpAt(points, t);
    if (value != null) out.push({ t, value, label: new Date(t).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) });
  }
  return out;
}

async function renderTrends() {
  const view = $('#view');
  const weights = (await DB.getAll('weights')).sort((a, b) => a.date.localeCompare(b.date));
  const weightsByDate = Object.fromEntries(weights.map(w => [w.date, w.weight]));

  // last 14 days of calories
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(addDays(todayStr(), -i));
  const kcalByDay = {};
  for (const day of days) {
    const entries = await DB.getLogByDate(day);
    kcalByDay[day] = entries.reduce((s, e) => s + e.kcal, 0);
  }
  // Trim to the span that actually has data so a few days fill/centre the chart
  // instead of bunching on the right behind empty days.
  const dataIdx = days.map((d, i) => (kcalByDay[d] > 0 ? i : -1)).filter(i => i >= 0);
  const shownDays = dataIdx.length ? days.slice(dataIdx[0], dataIdx[dataIdx.length - 1] + 1) : [];
  const calPoints = shownDays.map(d => ({
    label: parseISO(d).toLocaleDateString(undefined, { day: 'numeric' }),
    fullLabel: parseISO(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    value: kcalByDay[d],
  }));
  const wPoints = weights.map(w => ({ label: parseISO(w.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), value: w.weight, t: parseISO(w.date).getTime() }));

  const logged = days.filter(d => kcalByDay[d] > 0);
  const avg = logged.length ? round(logged.reduce((s, d) => s + kcalByDay[d], 0) / logged.length) : 0;

  view.innerHTML = `
    <div class="card">
      <h3>Calories — last 14 days</h3>
      <canvas id="cal-chart"></canvas>
      <div class="tiny muted" id="cal-readout" style="text-align:center;margin-top:8px;min-height:1em">Tap a bar to see its calories</div>
      <div class="tiny muted" style="text-align:center;margin-top:2px">Avg on logged days: <b>${avg}</b> kcal · goal ${state.goals.kcal}</div>
    </div>

    <div class="card">
      <h3>Weight over time</h3>
      <div class="chips" id="weight-ranges">${WEIGHT_RANGES.map(r =>
        `<button class="chip${r.key === weightRange ? ' active' : ''}" data-range="${r.key}">${r.key}</button>`).join('')}</div>
      <canvas id="weight-chart"></canvas>
      <button class="btn btn-primary btn-block" id="w-add" style="margin-top:14px">Log weight</button>
    </div>

    ${weights.length ? `<div class="section-title">Weight history</div><div class="card"><ul class="list">${
      weights.slice().reverse().map(w => `<li class="list-item">
        <div class="li-main"><div class="li-title">${w.weight} kg</div><div class="li-sub">${parseISO(w.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</div></div>
        <button class="icon-btn w-edit" data-date="${w.date}" aria-label="Edit">✎</button></li>`).join('')}</ul></div>` : ''}`;

  barChart($('#cal-chart'), calPoints, {
    goal: state.goals.kcal,
    onSelect: (p) => {
      $('#cal-readout').textContent = p
        ? `${p.fullLabel}: ${Math.round(p.value).toLocaleString()} kcal`
        : 'Tap a bar to see its calories';
    },
  });

  const drawWeight = () => {
    const r = WEIGHT_RANGES.find(x => x.key === weightRange) || WEIGHT_RANGES[0];
    let pts, dots = r.dots;
    if (r.mode === 'daily') {
      pts = fillDaily(wPoints, r.days); // uses all weigh-ins as anchors, even before the window
    } else if (wPoints.length >= 2) {
      // As many even points as the screen can show (~1 per 4px), for a smooth line.
      const cw = $('#weight-chart').getBoundingClientRect().width || 320;
      pts = sampleWindow(wPoints, r.days, Math.min(200, Math.max(30, Math.round((cw - 52) / 4))));
    } else {
      pts = wPoints; dots = true; // too few to sample — just show the points
    }
    lineChart($('#weight-chart'), pts, { dots });
  };
  drawWeight();
  $$('#weight-ranges .chip', view).forEach(b => b.onclick = () => {
    weightRange = b.dataset.range;
    $$('#weight-ranges .chip', view).forEach(c => c.classList.toggle('active', c.dataset.range === weightRange));
    drawWeight();
  });

  $('#w-add').onclick = () => openWeightLogger(weightsByDate);
  $$('.w-edit', view).forEach(b => b.onclick = () => openWeightLogger(weightsByDate, b.dataset.date));
}

// ================================================================ SETTINGS
// Aggregate the whole log into the figures shown in Settings → Stats.
// Returns null when nothing has been logged yet.
function computeLogStats(log) {
  if (!log.length) return null;
  const byDate = {};
  const foodCounts = {};
  let biggestItem = null;
  for (const e of log) {
    const k = e.kcal || 0;
    byDate[e.date] = (byDate[e.date] || 0) + k;
    const name = (e.name || 'Unknown').trim();
    foodCounts[name] = (foodCounts[name] || 0) + 1;
    if (!biggestItem || k > biggestItem.kcal) biggestItem = { name, kcal: k };
  }
  const dates = Object.keys(byDate).sort();
  const totalKcal = dates.reduce((a, d) => a + byDate[d], 0);
  const daysWithData = dates.length;
  const spanDays = Math.round((parseISO(dates[dates.length - 1]) - parseISO(dates[0])) / 86400000) + 1;
  let biggestDay = null;
  for (const d of dates) if (!biggestDay || byDate[d] > biggestDay.kcal) biggestDay = { date: d, kcal: byDate[d] };
  const topFoods = Object.entries(foodCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  return {
    totalKcal,
    avgPerLoggedDay: totalKcal / daysWithData,
    daysWithData, spanDays, biggestDay, biggestItem, topFoods,
  };
}

async function renderSettings() {
  const g = state.goals;
  const view = $('#view');
  const stats = computeLogStats(await DB.getAll('log'));
  const kcal = (n) => round(n).toLocaleString();
  const statsRows = stats ? `
      <div class="stat-row"><span>Calories logged all-time</span><strong>${kcal(stats.totalKcal)}</strong></div>
      <div class="stat-row"><span>Average per logged day</span><strong>${kcal(stats.avgPerLoggedDay)}</strong></div>
      <div class="stat-row"><span>Most-logged foods</span></div>
      ${stats.topFoods.map((f, i) => `<div class="stat-row"><span class="tiny muted">#${i + 1}</span><strong>${esc(f.name)} ×${f.count}</strong></div>`).join('')}
      <div class="stat-row"><span>Biggest day</span><strong>${kcal(stats.biggestDay.kcal)} · ${prettyDate(stats.biggestDay.date)}</strong></div>
      <div class="stat-row"><span>Biggest single item</span><strong>${esc(stats.biggestItem.name)} · ${kcal(stats.biggestItem.kcal)}</strong></div>
      <div class="stat-row"><span>Days logged</span><strong>${stats.daysWithData} of ${stats.spanDays}</strong></div>`
    : `<div class="tiny muted">No food logged yet — your stats will appear here.</div>`;
  view.innerHTML = `
    <div class="card">
      <h3>Daily goals</h3>
      <div class="field"><label>Calories (kcal)</label><input id="g-kcal" type="number" inputmode="decimal" value="${g.kcal}" /></div>
      <div class="field-row">
        <div class="field"><label>Protein (g)</label><input id="g-protein" type="number" inputmode="decimal" value="${g.protein}" /></div>
        <div class="field"><label>Carbs (g)</label><input id="g-carbs" type="number" inputmode="decimal" value="${g.carbs}" /></div>
        <div class="field"><label>Fat (g)</label><input id="g-fat" type="number" inputmode="decimal" value="${g.fat}" /></div>
        <div class="field"><label>Fibre — aim (g)</label><input id="g-fibre" type="number" inputmode="decimal" value="${g.fibre}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Sugars — limit (g)</label><input id="g-sugars" type="number" inputmode="decimal" value="${g.sugars}" /></div>
        <div class="field"><label>Sat fat — limit (g)</label><input id="g-satfat" type="number" inputmode="decimal" value="${g.satFat}" /></div>
        <div class="field"><label>Salt — limit (g)</label><input id="g-salt" type="number" inputmode="decimal" value="${g.salt}" /></div>
      </div>
      <button class="btn btn-primary btn-block" id="g-save">Save goals</button>
    </div>

    <div class="card">
      <h3>Backup</h3>
      <p class="tiny muted" style="margin-top:0">Your data lives only on this device. Export regularly to keep a backup or move to another device.</p>
      <button class="btn btn-block" id="export-btn">⬇ Export data (JSON)</button>
      <button class="btn btn-block" id="import-btn" style="margin-top:8px">⬆ Import data</button>
      <input id="import-file" type="file" accept="application/json" class="hidden" />
    </div>

    <div class="card">
      <h3>Stats</h3>
      ${statsRows}
      <div class="stat-row"><span>Foods saved</span><strong>${state.foods.length}</strong></div>
      <div class="stat-row"><span>Meals saved</span><strong>${state.meals.length}</strong></div>
    </div>

    <p class="tiny muted" style="text-align:center">Calorie Tracker · ${APP_VERSION}<br>
      Product data from <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener" style="color:var(--muted)">Open Food Facts</a> (ODbL)</p>`;

  $('#g-save').onclick = async () => {
    state.goals = {
      kcal: parseFloat($('#g-kcal').value) || 0,
      protein: parseFloat($('#g-protein').value) || 0,
      carbs: parseFloat($('#g-carbs').value) || 0,
      fat: parseFloat($('#g-fat').value) || 0,
      sugars: parseFloat($('#g-sugars').value) || 0,
      satFat: parseFloat($('#g-satfat').value) || 0,
      fibre: parseFloat($('#g-fibre').value) || 0,
      salt: parseFloat($('#g-salt').value) || 0,
    };
    await DB.setSetting('goals', state.goals);
    showToast('Goals saved');
  };

  $('#export-btn').onclick = exportData;
  $('#import-btn').onclick = () => $('#import-file').click();
  $('#import-file').onchange = importData;
}

async function exportData() {
  const data = {
    app: 'calorie-tracker', version: 1, exportedAt: new Date().toISOString(),
    foods: await DB.getAll('foods'),
    meals: await DB.getAll('meals'),
    log: await DB.getAll('log'),
    weights: await DB.getAll('weights'),
    settings: await DB.getAll('settings'),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `calorie-tracker-backup-${todayStr()}.json`;
  a.click(); URL.revokeObjectURL(url);
  showToast('Exported');
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('Importing will REPLACE all current data with the backup. Continue?')) { e.target.value = ''; return; }
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'calorie-tracker') throw new Error('Not a calorie tracker backup');
    for (const store of ['foods', 'meals', 'log', 'weights', 'settings']) {
      await DB.clear(store);
      for (const row of (data[store] || [])) await DB.put(store, row);
    }
    const savedGoals = await DB.getSetting('goals', null);
    state.goals = { ...DEFAULT_GOALS, ...(savedGoals || {}) };
    await refreshCaches();
    showToast('Imported'); switchTab('today');
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
  e.target.value = '';
}

// ---------------------------------------------------------------- service worker
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {/* offline support optional */});
  // When a new version takes control, reload once so the latest code runs.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

init();
