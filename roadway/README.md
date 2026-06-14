# Roadway Web Dashboard

A browser version of the Roadway pothole-detection dashboard for road departments,
plus a crew-assignment ("draw an area") feature. Vanilla JS + Firebase modular SDK,
no build step. Lives at `https://oahuappdesign.com/roadway/`.

## Files
- `index.html` — page shell, loads CDN libs (Leaflet, Leaflet.draw, Turf) + module scripts.
- `styles.css` — dashboard styling (dark, vibrant accents, government-readable).
- `firebase-config.js` — initializes Firebase (project `roadway-bcf99`), exports Firestore `db`.
- `data.js` — reads `trips`, flattens events → bumps, clustering (ported from Swift),
  filters, KPI math, and the **pure** `selectBumpsInPolygon` selection helper.
- `map.js` — Leaflet map, OSM tiles, Leaflet.draw polygon tool, cluster circleMarkers,
  work-order polygon overlays, assigned/fixed pothole styling.
- `workorders.js` — create / list / status-update helpers for `work_orders`.
- `app.js` — wires data + filters + map + KPIs + assign mode + work-orders list.
- `test/index.html` + `test/selection.test.js` — standalone console PASS/FAIL tests
  for the point-in-polygon selection helper (no framework).
- `firestore.rules` — Firestore security rules (see below).

## IMPORTANT — publish the Firestore rules
Writes to the new `work_orders` collection will FAIL until the `work_orders` rule in
`firestore.rules` is published to the Firebase project `roadway-bcf99`. Publish via:

```
firebase deploy --only firestore:rules --project roadway-bcf99
```

or paste the rules into Firebase Console → Firestore → Rules.

The `work_orders` list is ordered by `createdAt desc`; Firestore creates the needed
single-field index automatically (no composite index required).

## Security note
This is a **fully-open MVP with no authentication**. Anyone with the URL can read trips
and create/update work orders. Deletes are forbidden by the rules. Add Firebase Auth +
tightened rules before any public/production rollout.

## Running locally
Because it uses ESM module imports, serve over HTTP (not `file://`):

```
cd /Volumes/Xcode_Projects/DPconsult/Website/roadway
python3 -m http.server 8000
# then open http://localhost:8000/
# tests: http://localhost:8000/test/
```
