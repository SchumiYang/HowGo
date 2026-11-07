# HowGo 室內導航（indoor/）

天母體育館 1F／2F 的無障礙室內導航，以無障礙廁所、廁所和電梯為主要目的地。原本以台北通（TownPass）WebView 微服務開發，前端與 HowGo 室外導航相互獨立，尚未串接。

- **地圖**由工程平面圖（EMF，含公尺比例）和現場導覽牌照片手工建立，呈現 2.5D 牆面與 2F 階梯看台。
- **定位**在手機上融合計步（PDR）、地磁比對與 WiFi 指紋，使用粒子濾波；可用氣壓計或 WiFi 自動偵測換樓層。
- **路線**走 nav graph，提供無障礙模式（排除樓梯），跨樓層經電梯。
- **管理端**（`admin.html`）提供平面圖、POI 編輯、場勘建圖和定位驗證四個分頁。

## 目錄

| 路徑 | 內容 |
| --- | --- |
| `indoor-nav/` | 室內管理端服務（`admin.html`、`survey.html`；Vite、TypeScript、Vue 3、MapLibre GL JS），以及導航介面與定位引擎的原始碼（`src/`，導航介面已併入 HowGo Nuxt） |
| `mapdata/` | 場館資料與 Python 工具。`data/tianmu/` 是正式資料，`survey/` 是場勘紀錄，`tools/` 是建圖腳本，格式見 `SCHEMA.md`、`SURVEY_SCHEMA.md`、`ADMIN_API.md` |
| `ref/` | 原始平面圖（EMF）與現場照片 |
| `DESIGN.md` | 台北通設計 token 與介面參考 |

`indoor-nav` 以相對路徑讀取 `../mapdata` 和 `../DESIGN.md`，搬移時請保持三者同層。

## 快速啟動

室內功能由三個服務組成：HowGo FastAPI（`/v1/indoor` API，讀寫 `mapdata/`）、HowGo Nuxt（導航介面，`?indoor=tianmu`）和室內管理端（`indoor-nav`，port 5174）。兩個前端都經 `/api` proxy 呼叫 FastAPI。

```sh
# 1. API（repo 根目錄的 backend/；需 numpy、pillow，已列在 requirements.txt）
cd backend
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn rollx.main:app --host 0.0.0.0 --port 8000
.venv/Scripts/python -m pytest            # 含 tests/test_indoor.py

# 2. 導航介面：HowGo frontend（Nuxt），見 repo README；開啟 http://<電腦 IP>:3000/?indoor=tianmu

# 3. 管理端（admin.html + survey.html）
cd indoor/indoor-nav
npm ci
npm test
npm run dev              # 開發：http://<電腦 IP>:5174/admin.html，/api → FastAPI
npm run admin            # 或建置後以 vite preview 提供（同樣在 5174）
```

- `HOWGO_INDOOR_MAPDATA` 可指定資料根目錄（預設 `indoor/mapdata`）；`HOWGO_API_TARGET` 指定管理端 proxy 的 FastAPI 位址（預設 `http://127.0.0.1:8000`）。
- 場勘上傳寫入 `mapdata/survey/raw/`，驗證結果寫入 `mapdata/survey/eval/`，每次修改資料前的舊版本保存在 `mapdata/history/`。
- 管理端的 `survey.html` 會轉到 `admin.html#mapping-record`（場勘錄製）。

## 建圖

在 `indoor/mapdata/` 執行。Windows 請用 `py -3.12 -I`。

```sh
py -3.12 -I tools/build_radiomap.py     # WiFi 指紋，預設建所有樓層
py -3.12 -I tools/build_magmap.py       # 地磁地圖，每層一個 magmap_<樓層>.json
py -3.12 -I tools/survey_plan.py --level 2F   # 場勘點與路線；保留既有點位編號
```

管理端「場勘建圖 → 建圖」會在 FastAPI 上執行同樣的腳本；導航介面直接讀 API，建完重新整理即可。品質不佳的場勘紀錄列在 `mapdata/survey/exclude_walks.txt`。以真實資料做交叉驗證：先跑 `py -3.12 -I tools/eval_lowo_maps.py`，再在 `indoor-nav` 執行 `npm run eval:positioning`。

## 台北通整合

感測器橋接（`wifi_scan`、`wifi_scan_stream`、`sensor_stream`）在 TownPass 的 `feature/indoor-nav-bridge` 分支。TownPass 提供兩個微服務入口：「好行」以 `--dart-define=HOWGO_URL=http://<電腦 IP>:3000` 指定（HowGo 主程式，室內導航由地圖上的場館按鈕進入，也可直接開 `?indoor=tianmu`）；「好行管理」以 `--dart-define=HOWGO_ADMIN_URL=http://<電腦 IP>:5174/admin.html` 指定。iOS 無法掃描 WiFi，改用地磁與計步定位。
