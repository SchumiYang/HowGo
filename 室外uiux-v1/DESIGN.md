# DESIGN.md — 城市通無障礙全程導航

> Version: 0.1 — Official Town Pass UI Kit baseline, 2026-11-07  
> Status: Official Figma foundation verified; RideFlow visual references and navigation-specific design decisions pending.  
> Target: Google Stitch prototype → Figma review → Flutter Web implementation.  
> Language: `zh-TW` (Traditional Chinese, Taiwan usage).

## 1. Sources and precedence

1. **Official Town Pass Design System (authoritative baseline):** https://www.figma.com/design/uyauqAyRAzU1qgUDOAtVBN/ — page `1:2`, `📱Foundation & UI kit`. Values marked `VERIFIED` below were inspected from the actual Figma layers, text labels and/or component metadata.
2. **RideFlow (pending):** use as secondary reference for map layout, route planning, navigation instructions and bottom-sheet interaction. Do not override official tokens with RideFlow styles without an explicit project decision.
3. **Project-specific wheelchair navigation (proposed):** new map controls, accessible-facility markers, indoor map, floor switcher and route state components. These are extensions, **not official Town Pass components**.

When references conflict, prefer official Town Pass foundations, then RideFlow interaction patterns, then project-specific additions. Avoid assuming all UI should be a conventional dashboard: the product is **map-first**.

## 2. Product intent and experience

**Service:** An accessible wayfinding microservice helping wheelchair users move from outdoor sidewalks and crossings through accessible entrances to indoor points of interest, including elevator-based cross-floor navigation.

**Primary platform:** mobile-first Flutter Web, designed first at a phone-width viewport and adaptable to desktop demo projection.

**Core demo sequence (provided by the team):**

1. Outdoor map showing sidewalks, crossings, ramps, accessible facilities and building entry points, with location and filters.
2. Outdoor route selection and step-by-step guidance highlighting accessibility features along the route.
3. Transition at the building entrance from outdoor to indoor mapping.
4. Indoor map of **天母體育館**, with floor switcher **1F–3F**, accessible toilets, elevators, stairs and rooms/POIs.
5. Indoor navigation to a selected POI, including cross-floor instructions through elevators.

Do not imply live indoor positioning when it is only simulated or manually calibrated. Design separately for `GPS`, `confirmed indoor position`, and `demo / manually selected position` states.

## 3. Official typography — VERIFIED

The official Typography frame `3:15` explicitly lists:

- Traditional Chinese: **PingFang (蘋方)**.
- English text: **Roboto**.
- Numbers: **Roboto**.

| Official token | Size (px) | Line height (px) | Weight | Official intended usage |
|---|---:|---:|---|---|
| `font-H1-regular` | 36 | 48 | regular | 重點強調文字 |
| `font-H1-semibold` | 36 | 48 | semibold | 重點強調文字 |
| `font-H2-regular` | 24 | 32 | regular | 頁面標題 |
| `font-H2-semibold` | 24 | 32 | semibold | 頁面標題 |
| `font-H3-regular` | 16 | 22 | regular | 區塊標題、功能卡片標題、試算結果 |
| `font-H3-semibold` | 16 | 22 | semibold | 區塊標題、功能卡片標題、試算結果 |
| `font-Body-regular` | 14 | 20 | regular | 列表、彈窗、錯訊等內文 |
| `font-Body-semibold` | 14 | 20 | semibold | 列表、彈窗、錯訊等內文 |
| `font-Caption-regular` | 12 | 18 | regular | Official document says 「盡量不要使用」 |

**Implementation note:** PingFang may not exist on every desktop/browser or Android device. Use a Traditional-Chinese-capable fallback when implementing Flutter Web, without representing the fallback as an official font. Keep important navigational instructions legible; consider user-adjustable text scaling rather than shrinking critical text to Caption.

## 4. Official core palette — VERIFIED

The following HEX values are printed in the official Figma `Main colors` frame `3:141`. These are exact documented values, not invented brand colors.

### Primary (blue-teal)

| Token | HEX |
|---|---|
| Primary/50 | `#EDF8FA` |
| Primary/100 | `#DBF1F5` |
| Primary/200 | `#B4E2EA` |
| Primary/300 | `#93D4DF` |
| Primary/400 | `#71C5D5` |
| Primary/500 | `#5AB4C5` |
| Primary/600 | `#468D9B` |
| Primary/700 | `#356C77` |
| Primary/800 | `#22474E` |
| Primary/900 | `#112629` |
| Primary/950 | `#081315` |

### Secondary (amber)

