# 輪行 X｜Roll X

臺北市室外輪椅路線與通行空間查詢。選起終點後，顯示一條 ORS 輪椅候選路線，以及逐段距離、轉向與道路名稱。市府面圖資沿行進方向有連續且明確的證據時，才補上實體人行道、標線型人行道或整平騎樓的側別提示。側別是相對於行進方向的圖資推估。換邊時請使用可通行的路口。地圖另提供可切換的通行空間與設施點圖層。

## 下一階段優先事項：地圖圖層載入效能

- 優先讓相鄰視窗重用已載入的圖資。小幅平移時沿用快取，移出快取範圍再查詢，減少重複下載和重繪。
- 目前本機 API 基準為各測五次的中位數。開圖尺度約 zoom 14，兩個圖層合計約 3.5 MiB 未壓縮 JSON，設施點約 298 ms，通行空間約 227 ms。天母街區約 zoom 16，合計約 0.7 MiB，兩者分別約 48 ms 和 56 ms。
- 下一階段用手機 Safari 實測首次開圖到圖層出現、拖曳後到圖層穩定的時間。記錄改動前後的圖層請求次數和傳輸量，並確認快取不會漏掉原本可見的圖資。

## 起終點與本機搜尋

地圖平時可點選圖層查看類型。先選「起點」或「終點」，才會進入點地圖或搜尋模式。可搜尋本機 OpenStreetMap 快照收錄的地名、路名與地址。只搜尋道路名稱時，結果定位到該道路上的參考點。

如果是新 checkout，請在 `backend/` 啟用 venv 後執行 `python -m rollx.places`，從 `data/source/places.json.gz` 重建本機 SQLite 搜尋索引。搜尋時直接讀取索引。地點快照擷取自 Geofabrik 臺灣資料，資料為 OpenStreetMap contributors，依 ODbL 授權。

## iOS Simulator 與前景導航

Safari 建議開啟 `http://localhost:3000`。在 Simulator 選擇「Features → Location → Custom Location」，設定臺北測試座標（緯度 25.041、經度 121.541），再回到網頁按「目前位置」。網站定位許可與 Simulator 提供位置是兩個分開的設定。實機請使用 HTTPS 網址。

選起終點並查詢後可按「開始導航」。底部面板可拖曳展開，查看逐段轉向與行穿線提示。導航使用前景定位，偏離路線後可從目前位置重查。路線偏好會比較 ORS 提供的候選路線，並依固定圖資評估人行道覆蓋、沿線斜坡道及行穿線。只有一條候選路線時，沿用該路線。行人穿越道會依路線經過的順序列成獨立動作。直行段同側實體人行道覆蓋超過八成時，省略公尺區間。接上實體人行道時，系統查找接點附近的坡道紀錄。實際通行條件請依現場判斷。

## 坡度圖層與避坡

坡度圖層使用市府快照中有正坡度數值的點位及面資料，並補充本機 OSM 路網的 `incline` 標記。點資料顯示一個坡度圖示，有起訖座標的 OSM 線段則標示兩端。市府快照的 `-1` 表示未填，本機 ORS 路網未啟用高程資料。未標註路段的坡度仍待確認。

Roll X 將已知坡段排除在輪椅候選路線之外。如果首批候選都經過已知坡段，會請本機 ORS 避開比對到的圖資重算。更換本機路網時，可使用已安裝 PyOsmium 的匯入環境重新產生坡段快照。

```sh
cd backend
python -m rollx.slopes ../.ors/taipei.osm.pbf
```

## 身心障礙停車格

