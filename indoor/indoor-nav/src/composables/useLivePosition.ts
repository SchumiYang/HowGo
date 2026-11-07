import { t } from '../i18n'
import { computed, ref, shallowRef } from 'vue'
import { townpass } from '../bridge/townpass'
import type { VenueData } from '../data/types'
import { createPositioning, loadPositioningMaps, type Positioning, type PositioningBridge } from '../positioning/engine'
import type { Magmap, PositionUpdate, Radiomap } from '../positioning/types'
import type { LevelChangeEvent } from './levelChange'

export const LIVE_SOURCE_LABEL: Record<PositionUpdate['source'], string> = { pdr: '步行推算', wifi: 'WiFi', fused: '融合' }
/** below this confidence the chip is muted and says 「定位精度較低」 */
export const LOW_CONFIDENCE = 0.35

/**
 * Live positioning (src/positioning engine) for the app: lazy map loading, start/stop, seeding.
 * Maps are fetched on the first start of a page load, so maps published after a survey are
 * picked up on the next load; missing or synthetic maps leave the engine on PDR + map constraint.
 */
export function useLivePosition(venueId: string, getData: () => VenueData | null, ensureAllWalls: () => Promise<unknown>) {
  const active = ref(false)
  const starting = ref(false)
  const error = ref<string | null>(null)
  const last = shallowRef<PositionUpdate | null>(null)
  /** debug: raw stats snapshot */
  const stats = shallowRef<Positioning['stats'] | null>(null)
  const startedAt = ref(0)

  let engine: Positioning | null = null
  let maps: { radiomap: Radiomap | null; magmaps: Magmap[] } | null = null
  let off: (() => void) | null = null
  const levelListeners = new Set<(e: LevelChangeEvent) => void>()

  const lowConfidence = computed(() => !!last.value && last.value.confidence < LOW_CONFIDENCE)

  async function ensureEngine(): Promise<Positioning | null> {
    if (engine) return engine
    const d0 = getData()
    if (!d0) return null
    // the occupancy grid needs every level's walls; they load lazily otherwise
    await ensureAllWalls()
    const data = getData()!
    maps ??= await loadPositioningMaps(venueId, data.levels.map((l) => l.level.id))
    engine = createPositioning({ venueData: data, radiomap: maps.radiomap, magmap: maps.magmaps })
    off = engine.onUpdate((u) => {
      last.value = u
      stats.value = { ...engine!.stats }
    })
    // automatic floor-change detection (barometer / WiFi level vote, engine option autoLevel)
    engine.onLevelChange((e) => {
      stats.value = { ...engine!.stats }
      for (const l of levelListeners) l(e)
    })
    return engine
  }

  /** Start sensors (+ WiFi when a radiomap exists). Returns false when the bridge is unavailable. */
  async function start(bridge: PositioningBridge = townpass): Promise<boolean> {
    if (active.value) return true
    starting.value = true
    error.value = null
    try {
      const e = await ensureEngine()
      if (!e) return false
      if (!e.start(bridge, { wifiIntervalMs: 30000 })) {
        error.value = t('即時定位需在台北通 App 內使用')
        return false
      }
      active.value = true
      startedAt.value = Date.now()
      stats.value = { ...e.stats }
      return true
    } finally {
      starting.value = false
    }
  }

  /** Seed the filter (start point, QR anchor, 2F elevator after 「已到 2F」). headingDeg: clockwise from local +y. */
  function seed(x: number, y: number, level: string, headingDeg?: number | null) {
    engine?.setKnownPosition(x, y, level, { accuracyM: 1, headingDeg: headingDeg ?? null })
  }

  async function stop() {
    if (!active.value) return
    active.value = false
    await engine?.stop()
    last.value = null
  }

  if (typeof window !== 'undefined') window.addEventListener('pagehide', () => void stop())

  function dispose() {
    off?.()
    void stop()
  }

  /** Subscribe to the engine's automatic floor changes. */
  function onLevelChange(cb: (e: LevelChangeEvent) => void): () => void {
    levelListeners.add(cb)
    return () => levelListeners.delete(cb)
  }

  return { active, starting, error, last, stats, startedAt, lowConfidence, start, seed, stop, dispose, onLevelChange }
}

export type LivePosition = ReturnType<typeof useLivePosition>
