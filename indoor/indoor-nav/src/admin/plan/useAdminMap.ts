import { onBeforeUnmount, onMounted, shallowRef, type ShallowRef } from 'vue'
import type { VenueData } from '../../data/types'
import { makeFrame, type Frame } from '../../geo/frame'
import { IndoorMap } from '../../map/IndoorMap'

/**
 * The app's IndoorMap reused for editing: flat (2D), the app's own tap handling disabled; the
 * tabs add their own layers / handlers on `im.map` after `ready`.
 */
export function useAdminMap(el: Readonly<ShallowRef<HTMLElement | null>>) {
  const im = shallowRef<IndoorMap | null>(null)
  const frame = shallowRef<Frame | null>(null)
  let readyResolve!: () => void
  const ready = new Promise<void>((r) => (readyResolve = r))

  onMounted(() => {
    const m = new IndoorMap(el.value!, 0)
    m.onPick = () => {}
    void m.setView3D(false)
    m.setInsets({ top: 24, bottom: 24, left: 24, right: 24 })
    m.map.once('load', () => readyResolve())
    im.value = m
  })
  onBeforeUnmount(() => im.value?.destroy())

  /** (Re)draw the venue; refits only the first time (IndoorMap.setVenue semantics). */
  async function show(data: VenueData, level: string) {
    await ready
    const f = makeFrame({ origin: data.venue.origin, bearingDeg: data.venue.bearing_deg })
    frame.value = f
    await im.value!.setVenue(data, f)
    await im.value!.setLevel(level)
  }

  return { im, frame, ready, show }
}
