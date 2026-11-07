<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue'
import type { PaddingOptions } from 'maplibre-gl'
import type { VenueData } from '../data/types'
import type { Frame, XY } from '../geo/frame'
import type { FloorplanOverlay } from '../map/floorplan'
import { IndoorMap, type MapPick } from '../map/IndoorMap'
import type { Route } from '../routing/route'

const props = defineProps<{
  data: VenueData | null
  frame: Frame | null
  level: string
  me: { level: string; xy: XY; accuracy?: number } | null
  /** glide the dot between updates (live positioning) */
  animateMe?: boolean
  heading: number | null
  route: Route | null
  destLabel?: string
  levelName: (id: string) => string
  insets: PaddingOptions
  /** 2.5D view: extruded walls + pitched camera */
  view3d: boolean
  /** raster floor plan under the unit fills (null = hidden) */
  floorplan?: FloorplanOverlay | null
  /** floating controls (top-right) for the building fit */
  controlsZone?: { right: number; bottom: number } | null
}>()
const emit = defineEmits<{ pick: [MapPick]; camera: [{ bearing: number; pitch: number }]; userpan: [] }>()

const el = useTemplateRef<HTMLDivElement>('el')
let im: IndoorMap | null = null

onMounted(() => {
  im = new IndoorMap(el.value!, props.data?.venue.bearing_deg ?? 0)
  im.onPick = (p) => emit('pick', p)
  im.onCamera = (c) => emit('camera', c)
  im.onUserPan = () => emit('userpan')
  im.setInsets(props.insets)
  im.setView3D(props.view3d)
  // order matters: venue (sets frame) before level/me/route
  watch(() => [props.data, props.frame] as const, async ([d, f]) => {
    if (!d || !f || !im) return
    await im.setVenue(d, f)
    await im.setLevel(props.level)
    await im.setMe(props.me, props.heading)
    await im.setRoute(props.route, props.levelName, props.destLabel)
  }, { immediate: true })
  watch(() => props.level, (l) => im?.setLevel(l))
  watch(() => [props.me, props.heading] as const, ([m, h]) => im?.setMe(m, h, props.animateMe))
  watch(() => [props.route, props.destLabel] as const, ([r, d]) => im?.setRoute(r, props.levelName, d))
  watch(() => props.insets, (p) => im?.setInsets(p))
  watch(() => props.view3d, (v) => im?.setView3D(v))
  watch(() => props.controlsZone, (z) => im?.setControlsZone(z ?? null), { immediate: true })
  watch(() => [props.floorplan, props.frame] as const, ([fp]) => im?.setFloorplan(fp ?? null), { immediate: true })
})

onBeforeUnmount(() => im?.destroy())

defineExpose({
  fitBuilding: (animate = true) => im?.fitBuilding(animate),
  fitPoints: (pts: XY[]) => im?.fitPoints(pts),
  flyTo: (xy: XY, zoom?: number, bearing?: number) => im?.flyTo(xy, zoom, bearing),
  resetNorth: () => im?.resetNorth(),
  follow: (xy: XY) => im?.follow(xy),
})
</script>

<template>
  <div ref="el" class="tn-map" role="application" aria-label="室內地圖"></div>
</template>

<style scoped>
.tn-map {
  position: absolute;
  inset: 0;
}
</style>
