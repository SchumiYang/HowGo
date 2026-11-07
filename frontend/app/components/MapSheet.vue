<script setup lang="ts">
const level = defineModel<number>({ required: true })
const height = ref<number | null>(null)
const stops = [0.18, 0.53, 0.80]
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
  if (drag.moved) height.value = Math.max(140, Math.min(window.innerHeight * stops[2]!, drag.height + delta))
}

function end(event: PointerEvent) {
  if (!drag || drag.id !== event.pointerId) return
  wasDragged = drag.moved
  if (height.value !== null && event.type !== 'pointercancel') {
    const viewport = window.innerHeight
    const nearest = stops.reduce((best, stop, i) =>
      Math.abs(Math.max(140, stop * viewport) - height.value!) < Math.abs(Math.max(140, stops[best]! * viewport) - height.value!) ? i : best, 0)
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
    :style="{ height: height !== null ? height + 'px' : `max(140px, ${stops[level]! * 100}dvh)` }">
    <button class="sheet-handle" type="button" :aria-label="level === 2 ? '收起控制面板' : '展開控制面板'"
      @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="end" @click="cycle"
      @keydown.up.prevent="level = Math.min(2, level + 1)" @keydown.down.prevent="level = Math.max(0, level - 1)">
      <span />
    </button>
    <slot name="summary" />
    <div class="sheet-content"><slot /></div>
  </aside>
</template>
