# HowGo（好行）

HowGo 是以通用與包容設計為目標的臺北步行導航。室外可比較一般步行、平衡和無障礙路線。室內涵蓋臺北市立大學天母體育館 1F、2F，可導航到電梯、廁所及其他館內地點。

## 功能與架構

| 區塊 | 實作 |
| --- | --- |
| 好行 `frontend/` | Nuxt、Vue、MapLibre GL JS。一般模式提供地圖探索、起終點搜尋、三種路線比較和即時導航。無障礙模式以目前位置規劃輪椅路線，提供大箭頭和地圖兩種導航畫面。 |
| FastAPI `backend/` | 室外地點搜尋、設施查詢、候選路線評估，以及 `/v1/indoor` 場館資料與管理 API。室外資料來自本機 SQLite 和快照，室內資料來自 `indoor/mapdata/`。 |
| 路由服務 `.ors/` | Java openrouteservice（ORS）依 OSM 路網產生室外候選，FastAPI 以本機圖資篩選與排序。 |
| 室內導航 `indoor/indoor-nav/src/` | 從室外一般模式點選場館標記進入，也可使用 `?indoor=tianmu`。Nuxt 延後載入室內介面，室內在裝置上依場館路網獨立算路。室內外目前共用入口，跨室內外的連續路線尚未實作。 |
| 好行管理 `indoor/indoor-nav/` | 獨立的 Vite 管理端，提供平面圖校準、POI 編輯、場勘建圖及定位驗證。建置入口為 `admin.html` 和 `survey.html`。 |
| 部署 `deploy/cloudflare/` | 好行與好行管理各有 Worker 設定，提供靜態前端與同網域 `/api/*` 代理。 |

室外使用 OpenFreeMap 向量底圖。一般模式使用調整過的 Positron，無障礙模式使用 Liberty，標籤放大 1.3 倍。若向量樣式或圖磚索引載入失敗，改用 OSM raster。室外定位優先使用安全來源的瀏覽器定位，也支援台北通 WebView 的位置橋接。大眾運輸路線尚未實作。 [底圖實作](frontend/app/utils/basemap.ts) · [定位來源](frontend/app/utils/geolocation.ts)

## 本機啟動

每個小節的指令都從專案根目錄開始。建議使用 Node.js 24 LTS、pnpm 10、Python 3.11 以上，以及支援 FTS5 與 R*Tree 的 SQLite。下列指令以 macOS／Linux 為例。Python 模組名稱沿用 `rollx`。

### 1. 準備室內前端依賴

Nuxt 會載入室內導航元件，建置前需安裝兩個前端套件目錄的依賴。室內套件使用 npm 鎖檔。

```sh
cd indoor/indoor-nav
npm ci
```

### 2. 啟動 FastAPI

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m rollx.import_facilities
python -m rollx.places
python -m uvicorn rollx.main:app --reload --port 8000
```

兩支匯入指令從本機快照重建 SQLite。已有相容資料庫時可略過。若從舊版沿用 `places.sqlite`，或「天母」「天母體育館」等查詢回傳 `PLACES_UNAVAILABLE`，在 `backend/` 執行 `.venv/bin/python -m rollx.places`。它會建立新版 FTS5 雙字索引，在重建成功後替換原本的資料庫。 [FastAPI 文件](http://127.0.0.1:8000/docs)

### 3. 啟動室外路由服務

本機配置使用 ORS 9.10.0 和 Java 21。`.ors/` 未納入 Git，新環境需要自行準備 ORS JAR 和涵蓋臺北的 OSM PBF。以下為 `.ors/ors-config.yml` 的路網設定。

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

先執行 `curl http://127.0.0.1:8080/ors/v2/health`。若已回傳 `{"status":"ready"}`，可以直接使用正在執行的 ORS。

這台開發電腦的 Java 位於 `.ors/java/`。需要啟動 ORS 時，從 HowGo 專案根目錄執行：

```sh
cd .ors
./java/bin/java -Xmx2g -jar ors.jar --server.address=127.0.0.1 --server.port=8080
```

