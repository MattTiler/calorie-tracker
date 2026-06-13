// off.js — Open Food Facts client (free, no API key).
// Searches real branded products and looks up barcodes. Needs internet.
// Returns normalized foods: { name, brand, kcal, protein, carbs, fat, serving?, barcode, source:'off' }

const FIELDS = 'code,product_name,generic_name,brands,nutriments,serving_size,serving_quantity';

const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
// UK subdomain biases results toward UK products (e.g. Tesco). Barcode lookup is global anyway.
const SEARCH_URL = 'https://uk.openfoodfacts.org/cgi/search.pl';
const PRODUCT_URL = 'https://world.openfoodfacts.org/api/v2/product/';

function kcalPer100(n) {
  if (n['energy-kcal_100g'] != null) return Number(n['energy-kcal_100g']);
  if (n['energy-kj_100g'] != null) return Number(n['energy-kj_100g']) / 4.184;
  if (n['energy_100g'] != null) return Number(n['energy_100g']) / 4.184; // OFF stores energy_100g in kJ
  return null;
}

function normalize(p) {
  if (!p) return null;
  const name = (p.product_name || p.generic_name || '').trim();
  const n = p.nutriments || {};
  const kcal = kcalPer100(n);
  if (!name || kcal == null) return null; // skip useless entries
  // Salt: prefer salt_100g; otherwise derive from sodium (salt = sodium × 2.5).
  const salt = n.salt_100g != null ? num(n.salt_100g)
    : (n.sodium_100g != null ? num(n.sodium_100g) * 2.5 : 0);
  const food = {
    name,
    brand: (p.brands || '').split(',')[0].trim(),
    kcal,
    protein: num(n.proteins_100g),
    carbs: num(n.carbohydrates_100g),
    fat: num(n.fat_100g),
    satFat: num(n['saturated-fat_100g']),
    sugars: num(n.sugars_100g),
    fibre: num(n.fiber_100g),
    salt,
    barcode: p.code || null,
    source: 'off',
  };
  const sg = parseFloat(p.serving_quantity);
  if (sg > 0) food.serving = { label: (p.serving_size || 'serving').trim(), grams: sg };
  return food;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

export const OFF = {
  async search(query) {
    const q = query.trim();
    if (!q) return [];
    // sort_by=unique_scans_n ranks by popularity (most-scanned first), so common
    // UK products surface above the long tail of obscure/foreign entries.
    const url = `${SEARCH_URL}?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=25&sort_by=unique_scans_n&fields=${FIELDS}`;
    const data = await getJSON(url);
    return (data.products || []).map(normalize).filter(Boolean);
  },

  async barcode(code) {
    const url = `${PRODUCT_URL}${encodeURIComponent(code)}.json?fields=${FIELDS}`;
    const data = await getJSON(url);
    if (data.status !== 1 || !data.product) return null;
    return normalize(data.product);
  },
};
