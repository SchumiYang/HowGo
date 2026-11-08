# Admin layer — API & file contract (v1)

The admin web (`indoor-nav/admin.html`, its own service on port 5174): 平面圖 / POI / 場勘建圖 / 驗證.
The API is HowGo's FastAPI router `backend/rollx/indoor.py`, prefix **`/v1/indoor`**. Browsers reach it as
`/api/v1/indoor/...` through a proxy that strips `/api` (Nuxt for the nav UI, Vite `server`/`preview` for the admin).
**No auth — dev only**; production needs auth before any write endpoint is exposed.

## Source of truth
- `mapdata/data/<venue>/**` is the source of truth (root: env `HOWGO_INDOOR_MAPDATA`, default `<repo>/indoor/mapdata`).
  The nav UI and the admin both read it through `GET /v1/indoor/data/...`; nothing is copied to static folders any more.
- `tools/author_1f.py` / `author_2f.py` are **bootstrap only**: once a file carries `"source": "admin"` (top-level
  member, set by the server on every admin write), the scripts refuse to overwrite it unless `--force`.
- Every write first copies the previous version to `mapdata/history/<venue>/<yyyymmdd-hhmmss>/<path>` (simple undo).
  Builds back up `positioning/*.json` the same way before running.

## Endpoints (prefix `/v1/indoor`; JSON unless noted; errors → `{ ok:false, error }` with 4xx/5xx)
| Method | Path | Body / result |
|---|---|---|
| GET | `/venues` | `[{ id, name, name_en, levels:[{id,name,ordinal}], default_level, center:[lon,lat], entrance?:{node, level, coordinates:[lon,lat]} }]` — `center` = middle of the units footprint (all levels) through `origin` + `bearing_deg`; `entrance` = venue.json `entrance`/`default_start` node, else the `*ent-main*` nav node |
| GET | `/data/<venue>/<path>` | raw file from `mapdata/data/<venue>/<path>`; readable: the editable paths below plus `levels/<L>/*.geojson` (e.g. `seating3d`) and `levels/<L>/floorplan.{png,jpg,jpeg,webp,svg}` (binary, proper Content-Type). 403 outside the allowlist, 404 if missing |
| PUT | `/data/<venue>/<path>` | editable paths only: `venue.json`, `nav.geojson`, `levels/<L>/{units,pois,walls,walls3d}.geojson`, `levels/<L>/floorplan.json`, `positioning/*.json`, `survey/*.geojson`. Full replacement JSON → validated (object; FeatureCollection with unique `properties.id` for .geojson; venue / floorplan checks) → history backup → write with `source:"admin"` → `{ ok, bytes, history }` |
| POST | `/floorplan/<venue>/<level>` | raw image body (`Content-Type: image/png|jpeg|webp|svg+xml`, ≤ 30 MB) → `levels/<L>/floorplan.<ext>` (history backup) → `{ ok, url: "/api/v1/indoor/data/…", path, bytes }` |
| POST | `/build/<venue>` | `{ targets?: ["radiomap","magmap"], options?: { level?: "all" (default) \| "<L>", walksOnly?: bool, exclude?: string[] } }` → runs `<python> -I tools/build_radiomap.py` then `build_magmap.py` from `mapdata/` with `--level all` (or `<L>`); `<python>` = the API's interpreter (`HOWGO_INDOOR_PYTHON` overrides; needs numpy + pillow). One build at a time (409 if busy) → `{ ok, jobId }`. Builders whose `--help` doesn't mention `all` get the old per-level fallback (radiomap 1F only; a lone non-1F radiomap is refused) |
| GET | `/build/<venue>/status` | `{ running, jobId, startedAt, finishedAt, exitCode, log: string (tail 200 lines), report: { caps, walk_levels, warnings, verdicts, outputs, verdict } }` |
| GET | `/build/preview/<radiomap\|magmap>_<L>.png` | builder preview image from `mapdata/build/` |
| GET | `/survey/health` | `{ ok: true }` |
| POST | `/survey` | session JSON (SURVEY_SCHEMA.md §2, ≤ 150 MB) → `mapdata/survey/raw/<session_id>.json`. The phone re-sends the whole, growing session: the upload replaces the stored one, except that walks only on the server (same `walk_id`+`direction`+`t_start` missing from the upload) are kept → `{ ok, bytes, walks, points, kept_walks }` |
| GET | `/survey/sessions` | `[{ session_id, device:{model,platform}, purpose, synthetic, walks, points, bytes, mtime, walk_list:[{index, walk_id, direction, level, path, t_start, t_end, marks, n_mag, n_wifi}] }]` (no sensor arrays) |
| GET | `/survey/session/<id>?walk=<i>` | `{ session_id, device, walk }` — one full walk for replay (sensor values rounded to 1e-4) |
| POST | `/eval` | validation run JSON (below) → `mapdata/survey/eval/<run_id>.json` → `{ ok }` |
| GET | `/eval` | runs with summary stats `[{ run_id, venue, device, engine, kind, summary, checkpoints, raw_bytes, mtime }]` |