其他開發環境若已將相容的 Java 加到 PATH，可將 `./java/bin/java` 換成 `java`。首次啟動會建置 `graphs/`。在另一個終端機重查健康狀態，等到回傳 `{"status":"ready"}` 再測試室外算路。也可用 `ORS_BASE_URL` 指向另一個已啟用兩種 profile 的 ORS。室內算路可單獨運作。 [ORS 自架說明](https://giscience.github.io/openrouteservice/run-instance/)

### 4. 啟動兩個前端

好行主程式：

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm dev
```

從另一個終端機開啟管理端：

```sh
cd indoor/indoor-nav
npm run dev
```

- [好行](http://localhost:3000/)
- [天母體育館室內導航](http://localhost:3000/?indoor=tianmu)
- [好行管理](http://localhost:5174/admin.html)

兩個開發前端的 `/api/*` 都代理到 FastAPI。用手機連本機時，可用 `pnpm dev --host 0.0.0.0` 啟動 Nuxt，再用手機開啟開發電腦的區網 IP。一般瀏覽器的定位需要 HTTPS，台北通 WebView 可使用橋接。若要測試台北通 WebView，在台北通專案設定 `HOWGO_URL` 和 `HOWGO_ADMIN_URL`。室內即時定位需台北通的感測器橋接。 [室內啟動與台北通設定](indoor/README.md#台北通整合)

| 環境變數 | 用途 |
| --- | --- |
| `ORS_BASE_URL`、`ORS_API_KEY` | 室外路由位址（預設 `http://127.0.0.1:8080/ors`）及必要時的後端金鑰 |
| `ROLLX_API_TARGET`、`HOWGO_API_TARGET` | 分別設定 Nuxt、Vite 管理端的 FastAPI 代理位址（預設 `http://127.0.0.1:8000`） |
| `ROLLX_DB_PATH` | 室外設施 SQLite 路徑（預設 `backend/data/facilities.sqlite`） |
| `HOWGO_INDOOR_MAPDATA`、`HOWGO_INDOOR_PYTHON` | 室內資料根目錄（預設 `indoor/mapdata`）及管理端建圖使用的 Python（預設 FastAPI 的 Python） |
| `NUXT_PUBLIC_TILE_URL` | 向量底圖初始化失敗時使用的 raster URL，含 `{z}/{x}/{y}`，預設為 OSM 公共圖磚 |

## 室外路線演算法

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

**驗證案例。** 既有本機驗證以芝山捷運站一號出口到天母棒球場測試，最短距離與平衡同為 2.19 公里、約 26 分鐘，無障礙約 2.35 公里、30 分鐘。三種模式的路網終點都距原選點約 72 公尺。

```sh
curl -sS http://127.0.0.1:8000/v1/route-options \
  -H 'Content-Type: application/json' \
  -d '{"start":[121.52285,25.100628],"end":[121.533413,25.114081]}'
```

室外指令按路線順序列出轉向、直行、行人穿越道與階梯。人行道和騎樓的左右側是依行進方向與圖資推估。接點無障礙坡道與沿線坡度量測點分開顯示。圖資缺漏或現場臨時障礙仍需現場確認。

## 室內導航、定位與建圖

- 場館資料位於 `indoor/mapdata/data/tianmu/`。GeoJSON 使用場館內的公尺座標，前端根據 `venue.json` 的原點與方位轉成經緯度。
- 前端用 Dijkstra 依樓層路網算路。無障礙選項只走標為可通行的路段，跨樓層走電梯。導航可依定位進度更新指令，偏離時重新規劃。
- 即時定位在裝置端融合計步、地磁與可用的 Wi‑Fi 指紋，並以氣壓計和 Wi‑Fi 判斷樓層。缺少 Wi‑Fi 掃描能力的裝置可由已知起點使用計步、地磁及場館平面約束。
- 管理端可上傳場勘紀錄、建置 Wi‑Fi 指紋與地磁地圖，也可錄製和回放定位驗證資料。FastAPI 將舊版場館資料備份至 `mapdata/history/`。

[室內操作與建圖](indoor/README.md) · [場館圖資格式](indoor/mapdata/SCHEMA.md) · [場勘與定位資料格式](indoor/mapdata/SURVEY_SCHEMA.md) · [室內管理 API](indoor/mapdata/ADMIN_API.md)

## 資料來源

| 資料集或來源 | 提供者 | HowGo 的用途 |
| --- | --- | --- |
| [輪行臺北設施資料](https://data.taipei/dataset/detail?id=2b58f15a-dec6-4b9d-91be-4eaccfda5ae7) | 臺北市政府交通局 | 斜坡道、無障礙電梯、公園、出入口、友善店家、廁所、停車與大眾運輸站點，以及人行道、標線型人行道、行穿線和坡度紀錄。2026-11-07 的無障礙廁所快照沒有點位。 |
| [臺北市騎樓整平工程完成路段表](https://data.taipei/dataset/detail?id=09504c47-7349-4cab-9ce6-db30f32a392e) | 臺北市都發局建管處 | 民國 91 至 105 年完工紀錄，用於整平騎樓圖層和側別指引。 |
| [臺北市路邊停車格位](https://data.taipei/dataset/detail?id=5a911ea5-1694-4301-808e-e1780d971611) | 臺北市交通局停管處 | 身心障礙專用格位（03、04、18），可選為路線起點或終點。 |
| [OpenStreetMap 臺灣資料](https://download.geofabrik.de/asia/taiwan.html) | OpenStreetMap 貢獻者，Geofabrik 提供臺灣 PBF | 本機地點、道路與地址搜尋，ORS 路網，以及 OSM 穿越道與 `incline` 坡度快照。 |
| [天母體育館場館資料](indoor/mapdata/data/tianmu/) | 專案團隊依場館工程平面圖、現場照片及場勘製作 | 室內樓層、牆面、POI、路網和定位指紋。 |

底圖為線上圖磚服務，搜尋、設施查詢與路網計算使用已下載的快照。地圖保留 OSM 與 OpenMapTiles 署名。OSM 資料採 ODbL 1.0。 [OpenFreeMap 署名](https://github.com/hyperknot/openfreemap#attribution) · [OSM 資料授權](https://www.openstreetmap.org/copyright) · [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) · [OSM 公共圖磚政策](https://operations.osmfoundation.org/policies/tiles/)

室外快照放在 `backend/data/source/`。以下指令在 `backend/` 啟用 venv 後執行。

| 更新項目 | 指令 |
| --- | --- |
| 設施與通行空間 | `python -m rollx.import_facilities`。可加 `--source-dir <資料夾>` 指定另一組快照。 |
| 身障停車格 | `python -m rollx.import_accessible_parking <SHP 路徑>`，再匯入設施。SHP 匯入需 PyShp、pyproj 與 Shapely。 |
| 地點搜尋 | 替換 `places.json.gz` 後執行 `python -m rollx.places`。 |
| OSM 穿越道與坡度 | 使用已安裝 PyOsmium 的環境，執行 `python -m rollx.osm_crossings ../.ors/taipei.osm.pbf` 與 `python -m rollx.slopes ../.ors/taipei.osm.pbf`。 |

## API 與部署

| API | 用途 |
| --- | --- |
| `POST /v1/route-options` | 以同一起終點比較三種室外路線，每種模式各自回傳結果或錯誤。 |
| `POST /v1/routes` | 查單一模式，省略 `mode` 時使用 `accessible`。 |
| `GET /v1/places`、`/v1/meta` | 本機地點搜尋，以及資料類型和快照狀態。 |
| `GET /v1/facilities`、`/v1/walkways`、`/v1/slopes` | 依地圖視窗範圍取得室外圖層。 |
| `GET /v1/indoor/venues`、`/v1/indoor/data/{venue}/{path}` | 場館清單與室內圖資。 |

Cloudflare Worker 的設定在 `deploy/cloudflare/`。好行以 `pnpm exec nuxt generate` 產生靜態前端，好行管理以 `npm run build` 產生管理端。Worker 讀取建置產物，並經 Cloudflare Tunnel 將 `/api/*` 代理至 FastAPI。室內編輯、上傳和建圖端點原本供本機管理端使用，FastAPI 目前沒有使用者驗證。公開部署前須確認代理只讓一般使用者呼叫導航所需 API，並限制管理功能的存取。 [Worker 代理](deploy/cloudflare/worker/index.js) · [室內管理端點](backend/rollx/indoor.py)

## 驗證與效能

- 好行前端在 `frontend/` 執行 `pnpm typecheck` 或 `pnpm build`。室內管理端和定位測試在 `indoor/indoor-nav/` 執行 `npm test` 或 `npm run build`。
- 後端在 `backend/` 的 venv 安裝 `pytest` 後執行 `python -m pytest`。室外算路可使用上方的芝山站測試指令。
- 既有圖層優先改善項目是首次開圖及平移後的載入時間。現行程式會按縮放層級限制圖層請求，平移後仍依視窗查詢。下一步是讓相鄰視窗重用資料，再用手機 Safari 比較請求次數、傳輸量與圖層穩定時間。
