# HowGo

HowGo 是臺北市的室外步行導航專題，以通用與包容設計為目標。使用者可以比較最短距離、平衡和無障礙三種路線，查看預估時間、距離、沿途通行條件與逐步指引，再選擇其中一條開始導航。

- **前端**使用 Nuxt、Vue 與 MapLibre GL JS，負責地圖、圖層篩選、行程比較與前景定位。
- **後端**使用 Python FastAPI、SQLite 與 Shapely，負責本機地點搜尋、設施查詢和候選路線評估。
- **路由**由 openrouteservice（ORS）依 OSM 路網產生候選，FastAPI 再用本機圖資比對通行條件。
- 目前範圍是臺北室外步行。天母體育館的室內導航放在 [`indoor/`](indoor/README.md)，尚未與室外導航串接；大眾運輸和城市通 WebView 屬後續整合。

## 快速啟動

分別開三個終端機，從專案根目錄執行以下步驟。專題名稱為 HowGo，Python 模組指令仍使用 `rollx`，既有環境變數名稱也可繼續使用。

### 1. 路由服務（ORS）

本機開發設定使用 ORS 9.10.0 與 Java 21。`.ors/` 是本機執行目錄，未納入 Git。新環境需先準備 ORS、覆蓋臺北的 OSM PBF，以及啟用 `foot-walking` 和 `wheelchair` 的設定。本機設定讀取 `taipei.osm.pbf`，首次啟動會建立 `graphs/`，後續可重用。將下列設定放在 `.ors/ors-config.yml`。

```yaml
ors:
  engine:
    profile_default:
      graph_path: ./graphs
      build:
        source_file: ./taipei.osm.pbf
        elevation: false
    profiles:
      driving-car:
        enabled: false
      foot-walking:
        enabled: true
      wheelchair:
        enabled: true
```

```sh
cd .ors
./java/bin/java -Xmx2g -jar ors.jar --server.address=127.0.0.1 --server.port=8080
```

