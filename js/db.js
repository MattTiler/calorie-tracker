// db.js — tiny promise-based IndexedDB wrapper for the calorie tracker.
// All data lives locally in the browser on this device.

const DB_NAME = 'calorie-tracker';
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;

      if (!db.objectStoreNames.contains('foods')) {
        const foods = db.createObjectStore('foods', { keyPath: 'id', autoIncrement: true });
        foods.createIndex('name', 'name', { unique: false });
      }
      if (!db.objectStoreNames.contains('meals')) {
        db.createObjectStore('meals', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('log')) {
        const log = db.createObjectStore('log', { keyPath: 'id', autoIncrement: true });
        log.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('weights')) {
        db.createObjectStore('weights', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    Promise.resolve(fn(os)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const DB = {
  // Generic CRUD ----------------------------------------------------------
  add: (store, value) => tx(store, 'readwrite', os => reqAsPromise(os.add(value))),
  put: (store, value) => tx(store, 'readwrite', os => reqAsPromise(os.put(value))),
  get: (store, key) => tx(store, 'readonly', os => reqAsPromise(os.get(key))),
  delete: (store, key) => tx(store, 'readwrite', os => reqAsPromise(os.delete(key))),
  clear: (store) => tx(store, 'readwrite', os => reqAsPromise(os.clear())),
  getAll: (store) => tx(store, 'readonly', os => reqAsPromise(os.getAll())),

  // Query log entries for a single date (YYYY-MM-DD) ----------------------
  getLogByDate: (date) => tx('log', 'readonly', os =>
    reqAsPromise(os.index('date').getAll(IDBKeyRange.only(date)))),

  // Bulk insert (used for seeding) ----------------------------------------
  bulkAdd: (store, values) => tx(store, 'readwrite', os => {
    values.forEach(v => os.add(v));
    return values.length;
  }),

  // Settings helpers ------------------------------------------------------
  getSetting: async (key, fallback = null) => {
    const row = await DB.get('settings', key);
    return row ? row.value : fallback;
  },
  setSetting: (key, value) => DB.put('settings', { key, value }),
};
