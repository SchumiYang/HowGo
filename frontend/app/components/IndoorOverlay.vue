<script setup lang="ts">
/**
 * Full-screen indoor navigation over the outdoor map. The indoor app (indoor/indoor-nav, with its
 * own maplibre-gl v6) is loaded only when this opens. Embedded safe areas follow the host:
 * --safe-top is 0 inside the Town Pass WebView ([data-embedded]).
 */
import { defineAsyncComponent, h, onBeforeUnmount, onMounted } from 'vue'

const props = defineProps<{ venue: string; destination?: string }>()
const emit = defineEmits<{ close: [] }>()

function close() {
  emit('close')
}

// shown while the indoor bundle loads / if it fails: always keep a way back to the outdoor map
const BackPill = () =>
  h('button', { type: 'button', class: 'indoor-overlay-back', 'aria-label': '返回室外地圖', onClick: close }, [
    h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, [h('path', { d: 'M19 12H5m6-6-6 6 6 6' })]),
    h('span', '室外地圖'),
  ])

const IndoorNav = defineAsyncComponent({
  loader: () => import('#indoor/IndoorNav.vue'),
  delay: 150,
  timeout: 30000,
  loadingComponent: { render: () => h('div', { class: 'indoor-overlay-state', role: 'status' }, [BackPill(), h('p', '載入室內地圖中…')]) },
  errorComponent: { render: () => h('div', { class: 'indoor-overlay-state', role: 'alert' }, [BackPill(), h('p', '室內地圖暫時無法載入，請稍後再試。')]) },
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
onMounted(() => window.addEventListener('keydown', onKey))
// history is owned by app.vue: `close` makes it go back one entry
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="indoor-overlay" role="dialog" aria-modal="true" :aria-label="`${props.venue === 'tianmu' ? '天母體育館' : props.venue} 室內導航`">
    <IndoorNav :venue="props.venue" :destination="props.destination" @close="close" />
  </div>
</template>

<style>
.indoor-overlay {
  position: fixed;
  inset: 0;
  /* over the general map, below AccessibleMode (50) and ModeLanding (60) */
  z-index: 40;
  background: var(--grey-50);
}
.indoor-overlay-state {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: calc(var(--safe-top) + 80px) 24px calc(var(--safe-bottom) + 24px);
  color: var(--text-secondary);
  font-size: 16px;
  line-height: 22px;
  text-align: center;
}
.indoor-overlay-back {
  position: absolute;
  top: calc(var(--safe-top) + 12px);
  left: 16px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 56px;
  padding: 0 18px 0 14px;
  border: 0;
  border-radius: 999px;
  background: var(--surface);
  color: var(--primary-700);
  font-size: 16px;
  font-weight: 600;
  box-shadow: var(--shadow-floating);
}
</style>