從另一個終端機執行 `curl http://127.0.0.1:8080/ors/v2/health`，收到 `{"status":"ready"}` 後即可查路線。也可使用已啟用兩種 profile 的其他 ORS 實例。 [ORS 自架說明](https://giscience.github.io/openrouteservice/run-instance/)

### 2. FastAPI 與本機資料

使用 Python 3.11 以上及支援 R*Tree 的 SQLite。新環境需先從本機快照重建 SQLite，已有資料庫時可略過兩行匯入指令。

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m rollx.import_facilities
python -m rollx.places
python -m uvicorn rollx.main:app --reload --port 8000
```

### 3. Nuxt

本機建議使用 Node.js 24 LTS 與 pnpm 10。

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm dev
```

開啟 [HowGo 本機網站](http://localhost:3000)。前端型別檢查與正式建置分別使用 `pnpm typecheck` 和 `pnpm build`。

| 環境變數 | 用途 | 預設 |
| --- | --- | --- |
| `ORS_BASE_URL` | FastAPI 連線的 ORS 位址 | `http://127.0.0.1:8080/ors` |
| `ORS_API_KEY` | 使用需要授權的 ORS 時，在後端提供金鑰 | 空 |
| `ROLLX_DB_PATH` | 指定設施 SQLite 路徑 | `backend/data/facilities.sqlite` |
| `ROLLX_API_TARGET` | Nuxt 的 `/api/*` 代理目標，啟動或建置前設定 | `http://127.0.0.1:8000` |
| `NUXT_PUBLIC_TILE_URL` | MapLibre 的 raster 圖磚 URL，包含 `{z}/{x}/{y}` | OSM 公共圖磚 |

## 路線演算法

### 1. 取得候選路線

起終點可由本機搜尋、地圖選點或目前位置取得，送往後端的座標格式為 `[經度, 緯度]`。ORS 起初在每個選點的 50 公尺半徑內尋找路網接點，若某端接不上，該端可擴大到 120 公尺重試。原選點與接點的直線距離超過 50 公尺時，介面會另行標示。距離與時間都以路網接點間的 ORS 結果為準，接點與原選點間的路程未計入。

| 模式 | ORS 候選 | 通行限制 |
| --- | --- | --- |
| 最短距離 `fastest` | 一般步行 `foot-walking`，同時比較 `fastest` 與 `shortest` 權重產生的候選 | 一般步行，可經過階梯與坡段 |
| 平衡 `balanced` | `foot-walking`，以 `recommended` 請求替代路線（`target_count=3`），再補一條 `shortest` 候選 | 排除比對到的過窄人行道、已知坡度達 8% 或標記為 `steep` 的坡段。最多接受一段 8 公尺以內的階梯，階梯資料缺失的候選會被淘汰 |
| 無障礙 `accessible` | `wheelchair`，以 `recommended` 請求替代路線（`target_count=3`） | ORS 設定避開階梯、最大坡度參數 4%、最小寬度 0.9 公尺。後端另排除比對到的階梯、過窄人行道與已知坡段 |

`shortest` 候選以相同的端點與當輪避讓條件查詢，依路線座標去除重複結果。替代路線數量取決於 ORS，替代請求失敗時會改查單條路線。`waytype=8` 用來識別階梯，連續階梯區間會合併。8 公尺是短階梯的專案判定值，用來近似一層樓梯。

### 2. 比對人行道與坡度

| 市府快照中的人行道寬度 | HowGo 通行分級 |
| --- | --- |
| 1.5 公尺以上 | 可行 |
| 0.9 公尺以上、未滿 1.5 公尺 | 勉強可行 |
| 未滿 0.9 公尺 | 不可行 |
| 缺少寬度或比對不到人行道 | 待確認 |

分級以目前人行道快照的寬度數值推估，尚未涵蓋障礙物、施工、路面狀態或現場淨寬。可行與勉強可行的覆蓋長度會合併路線實際經過的人行道與側別指引有證據的路段。同一路段若同時有兩級證據，以可行計算。路線與過窄人行道的單一面重疊至少 3 公尺時，平衡和無障礙會淘汰該候選，側別指引也會排除已知過窄的人行道。

坡度證據來自市府快照的正坡度點位或面，以及本機 OSM 的 `incline` 線段。避讓只採用與路線有幾何證據的坡段，包括 1.5 公尺內的坡度點、方向一致且確實重疊的坡度線，或路線穿入的坡度面。附近出入口的坡度點可以標在地圖上，直行是否經過斜面仍須看實際路線。市府的 `-1` 代表缺值，本機 ORS 未啟用高程建模，4% 是路由設定，未測路段的坡度待確認。

### 3. 評分與重算

分數越低越優先，同分時取 ORS 預估秒數較低者。令 `d` 為候選距離（公尺），`d_min` 為該輪全部候選的最短距離，`G` 和 `F` 分別為可行、勉強可行的覆蓋比例，`S` 為階梯總長度（公尺），`I` 為比對到的已知坡段筆數。

| 模式 | 目前評分 |
| --- | --- |
| 最短距離 | `ORS 預估秒數`。介面名稱為最短距離，實際依候選時間排序 |
| 平衡 | `d / d_min - 0.22 × G - 0.10 × F + 0.015 × S + 0.04 × I` |
| 無障礙 | `d - 0.55 × G - 0.20 × F`。目前網頁以距離為主，人行道覆蓋最多扣 0.55 分，影響不到 1 公尺的距離分數 |

無障礙的舊 API 呼叫仍可傳 `preferences`。指定時，公式中的 `d` 改為 `d / d_min - 0.45 × 所選品質指標的平均`。品質指標分別是實際人行道覆蓋比例、以每公里 12 處為滿分的近路線坡道密度，以及以每公里 5 處為滿分的行穿道密度。密度計算的分母至少為 150 公尺。網頁端直接使用三種模式。

平衡候選都未通過且有階梯限制問題時，會再查一次全面避開階梯的路線。平衡和無障礙若仍沒有合格候選，會取被淘汰路線中預估最快的一條，把比對到的障礙加入避讓多邊形，最多重算兩輪。無法找到合格結果時，個別模式回傳原因，其他可用模式仍可選。不同模式可以選中同一條路線。時間沿用各 ORS profile 的估算。

**驗證案例。** 目前本機快照以芝山捷運站一號出口到天母棒球場測試，最短距離與平衡同為 2.19 公里、約 26 分鐘，無障礙約 2.35 公里、30 分鐘。三種模式的路網終點都距原選點約 72 公尺。

```sh
curl -sS http://127.0.0.1:8000/v1/route-options \
  -H 'Content-Type: application/json' \
  -d '{"start":[121.52285,25.100628],"end":[121.533413,25.114081]}'
```

## 地圖、導航與資料

- **地點搜尋**從 OSM 快照建立本機 SQLite 索引。可以查地名、路名和快照收錄的地址，只查道路名稱會定位到路上的參考點。
- **導航指令**依路線順序列出轉向、直行、行人穿越道與階梯。側別以行進方向為準，由實體人行道、標線型人行道與整平騎樓面圖資推估。人行道覆蓋超過 80%，或覆蓋至少 70% 且未覆蓋部分不超過 15 公尺時，會簡化整段描述。
- **路線高亮**包括路線、實際行經與指引側人行道、沿線引用的無障礙坡道和鄰近坡度點。無障礙坡道設施與坡度量測點分開顯示。
- **前景導航**使用瀏覽器定位。偏離路線後可用目前位置重查，沿用原模式。iOS Simulator 可用 Safari 開啟 `http://localhost:3000`，在 Simulator 選擇 **Features → Location → Custom Location** 設定臺北座標（緯度 25.041、經度 121.541），並允許網站定位。實機使用 HTTPS。

### 使用中的資料集

| 資料集與連結 | 提供者 | HowGo 的用途 |
| --- | --- | --- |
| [輪行臺北設施資料](https://data.taipei/dataset/detail?id=2b58f15a-dec6-4b9d-91be-4eaccfda5ae7) | 臺北市政府交通局 | 無障礙坡道、停車場無障礙電梯、公園、捷運站與公園出入口、友善店家、身障設施、路邊停車場與停車格、公車站、捷運站。也提供人行道、標線型人行道、行穿線及有值的坡度紀錄，用於圖層與路線評估。無障礙廁所類別已接入，但 2026-11-07 的來源回傳 HTTP 204，該快照沒有點位。 |
| [臺北市騎樓整平工程完成路段表](https://data.taipei/dataset/detail?id=09504c47-7349-4cab-9ce6-db30f32a392e) | 臺北市都發局建管處 | 民國 91 至 105 年的完工路段。用於整平騎樓圖層和沿路側別指引。 |
| [臺北市路邊停車格位](https://data.taipei/dataset/detail?id=5a911ea5-1694-4301-808e-e1780d971611) | 臺北市交通局停管處 | 取 SHP 中的身心障礙專用格位（03、04、18），每格保留一個面內代表點，可在地圖上設為起點或終點。 |
| [OpenStreetMap 臺灣資料（Geofabrik 下載頁）](https://download.geofabrik.de/asia/taiwan.html) | OpenStreetMap 貢獻者，Geofabrik 提供臺灣 PBF | 建立本機地點、道路和地址搜尋索引，以及 ORS 的臺北路網。另從路網擷取穿越道及 `incline` 坡度標記，補充導航指引與坡度圖層。 |

底圖預設由 MapLibre GL JS 讀取 **OpenStreetMap 公共 raster 圖磚**。圖磚是線上底圖服務，路由與搜尋使用上表的本機 OSM 快照。OSM 資料依 ODbL 授權，地圖保留來源署名。 [OSM 署名與授權](https://www.openstreetmap.org/copyright) · [OSM 圖磚政策](https://operations.osmfoundation.org/policies/tiles/) · [MapLibre 授權](https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt)

### 本機快照與更新

設施查詢、地點搜尋與路由使用已下載的資料。更新快照後，在 `backend/` 啟用 venv 並重跑相應的匯入指令。

| 本機檔案 | 更新方式 |
| --- | --- |
| `facility-{類別}.json`、`walkways.geojson.gz` | 設施點和 WGS84 通行空間面。以 `python -m rollx.import_facilities` 重建 SQLite，也可加 `--source-dir <資料夾>` 指定另一組本機快照。 |
| `facility-accessible-parking.json` | 執行 `python -m rollx.import_accessible_parking <SHP 路徑>` 後重新匯入設施。SHP 匯入環境需有 PyShp、pyproj 與 Shapely。 |
| `places.json.gz` | 替換地點快照後，執行 `python -m rollx.places` 重建地點索引。 |
| `.ors/taipei.osm.pbf`、`osm-crossings.json.gz`、`osm-slopes.json.gz` | 更換 ORS 路網後，建議以同一份 PBF 更新穿越道及坡度。使用已安裝 PyOsmium 的環境執行 `python -m rollx.osm_crossings ../.ors/taipei.osm.pbf` 與 `python -m rollx.slopes ../.ors/taipei.osm.pbf`。 |

## API

FastAPI 啟動後可開啟 [互動式 API 文件](http://127.0.0.1:8000/docs)。網頁端透過 Nuxt 的 `/api` 前綴代理。

| 路徑 | 用途 |
| --- | --- |
| `POST /v1/route-options` | 送入 `start`、`end`，回傳三種模式各自的 `route` 或 `error` |
| `POST /v1/routes` | 查單一模式，`mode` 省略時使用 `accessible` |
| `GET /v1/places?q=...` | 查詢本機地點索引 |
| `GET /v1/facilities`、`/v1/walkways`、`/v1/slopes` | 按地圖範圍查詢設施、通行空間與坡度 |
| `GET /v1/meta` | 查詢資料覆蓋、類型與快照資訊 |

## 下一階段優先事項

優先改善首次開圖與平移時的圖層載入效能。相鄰視窗應重用已載入的資料，移出快取範圍再查詢。先前本機五次查詢中位數顯示，zoom 14 的兩個主要圖層合計約 3.5 MiB 未壓縮 JSON，設施點約 298 ms、通行空間約 227 ms。天母街區 zoom 16 合計約 0.7 MiB，分別約 48 ms 和 56 ms。下一輪用手機 Safari 實測首次開圖、拖曳後穩定時間、請求次數和傳輸量，並檢查快取邊界是否漏圖。