## New files
### `levels/<L>/floorplan.json` — calibrated raster floor plan overlay
```json
{ "image": "floorplan.png", "width_px": 5324, "height_px": 3884,
  "corners": [[x_tl, y_tl], [x_tr, y_tr], [x_br, y_br], [x_bl, y_bl]],   // local metres of the image corners (MapLibre image source order: TL, TR, BR, BL)
  "opacity": 0.6, "calibration": { "method": "2-point" | "3-point", "control": [{ "px": [u, v], "m": [x, y] }], "rms_m": 0.12 } }
```
Calibration in the admin: user clicks control points on the image and their positions on the map (or enters a known
distance between two image points for scale + drags/rotates to align). 2 points = similarity (scale+rotation+translation),
3+ = affine least squares; show RMS.

### Validation run — `mapdata/survey/eval/<run_id>.json`
```jsonc
{ "schema": "tpnav-eval/0", "run_id": "20261107-1700-pixel9a", "venue": "tianmu", "device": {…},
  "engine": { "maps": { "radiomap": "real|none", "magmap": "real|none" }, "options": {…} },
  "checkpoints": [ { "t": 1794031000000, "level": "1F", "truth": [x, y], "estimate": [x, y] | null,
                     "accuracy_m": 2.1, "source": "fused", "confidence": 0.7, "error_m": 1.8,
                     "estimate_level": "1F" | null } ],   // floor the engine was on (a wrong floor shows here)
  "level_changes": [ { "t": t, "from": "1F", "to": "2F", "source": "barometer|wifi|both", "confidence": 0.8,
                       "connector": "2F-A" | null } ],   // the engine's onLevelChange events
  "track": [ [t, x, y, accuracy_m, source] ],          // optional, engine updates during the run
  "summary": { "n": 12, "median_m": 1.9, "p90_m": 4.2, "max_m": 6.0 },
  // optional, for exact offline re-runs (≈45 B/sample, ~7 MB per 10 min; UI checkbox 「一併儲存原始感測資料」, default on)
  "raw": { "sensors": { "accelerometer": [[t,x,y,z]], "gyroscope": [...], "magnetometer": [...],
                        "barometer": [[t, hPa]] },   // optional; same epoch-ms clock as the IMU tuples
           "unavailable": ["barometer"],             // sensors the bridge reported missing (e.g. A71 has no barometer)
           "wifi_scans": [ { "collected_at": t, "results": [...] } ], "stats": { "samples": 0, "scans": 0, "bytes": 0 },
           "mag_accuracy": [[t, 1]] },   // iOS only: CMMagneticFieldCalibrationAccuracy (1 medium, 2 high) when it changes
  "seed": { "t": t, "level": "1F", "x": 0, "y": 0, "heading_deg": 90 | null, "accuracy_m": 1, "snapped_id": "1F-n12" | null },
  "seeds": [ /* every 設為已知位置 during the run */ ],
  "started_at": t, "start": { "sensor_interval_ms": 20, "batch_ms": 200, "wifi_interval_ms": 30000, "engine_uses_wifi": true } }
// engine.map_versions = { radiomap_built_at, magmap_built_at } records which maps the live run used.
// The WiFi stream is recorded even when the run has 使用 WiFi off, so a WiFi-on re-run is possible.
```

## POI editing semantics
- POIs: add / move / delete / edit `category`, `name`, `name_en`, `level`, `accessible`, `unit_id`.
- **Routing link**: saving a POI (new or moved) must keep it routable: create/move its nav node at the POI position
  (`<level>-poi-…` id) and connect it with an accessible `door` edge to the nearest point on the nearest same-level
  edge, splitting that edge (new node + two edges, lengths recomputed). Deleting a POI removes its private node/edges.
  Show the link on the map before saving. Accessibility flag of the link edge is editable (e.g. a step at the door).
- Units: edit properties (`category`, `name`, `ref`, `accessible`); geometry editing is phase 2.
- Nav edges: toggle `accessible` / `type` by clicking an edge (e.g. a door that turns out to have a step).