| Token | HEX |
|---|---|
| Secondary/50 | `#FDF8ED` |
| Secondary/100 | `#FCF2DF` |
| Secondary/200 | `#F8E3BC` |
| Secondary/300 | `#F4D69E` |
| Secondary/400 | `#F0C87C` |
| Secondary/500 | `#F5BA4B` |
| Secondary/600 | `#E7A43C` |
| Secondary/700 | `#AD7B2B` |
| Secondary/800 | `#74521B` |
| Secondary/900 | `#3C2B0B` |
| Secondary/950 | `#1C1304` |

### Grey (neutral)

| Token | HEX |
|---|---|
| Grey/50 | `#F1F3F4` |
| Grey/100 | `#E3E7E9` |
| Grey/200 | `#CAD1D5` |
| Grey/300 | `#ADB8BE` |
| Grey/400 | `#91A0A8` |
| Grey/500 | `#738995` |
| Grey/600 | `#5E6D76` |
| Grey/700 | `#475259` |
| Grey/800 | `#30383D` |
| Grey/900 | `#171B1D` |
| Grey/950 | `#0B0D0E` |

### Supporting colors

- `Red/300 = #E29494`
- `Red/500 = #D45251`
- `Orange/300 = #F4B992`
- `Orange/500 = #FD853A`
- `Green/500 = #76A732`

**Primary use:** follow the official blue-teal family; do **not** replace it with arbitrary green merely because the subject involves accessibility. Green can indicate a verified usable facility or route when appropriate, but not be the primary identity by default.

## 5. Official semantic colors — VERIFIED

The official `Semantic colors` frame `3:390` specifies:

| Semantic token in Figma | HEX | Suggested role faithful to label |
|---|---|---|
| `background-color-Grey/50` | `#E3E7E9` | Neutral background |
| `reminder-hover-color-Orang/300` | `#F4B992` | Reminder hover |
| `reminder-default-color-Orang/500` | `#FD853A` | Reminder default |
| `disable-color-Gray/100` | `#CAD1D5` | Disabled |
| `text-derection-color-Gray/400` | `#91A0A8` | Instruction/low-emphasis text label (exact usage to inspect visually) |
| `text-second-color-Gray/700` | `#475259` | Secondary text |
| `text-primary-color-Gray/800` | `#30383D` | Primary text |
| `alarm-hover-color-Red/300` | `#E29494` | Alarm hover |
| `alarm-default-color-red/500` | `#D45251` | Alarm default |

**White correction pending:** the Figma semantic color label shows `#FFFFF` (five Fs), which is not valid six-digit HEX. Treat intended white as **unverified** until checked from the actual fill/variable value; do not copy this malformed code as a token. `#FFFFFF` may be used temporarily as an implementation fallback, explicitly not claimed as an extracted official value.

## 6. Official components and observed dimensions — VERIFIED examples

The UI Kit includes icon libraries, device system, list items, buttons, pop-ups, menu, search bar, tag, card, text field, tabs, top navigation, and footer tab bar. For exact appearance, reference the actual Figma components and screenshots; **the sizes below are observed example instances, not universal mandatory sizes**.

| Figma component | Observed size (px) | Verified notes |
|---|---:|---|
| `button/m` | 175 × 48 | Primary, Second, Alarm, Reminder, Disable; Default/Hover variants |
| `button/l` | 366 × 56 | Same categories with states |
| `searchbar` | 343 × 80 | Search component; adapt to over-map floating search |
| `tag` | 136 × 40 | Reuse as visual baseline for facility filter chips |
| `card` | 328 × 400 | Official card reference; navigation cards may need compact variant |
| `tab/single` | 200 × 46 | Primary/secondary and selected/default states |
| `tab/double` | 400 × 46 | Two-option tabs |
| `tab/triple` | 355 × 46 | Three-option tabs |
| `top navigation` | 395 × 56 | Variants with logo, icon buttons, text button, or no icons |
| `foot tab bar` | 375 × 94 | Exists in official kit; not mandatory on every map/navigation view |

Use consistent component treatment and states. Do not invent exact corner radii, shadow offsets or universal spacing grids: **not yet verified** from the component property inspection.

## 7. Product-specific extensions — PROPOSED, not official

These are project UI requirements, not claimed Town Pass components:

