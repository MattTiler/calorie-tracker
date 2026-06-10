# Calorie Tracker

A personal, offline-first calorie & macro tracker. No accounts, no internet required — your data is stored privately in your browser on your device.

Built as a plain HTML/CSS/JavaScript Progressive Web App (PWA): **no build step, nothing to install** beyond a way to serve the files (you already have Python).

## Features

- **Today** — pick a day, see calories vs. your goal plus protein/carbs/fat, and a list of everything logged. Tap a logged food to edit the amount, or ✕ to remove.
- **Foods** — search real branded products by name (auto-searches [Open Food Facts](https://world.openfoodfacts.org) as you type) or **scan a barcode**. Picking a product saves it to your local database, so it's instant and works offline next time. You can also **add foods manually**. The app starts empty and grows with only the foods you actually use.
- **Meals** — build a meal from multiple ingredients (each with its weight) and say how many servings it makes. The app shows calories/macros **per serving**. Then log "1 serving" to your day.
- **Trends** — log your weight over time and see a calories chart for the last 14 days.
- **Settings** — set daily calorie/macro goals, and **export/import** a JSON backup.

### How food data works

- **Online search & barcode lookup** use Open Food Facts (free, no account). They need internet, and barcode *camera* scanning needs an HTTPS page (works on `localhost` and on HTTPS hosting; use the manual barcode box otherwise).
- **Found foods are cached locally**, so your personal list works offline afterwards.
- **Manual add** covers anything missing or any time you're offline.
- Product data is © Open Food Facts contributors, licensed under the ODbL.

## Run it on your computer

1. Double-click **`serve.bat`** (Windows). It opens http://localhost:8000 in your browser.
   - Or from a terminal in this folder: `py -m http.server 8000`
2. Leave that window open while you use the app. Press `Ctrl+C` to stop.

> It must be served over `http://` (not opened as a `file://` path) because it uses JavaScript modules.

## Get it on your phone

Because data lives on the device, the simplest options are:

- **Same Wi-Fi network:** run `serve.bat`, find your PC's local IP (`ipconfig` → IPv4, e.g. `192.168.1.20`), then on your phone's browser visit `http://192.168.1.20:8000`. Use your phone browser's **"Add to Home Screen"** to install it like an app.
- **Free hosting (recommended for everyday phone use):** host these files on a static host such as GitHub Pages or Netlify, then "Add to Home Screen" from the hosted URL. (Phone and PC keep separate data — use Export/Import to copy across.)

## Backups

Your data is only on the device you use. From **Settings → Export data**, save the JSON file somewhere safe regularly. **Import** restores it (and is how you move data to another device/browser).

## Project layout

```
index.html              app shell
manifest.webmanifest    PWA metadata
sw.js                   service worker (offline cache)
css/styles.css          styling
js/db.js                IndexedDB storage wrapper
js/off.js               Open Food Facts client (search + barcode)
js/charts.js            small canvas charts
js/app.js               application logic & views
icons/                  app icons
```

## Notes

- Open Food Facts is crowd-sourced, so a product's values can occasionally be missing or off — you can edit any saved food in-app to correct it.
- Editing a food later does **not** change meals or past log entries that already used it (they store a snapshot), so your history stays accurate.