「身障停車格」圖層取自[臺北市路邊停車格位](https://data.taipei/dataset/detail?id=5a911ea5-1694-4301-808e-e1780d971611)的 SHP，保留汽車、機車與機慢車身心障礙專用格（代碼 03、04、18）。從每筆格位的面內取一點，轉成 WGS84 後儲存在 `data/source/facility-accessible-parking.json`，與其他設施一起匯入 SQLite。地圖上的停車格可直接設為輪椅步行路線的起點或終點。

更新時可在安裝 PyShp、pyproj 和 Shapely 的匯入環境解壓官方下載檔，再執行以下指令。

```sh
cd backend
python -m rollx.import_accessible_parking /path/to/parking.shp
python -m rollx.import_facilities
```

## 啟動 FastAPI

需要 Python 3.11 以上與支援 R*Tree 的 SQLite。Python 套件安裝在 `backend/.venv`。首次設定請由專案根目錄執行。

```sh
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

已有 SQLite 快照即可啟動。如果缺少 SQLite，先依下方說明從本機 JSON 重建。

```sh
python -m uvicorn rollx.main:app --reload --port 8000
```

### 固定設施快照

FastAPI 啟動與查詢時直接讀取 `backend/data/facilities.sqlite`。2026 年 11 月 7 日下載的市府快照放在 `backend/data/source/`，涵蓋輪行臺北列出的 14 類圖資。無障礙廁所端點回傳 HTTP 204，快照以空陣列保存，介面顯示「來源無點位」。匯入時會排除明顯異常的座標。

如果是新 checkout，或需要替換快照，先在 `backend/` 啟用 venv，再執行下列指令。匯入只讀本機 JSON，整個流程都不會呼叫市府資料 API。

```sh
python -m rollx.import_facilities
```

也可以用 `--source-dir <資料夾>` 指定另一組已下載的 `facility-{類別}.json`（1、3、4、7、8、9、14、15、16、18、20）及 `walkways.geojson.gz`。新快照驗證完成後才會替換 SQLite。

`walkways.geojson.gz` 是 WGS84 通行空間快照。人行道、標線型人行道及行穿線取自交通局「輪行臺北設施資料」的 11、12、13 類，騎樓取自都發局建管處「臺北市騎樓整平工程完成路段表」的民國 91 至 105 年工程紀錄。騎樓 SHP 以 TWD97 TM2 121 座標轉成 WGS84，並移除無法形成有效面圖資的紀錄。這些圖層可個別切換。市府行穿線以紫色面顯示，`osm-crossings.json.gz` 的 OSM 補充穿越道以紫色虛線顯示。點選圖層可查看名稱及有值的量測欄位。導航會比對兩種行穿道資料。

穿越道線段取自本機 ORS 使用的臺北周邊 OSM 路網，資料為 OpenStreetMap contributors，依 ODbL 授權。更換路網後，如需重建穿越道快照，可在已安裝 PyOsmium 的匯入環境中執行下列指令。服務執行時直接讀取快照。

```sh
cd backend
python -m rollx.osm_crossings ../.ors/taipei.osm.pbf
```

路線查詢需要啟用 `wheelchair` profile 的 ORS，路網須覆蓋選點位置。預設連線位置為 `http://127.0.0.1:8080/ors`，可在啟動 FastAPI 前設定 `ORS_BASE_URL` 指向其他自架實例。若團隊用已授權的 ORS API 測試，可在後端設定 `ORS_BASE_URL=https://api.openrouteservice.org` 與 `ORS_API_KEY`。API 金鑰只放後端。尚未連上 ORS 時，地圖與設施仍可使用，查路線會顯示服務暫時不可用。

### 啟動本機路由服務

目前這台電腦的 `.ors/` 已放入 ORS 9.10.0、可攜式 Java 21 與臺北周邊 OSM 路網。這個目錄是本機執行資料。重新開機後，在專案根目錄另開終端機執行。

```sh
cd .ors
./java/bin/java -Xmx2g -jar ors.jar --server.address=127.0.0.1 --server.port=8080
```

等 ORS 準備完成後，用 `curl http://127.0.0.1:8080/ors/v2/health` 確認回傳 `{"status":"ready"}`。首次啟動會建置路網，後續啟動可沿用 `.ors/graphs/`。

- [ORS 自架與路網文件](https://giscience.github.io/openrouteservice/run-instance/)
- [輪行臺北設施資料](https://data.taipei/dataset/detail?id=2b58f15a-dec6-4b9d-91be-4eaccfda5ae7)

- [臺北市騎樓整平工程完成路段表](https://data.taipei/dataset/detail?id=09504c47-7349-4cab-9ce6-db30f32a392e)

## 啟動 Nuxt

建議 Node.js 24 LTS（24.11 或更新版本）與 pnpm 10。另開終端機，由專案根目錄執行。

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm dev
```

瀏覽 [http://localhost:3000](http://localhost:3000)。Nuxt 將 `/api/*` 轉給 FastAPI，預設目標是 `http://127.0.0.1:8000`。如需更換，於開發啟動或建置前設定 `ROLLX_API_TARGET`。執行 `pnpm typecheck` 檢查型別，`pnpm build` 建置正式版本。

底圖預設使用 OSM 公共圖磚，適合低流量開發，畫面保留 OSM 署名。正式環境可用 `NUXT_PUBLIC_TILE_URL` 換成團隊自管或獲授權的 raster 圖磚網址，格式需含 `{z}/{x}/{y}`。

- [MapLibre GL JS 授權](https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt)
- [OSM 歸屬與圖資授權](https://www.openstreetmap.org/copyright)
- [OSM 公共圖磚政策](https://operations.osmfoundation.org/policies/tiles/)
