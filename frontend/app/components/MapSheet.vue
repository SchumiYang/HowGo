<script setup lang="ts">
import { t } from '~/i18n'
const level = defineModel<number>({ required: true })
const height = ref<number | null>(null)
const stops = [0.24, 0.53, 0.82]
const MIN_HEIGHT = 190
const sheet = useTemplateRef<HTMLElement>('sheet')
let drag: { id: number; y: number; height: number; moved: boolean } | null = null
let wasDragged = false

function start(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0 || !sheet.value) return
  wasDragged = false
  drag = { id: event.pointerId, y: event.clientY, height: sheet.value.offsetHeight, moved: false }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function move(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  const delta = drag.y - event.clientY
  if (Math.abs(delta) > 6) drag.moved = true
  if (drag.moved) height.value = Math.max(MIN_HEIGHT, Math.min(window.innerHeight * stops[2]!, drag.height + delta))
}

function end(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  wasDragged = drag.moved
  if (height.value !== null && event.type !== 'pointercancel') {
    const viewport = window.innerHeight
    const size = (i: number) => Math.max(MIN_HEIGHT, stops[i]! * viewport)
    const nearest = stops.reduce((best, _, i) =>
      Math.abs(size(i) - height.value!) < Math.abs(size(best) - height.value!) ? i : best, 0)
    const delta = drag.y - event.clientY
    level.value = nearest === level.value && Math.abs(delta) > 24
      ? Math.max(0, Math.min(2, level.value + Math.sign(delta))) : nearest
  }
  drag = null
  height.value = null
}

function cycle() {
  if (wasDragged) {
    wasDragged = false
    return
  }
  level.value = (level.value + 1) % stops.length
}
</script>

<template>
  <aside ref="sheet" class="map-sheet" :data-dragging="height !== null"
    :style="{ height: height !== null ? height + 'px' : `max(${MIN_HEIGHT}px, ${stops[level]! * 100}dvh)` }">
    <button class="sheet-handle" type="button" :aria-label="level === 2 ? t('收起路線面板') : t('展開路線面板')"
      @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="end" @click="cycle"
      @keydown.up.prevent="level = Math.min(2, level + 1)" @keydown.down.prevent="level = Math.max(0, level - 1)">
      <span />
    </button>
    <slot name="summary" />
    <div class="sheet-content"><slot /></div>
    <div v-if="$slots.footer" class="sheet-footer"><slot name="footer" /></div>
  </aside>
</template>
