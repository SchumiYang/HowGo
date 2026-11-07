# Indoor nav — design direction (v0)

Two inputs: **Town Pass design system** (visual language — must match the host app) and **CityGeni** (Mapxus; product/UX reference for accessible indoor navigation).

The Town Pass Figma community file requires login; tokens below are taken from the Town Pass app source (`TownPass/lib/util/tp_colors.dart`, `tp_text_styles.dart`, `tp_button.dart`, `tp_card.dart`, `tp_bottom_sheet.dart`), which implements that design system. Verify against Figma when someone with access can export it.

## Town Pass tokens

Colors (use as CSS custom properties `--tp-<name>`):

| Token | Hex | Use |
|---|---|---|
| primary50 / 100 / 200 | `#EDF8FA` `#DBF1F5` `#B4E2EA` | tinted surfaces, selected chips, restroom fill |
| **primary500** | `#5AB4C5` | brand: primary buttons, active states, route line, app bar (host) |
| primary600 / 700 | `#468D9B` `#356C77` | pressed, route outline, user dot, links on white (contrast) |
| secondary100 / 200 / 300 | `#FCF2DF` `#F8E3BC` `#F4D69E` | room fills (matches the orange rooms on the venue's directory sign) |
| secondary500 | `#F5BA4B` | secondary button, highlights |
| grayscale50 / 100 / 200 | `#F1F3F4` `#E3E7E9` `#CAD1D5` | page bg, corridors, nonpublic areas, dividers |
| grayscale500 / 700 / 900 | `#738995` `#475259` `#171B1D` | secondary text, walls, primary text |
| red500 / 600 | `#D45251` `#C2332F` | errors, emergency |
| orange500 | `#FD853A` | warnings |
| white | `#FFFFFF` | cards, sheets |

Typography: **PingFang TC** (fallback `-apple-system, "Noto Sans TC", sans-serif`), weights 400 / 600 only.

| Style | Size | Weight |
|---|---|---|
| h1 | 36 | 400 / 600 |
| h2 | 24 | 400 / 600 |
| titleSemiBold | 18 | 600 |
| h3 | 16 | 400 / 600 |
| body | 14 | 400 / 600 |
| caption | 12 | 400 |

For our accessibility audience, don't go below **14** for anything actionable; prefer 16 for primary content.

Components:
- Button: radius **10**, padding 8×16. Primary = primary500 bg / white text (pressed primary600). Outline = white bg, primary500 border + text (pressed primary50). Danger = red500. Secondary = secondary500. Disabled = grayscale100 bg / grayscale500 text. Touch target ≥ 48 px.
- Card: white, radius 3 (default), shadow `0 0 12px rgba(0,0,0,0.04)`.
- Bottom sheet: white, top-rounded, shadow `0 0 6px rgba(0,0,0,0.10)`.
- Host chrome: the microservice runs inside `TPWebView`, which already shows a **primary500 app bar with centered white title** (taken from the page `<title>`) and a close button. **Do not render a second header bar**; set `document.title` (e.g. 「天母體育館 無障礙導航」).

Map palette (Town Pass tokens applied to the venue map):
- background `#F1F3F4` (grayscale50), walkable corridor/lobby `#FFFFFF`, rooms `#F8E3BC` with `#AD7B2B` labels, nonpublic `#E3E7E9`, court `#DBF1F5`
- restrooms `#DBF1F5` fill; **accessible restroom** `#5AB4C5` fill + white ♿ icon (strongest emphasis on the map)
- elevators: primary600 icon; stairs: grayscale500 icon (de-emphasised, shown as not step-free)
- walls `#475259` 1 px, columns filled `#CAD1D5`
- route: `#5AB4C5` 6 px over `#356C77` 8 px casing; off-level route parts 40 % opacity dashed
- user position: `#356C77` dot with white ring + translucent primary300 accuracy circle + heading cone

## CityGeni patterns to borrow

CityGeni (Mapxus) is the main reference. Public facts (citygeni.com, App Store, HKUST SEN page, Mapxus news):
- **Two modes**: *Map mode* (most users incl. wheelchair users) and *Text & Voice mode* (visually impaired; indoor-only, works with screen readers, voice guidance). → We build Map mode first, and design the step list so a Text & Voice mode is the same data rendered as a list + speech later.
- **Barrier-free route** for wheelchair/stroller users. → Our accessible route is ON by default.
- **Positioning icon shows the source** (GPS vs indoor). → Show our position source + confidence: QR anchor / tapped / WiFi / PDR, and "定位中…" state.
- **Indoor positioning = WiFi fingerprinting** on existing networks, no extra hardware; coverage limited to main public corridors. → Same approach as ours; set expectations in onboarding.
- **Phone-holding tip**: top of phone pointing in walking direction, screen flat or tilted ≤ 45°. → Show once when live positioning starts (helps PDR heading).
- **No login, no personal data collected.** → Positioning stays on device.
- Safety disclaimer: not a replacement for a white cane / guide dog.
- Destination flow: search or category → one tap for directions → shortest (barrier-free) route → real-time location + nearby facilities.

## Screen structure (Map mode)

1. **Map** (full screen under host app bar) + floating level switcher (right) + locate button.
2. **Bottom sheet, collapsed**: three big category buttons — 「無障礙廁所」(primary), 「廁所」, 「電梯」 — and a search field; current-position source chip (e.g. 「起點：入口 A」 / 「點地圖設定起點」 / 「掃描定位碼」).
3. **Destination result**: name, floor, distance/time, 「開始導航」primary button, 無障礙路線 toggle (default on).
4. **Navigating**: next-step card on top of the sheet (large icon + 16–18 px text, e.g. 「直走 20 公尺後右轉」「搭電梯到 2F」), step list expandable, arrival state.
