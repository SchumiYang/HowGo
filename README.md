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

**3. 建立 Python 環境、匯入快照並啟動 API**

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m rollx.import_facilities
python -m rollx.places
python -m uvicorn rollx.main:app --reload --port 8000
```

匯入指令使用 `backend/data/source/` 的本機資料快照。已建立相容資料庫時可略過重建。地點搜尋若出現 `PLACES_UNAVAILABLE` 或舊版索引不相容，可在 backend 的 venv 重新執行 `python -m rollx.places`，建立新版搜尋資料庫。


**4. 準備並啟動 ORS**

`.ors/` 未納入 Git，需要另行準備 ORS 9.10.0 JAR、Java 21，以及涵蓋服務範圍的 OSM PBF。先建立 `.ors/ors-config.yml`，並將檔案路徑對應到實際資料。

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
java -Xmx2g -jar ors.jar --server.address=127.0.0.1 --server.port=8080
```


也可透過 `ORS_BASE_URL` 指向已啟用兩種 profile 的 ORS。室內路徑規劃不依賴 ORS。完整設定可參考 [ORS 自架文件](https://giscience.github.io/openrouteservice/run-instance/)。

**5. 啟動 HowGo 主介面**

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm dev
```

**6. 啟動場館管理端（需要管理／建圖時）**

```sh
cd indoor/indoor-nav
npm run dev
```

### **需要設定的環境參數（.env example）**

主前端可在 `frontend/.env` 設定下列參數。

```dotenv
ROLLX_API_TARGET=http://127.0.0.1:8000
NUXT_PUBLIC_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
```

後端使用程序環境變數，以下以終端機設定為例，設定後再啟動 Uvicorn。

```sh
export ORS_BASE_URL='http://127.0.0.1:8080/ors'
```

管理端如需改用其他後端位址，在啟動 Vite 的終端機設定。

```sh
export HOWGO_API_TARGET='http://127.0.0.1:8000'
```

| 參數 | 說明 |
| --- | --- |
| `ROLLX_API_TARGET` | Nuxt 開發代理的 FastAPI 位址 |
| `NUXT_PUBLIC_TILE_URL` | 向量底圖初始化失敗時的 raster 備援圖磚 |
| `ORS_BASE_URL` | 後端連線的 ORS 根路徑，預設包含 `/ors` |
| `ORS_API_KEY` | 視 ORS 服務需求設定，僅供後端使用 |
| `ROLLX_DB_PATH` | 設施 SQLite 路徑；地點搜尋資料庫另行建立 |
| `HOWGO_INDOOR_MAPDATA` | 室內場館資料根目錄 |
| `HOWGO_INDOOR_PYTHON` | 管理建圖工作使用的 Python 執行檔 |
| `HOWGO_API_TARGET` | Vite 管理端開發代理的 FastAPI 位址 |

後端參數請以環境變數注入，單獨建立 `.env` 檔不代表會自動讀取。瀏覽器定位需要使用者授權及安全來源，手機區網 HTTP 測試可能無法定位，請使用 HTTPS 或支援定位橋接的台北通 WebView。室內即時感測定位需原生橋接；iOS 的 Wi-Fi 掃描能力受限，需要搭配已知／手動起點及可用感測器。

## **4. 功能說明 / Features**

| 功能編號 | 功能名稱 | 功能說明 | 使用資料／技術 |
| --- | --- | --- | --- |
| F01 | 地圖探索與圖層篩選 | 以地圖為主，依需求顯示設施及通行空間，點選查看資料 | MapLibre、OpenFreeMap、市府快照 |
| F02 | 起終點設定 | 支援目前位置、地圖選點、本機地點與地址搜尋 | 瀏覽器／原生定位橋接、SQLite FTS5 |
| F03 | 三種路線比較 | 比較最短距離、平衡與無障礙路線的時間及距離 | ORS、FastAPI、本機通行資料 |
| F04 | 室外導航 | 顯示直行、轉彎及有資料依據的穿越道、側別和設施指引 | ORS 幾何、指令整併、空間比對 |
| F05 | 路線與設施高亮 | 依選取路段區分路線、人行道面及相關坡道等設施 | GeoJSON、MapLibre 圖層 |
| F06 | 身障停車格查詢 | 顯示身心障礙專用格位，可設為起點或終點 | 臺北市路邊停車格位快照 |
| F07 | 室內地點與跨樓層導航 | 瀏覽館內設施、前往二樓藍區等目的地，無障礙跨層使用電梯 | 團隊場館圖資、Dijkstra |
| F08 | 室內感測定位 | 融合可用的計步、地磁、Wi-Fi 與氣壓資料，更新進度 | 裝置端定位、台北通感測橋接 |
| F09 | 場館管理及定位驗證 | 平面圖與 POI 建置、Wi-Fi／地磁建圖、定位效果驗證 | Vite 管理端、FastAPI、Python 工具 |
| F10 | 友善模式與雙語 | 高對比、大字體及簡化流程；主要使用者介面支援中英文 | Vue 語系機制、語言偏好保存 |

圖上的人行道以紅色、黃色及藍綠色，分別呈現不可行、勉強可行及可行的通行分級，協助使用者快速辨識差異。**目前分級由 HowGo 依來源寬度門檻推估，不等同市府對所有使用者的通行認證**；具體門檻與缺值處理如下。

### **三種路線如何選擇**

ORS 負責依 OSM 路網產生候選；**市府資料的後置篩選與評分由 HowGo 的 FastAPI 負責**。ORS 不會自動理解專案本機資料庫中的所有設施與通行分級。

| 模式 | ORS 候選來源 | HowGo 的限制與選擇方式 |
| --- | --- | --- |
| 最短距離 `fastest` | `foot-walking`，比較 `fastest` 與補充的 `shortest` 候選 | 可經階梯及坡段，以 ORS 預估秒數排序 |
| 平衡 `balanced` | `foot-walking` 的 `recommended` 替代候選，再補 `shortest` | 排除過窄人行道、已知坡度達 8% 或 `steep` 坡段；最多接受一段總長不超過 8 公尺的階梯，缺少階梯資料的候選淘汰；通過後依繞路、人行道、階梯與坡段評分 |
| 無障礙 `accessible` | `wheelchair` 的 `recommended` 替代候選 | ORS 設定避開階梯、最大坡度 4%、最小寬度 0.9 公尺；後端另排除已知階梯、過窄人行道及與路線實際比對到的已知坡段 |

「一段 8 公尺以內的階梯」是目前用來近似少量階梯的專案門檻，並非已確認的一層樓。人行道依來源寬度分為 **可行（≥ 1.5 公尺）、勉強可行（≥ 0.9 且 < 1.5 公尺）、不可行（< 0.9 公尺）**，缺少寬度或未比對到則為待確認。這項分級未包含臨時障礙或現場有效淨寬。

目前的候選評分如下，分數越低越優先，同分時比較 ORS 預估時間。

| 模式 | 評分公式 |
| --- | --- |
| 最短距離 | `ORS 預估秒數` |
| 平衡 | `d / d_min − 0.22 × G − 0.10 × F + 0.015 × S + 0.04 × I` |
| 無障礙（目前網頁預設） | `d − 0.55 × G − 0.20 × F` |

`d` 為候選距離（公尺），`d_min` 為該輪候選最短距離，`G`、`F` 分別為可行、勉強可行的人行道覆蓋比例（0～1），`S` 為階梯總長（公尺），`I` 為比對到的已知坡段筆數。舊 API 仍保留可選的 `preferences` 評分分支，網頁目前直接使用三種模式。

**目前無障礙模式通過限制後，排序仍以距離為主。** 覆蓋比例最多折抵 0.55 分，其影響不到 1 公尺的距離分數，因此尚不能宣稱會積極繞行以取得更多人行道覆蓋。

平衡模式若因階梯限制找不到合格候選，會再嘗試全面避開階梯。平衡與無障礙仍無合格結果時，後端會將被淘汰候選比對到的障礙轉成避讓多邊形，累積條件後最多重算兩輪。有合格候選時直接排序選擇，尚未持續搜尋所有可能的更佳繞路。個別模式失敗不影響其他可用模式。

原始選點先在 50 公尺內尋找路網接點，失敗端點可擴大到 120 公尺重試；偏移超過 50 公尺會另行標示。**時間與距離以路網接點間的結果計算，原選點到接點的接近路程未計入，也不代表兩者之間已有可通行路徑。**

### **使用資料集與來源**

本服務整合市府設施資料、OSM 路網與搜尋資料，以及團隊建置的室內場館資料，涵蓋超過 10 種通行相關圖資。下表列出 7 項資料來源及另行使用的底圖服務；其中室內場館圖資為團隊建置，未將它直接列為政府開放資料集。

| 資料集／來源 | 提供者 | 使用方式 |
| --- | --- | --- |
| [輪行臺北設施資料](https://data.taipei/dataset/detail?id=2b58f15a-dec6-4b9d-91be-4eaccfda5ae7) | 臺北市政府交通局 | 斜坡道、無障礙電梯、公園、出入口、友善店家、廁所、停車與大眾運輸站點，以及人行道、標線型人行道、行穿線和坡度紀錄。2026-11-07 的無障礙廁所快照沒有點位。 |
| [臺北捷運車站出入口無障礙電梯、無障礙坡道 GPS 座標](https://data.taipei/dataset/detail?id=0a3bb422-9eb5-459b-a9d4-138456516183) | 臺北大眾捷運股份有限公司 | 電梯歸入「身障設施」，坡道歸入「出入口／坡道」。匯入時與輪行臺北快照合併。 |
| [臺北市公廁點位資訊](https://data.taipei/dataset/detail?id=ca205b54-a06f-4d84-894c-d6ab5079ce79) | 臺北市政府環保局 | 「無障礙廁座數」大於 0 的點位匯入無障礙廁所圖層，快照存於 `backend/data/source/facility-9.json`。 |
| [臺北市騎樓整平工程完成路段表](https://data.taipei/dataset/detail?id=09504c47-7349-4cab-9ce6-db30f32a392e) | 臺北市都發局建管處 | 民國 91 至 105 年完工紀錄，用於整平騎樓圖層和側別指引。 |
| [臺北市路邊停車格位](https://data.taipei/dataset/detail?id=5a911ea5-1694-4301-808e-e1780d971611) | 臺北市交通局停管處 | 身心障礙專用格位（03、04、18），可選為路線起點或終點。 |
| [OpenStreetMap 臺灣資料](https://download.geofabrik.de/asia/taiwan.html) | OpenStreetMap 貢獻者，Geofabrik 提供臺灣 PBF | 本機地點、道路與地址搜尋，ORS 路網，以及 OSM 穿越道與 `incline` 坡度快照。 |
| [天母體育館場館資料](indoor/mapdata/data/tianmu/) | 專案團隊依場館工程平面圖、現場照片及場勘製作 | 室內樓層、牆面、POI、路網和定位指紋。 |

底圖為線上圖磚服務，搜尋、設施查詢與路網計算使用已下載的快照。地圖保留 OSM 與 OpenMapTiles 署名。OSM 資料採 ODbL 1.0。 [OpenFreeMap 署名](https://github.com/hyperknot/openfreemap#attribution) · [OSM 資料授權](https://www.openstreetmap.org/copyright) · [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) · [OSM 公共圖磚政策](https://operations.osmfoundation.org/policies/tiles/)

室外快照放在 `backend/data/source/`。以下指令在 `backend/` 啟用 venv 後執行。

| 更新項目 | 指令 |
| --- | --- |
| 設施與通行空間 | `python -m rollx.import_facilities`。可加 `--source-dir <資料夾>` 指定另一組快照。 |
| 捷運無障礙電梯與坡道 | 更新 `backend/data/source/mrt-accessibility.csv`，再匯入設施。 |
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