- `OutdoorMapCanvas`: map-first viewport with OSM tiles, selected routes and map markers.
- `MapSearchOverlay`: city-pass-style search UI anchored above map.
- `FacilityFilterChips`: accessible sidewalk / crossing / ramp / elevator / toilet / transit / indoor building filters.
- `FacilityMarker` with visual states `normal | selected | unavailable | unknown`; icon plus accessible text label, never color-only meaning.
- `FacilityDetailSheet`: concise description, accessibility data, source and update timestamp, CTA to route.
- `RouteOptionCard`: distinguish accessibility-suitable route from shorter route; show known conditions and unknown segments honestly.
- `TurnInstructionCard`: next instruction, distance, elevator or ramp action and next-floor indication.
- `IndoorOutdoorTransition`: clear transition at mapped accessible entrance; manual confirmation fallback.
- `FloorSelector`: 1F, 2F, 3F, prominent current floor, support accessible elevator path.
- `IndoorPOIMarker`: accessible toilet, elevator, stairs, room/classroom, accessible entrance.
- `CrossFloorRoute`: show elevator transfer, floor changes and destination leg.
- `PositionIndicator`: visibly differentiate actual GPS, actual indoor position and demo/manual position.

### Navigation UI behavior

- Keep map visible and use movable/collapsible bottom sheets rather than covering the whole map.
- Show a compact action while navigating and expand to details when requested.
- Provide text labels beside unfamiliar accessibility symbols.
- Keep route legend and distinction between accessible, blocked and unverified segments.
- Do not show a route as guaranteed accessible merely because there are accessible POIs along it. Unknown slope/width/obstruction must be represented as unknown.
- Avoid relying on green/red alone. Give icons and text descriptions.
- Provide accessible large interactive targets, readable contrast, and keyboard/screen-reader semantics in the implementation.

## 8. Screens to generate in Stitch

1. **室外地圖／探索** — search, facility filter chips, live location, accessible facility details, indoor building markers.
2. **室外路線規劃** — origin/destination, suggested accessible route, alternate option, facility requirements summary.
3. **室外導航** — focused turn-by-turn instructions, accessible segment/elevator hints, map route.
4. **室內外切換** — arrival at entrance, indoor map entry, positioning mode clarified.
5. **室內地圖** — 天母體育館 1F–3F floor selector, elevator, toilet, stairs, room POIs.
6. **室內目的地選擇** — selected floor / destination / route CTA.
7. **室內跨樓層導航** — entrance to elevator, change floors, elevator to POI, arrival.

Reusable overlays: filter selector, facility detail bottom sheet, position-permission issue, inaccessible route/error, unknown accessibility, floor selector and unavailable elevator.

## 9. Stitch generation contract

**Use the following order:**

1. Review official UI Kit style and this DESIGN.md first.
2. Review RideFlow reference screenshots, once provided, and identify only map/transportation patterns worth reusing.
3. Build a small component/visual system for the new app; do not change verified core colors and typography.
4. Generate **one outdoor map screen first**. Review its fidelity before producing additional screens.
5. Generate remaining screens using the same style and shared components.
6. Provide mobile screens with Traditional Chinese (Taiwan) content and realistic accessibility information labels.
7. Prioritize Figma-editable fidelity over HTML implementation shortcuts; final app is Flutter Web.

Avoid: generic banking dashboards, unrelated branding, arbitrary bright gradients, fictitious route guarantees, fully automated sensor positioning claims, excessive layers covering the map, visually attractive but unreadable map overlays.

## 10. Missing inputs / decisions

### Must supply next

- [ ] **RideFlow Figma link** or 3–5 screenshots (home map, route selection, navigation, bottom sheet, floating controls). Extract map-centric style patterns.
- [ ] **Screen storyboard / final Demo flow details**: exact start and end points, steps displayed, map states, interaction and transition behavior.
- [ ] **Indoor floor-plan assets for 天母體育館 1F–3F** or explicitly label the indoor maps as schematic illustrations.
- [ ] **Official branding/asset reuse permission and icon source**, including whether City Pass uses approved assets accessible to the submission.

### Helpful to decide

- [ ] Target mobile viewport and demo environment (mobile browser and projected desktop).
- [ ] The exact two or three outdoor locations to represent in the first map.
- [ ] Which wheelchair profile(s) to show, and whether road segment width/slope values are actually available.
- [ ] Which fields are real official open data vs mocked demo data (especially indoor position, obstruction status, accessible entrance mapping).
- [ ] Preferred Bottom Sheet state sizes and whether route instructions should stay visible during map exploration.
- [ ] Whether the team needs the exact official component corner radii, strokes, shadows, and icon exports verified in a deeper follow-up extraction.

## 11. Provenance and confidence

- `VERIFIED`: official labels/color values/typography/component variant names and selected instance sizes read directly from page `📱Foundation & UI kit` in the Figma file.
- `PROPOSED`: wheelchair-navigation UX rules and component system defined for the new product.
- `PENDING`: RideFlow, floor plans, exact prototype content, component radius/spacing/effects, and some semantic fill interpretation.

**This is an adaptation document, not an assertion that every project-specific rule comes from the official Town Pass design team.**
