# indoor-nav

無障礙室內導航 (accessibility-first indoor navigation) web microservice for the TownPass (台北通) app; UI follows the Town Pass design tokens in ../DESIGN.md. Vite + TypeScript + Vue 3 + MapLibre GL JS v6, mobile-first, offline (no basemap, no glyph server).
This package now builds only the indoor **admin service**; the nav UI sources here are consumed by the HowGo Nuxt app, and all data comes from HowGo's FastAPI `/v1/indoor` (see ../README.md).

## Run

```sh
npm install
npm run dev        # admin service: http://<pc-ip>:5174/admin.html, /api proxied to HowGo FastAPI (HOWGO_API_TARGET)
npm run admin      # build, then serve dist/ with vite preview on 5174 (same proxy)
npm test           # vitest: frame conversion, routing, bridge, positioning, admin helpers
npm run build      # vue-tsc + vite build -> dist/ (admin.html + survey.html; the nav UI is built by HowGo Nuxt)
npm run gen-mock                            # regenerate public/data/mock from scripts/gen-mock.mjs
```

URL parameters:

| param | |
|---|---|
| `venue=<id>` | loads `public/data/<id>/` (default `mock`) |
| `start=<nav node id>` | start position ("你在這裡"); otherwise the venue default from `src/config.ts` (tianmu: `1F-ent-main-out`) |
| `debug=1` | debug panel: bridge availability, deviceinfo / wifi_scan, live sensor rates |

QR codes `tpnav:<venue>:<nav node id>` scanned with 「掃描定位碼」 set the start (switching venue if needed).

## Data

Contract: `../mapdata/SCHEMA.md`. GeoJSON in local metres, converted client-side with `venue.json` `origin` + `bearing_deg`.
Only `venue.json` is required; missing `units` / `pois` / `nav` files degrade gracefully (walls-only maps render, routing UI is disabled without nav).

## Layout

```
src/geo/        frame.ts (localToLngLat / lngLatToLocal), geometry.ts
src/data/       types.ts (SCHEMA.md types), loader.ts, catalog.ts (search, quick-action categories)
src/routing/    graph.ts (nav graph, snapping), dijkstra.ts, route.ts (multi-target, accessible-only), instructions.ts
src/map/        IndoorMap.ts (MapLibre wrapper), style.ts (palette, layers), convert.ts, icons.ts (canvas-drawn POI icons)
src/bridge/     townpass.ts (typed window.flutterObject client)
src/composables useNavigator.ts (venue/start/route/navigation state, position source)
src/config.ts   per-venue defaults (short name for the TPWebView title, default start)
src/tokens.ts   Town Pass color tokens for the map (CSS side: --tp-* in style.css)
src/components/ MapView, LevelSwitcher, StartChip, CategoryButtons, SearchBox, PlaceCard, DestinationCard,
                NavigationPanel, StepIcon, AccessibleToggle, DebugPanel
scripts/        gen-mock.mjs  (the indoor API moved to HowGo backend/rollx/indoor.py)
```
