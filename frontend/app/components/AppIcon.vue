<script setup lang="ts">
const paths = {
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5.5-1 4 4',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm-6-3a6 6 0 0 0 12 0m-6 6v3',
  layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  locate: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm0-4a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0-13v3m0 14v3M2 12h3m14 0h3',
  directions: 'M12 2.8 21.2 12 12 21.2 2.8 12 12 2.8ZM9 14v-2.5a1.5 1.5 0 0 1 1.5-1.5H15m-2-2 2 2-2 2',
  swap: 'M8 20V5m0 0L4.5 8.5M8 5l3.5 3.5M16 4v15m0 0 3.5-3.5M16 19l-3.5-3.5',
  back: 'M19 12H5m6-6-6 6 6 6',
  chevron: 'm9 6 6 6-6 6',
  history: 'M3 12a9 9 0 1 0 2.6-6.4M3 4v4h4m5-1v5l3 2',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  balance: 'M12 4v16m-7 0h14M5 8h14M5 8l-3 6a3 3 0 0 0 6 0L5 8Zm14 0-3 6a3 3 0 0 0 6 0l-3-6Z',
  accessible: 'M12 6.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5ZM10 9v5h5l2.5 5M10 11H7m.5 1.8A5 5 0 1 0 15 19',
  navigation: 'M12 3 19 20l-7-4-7 4 7-17Z',
  volume: 'M4 9v6h4l5 4V5L8 9H4Zm12.5-.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9v6h4l5 4V5L8 9H4Zm12 1 5 5m0-5-5 5',
  close: 'M6 6l12 12M18 6 6 18',
  pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  walk: 'M13 5.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5ZM10 21l2-6 3 3v3m-5-12-3 4m3-4 3-1 2 4 3 1m-8-4 1.5 6',
  move: 'M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5',
  ruler: 'M3 8h18v8H3V8Zm4 0v3m4-3v4m4-4v3m4-3v4',
  slope: 'M3 19h18L21 7 3 19Z',
  stairs: 'M3 20h5v-5h5v-5h5V5h3',
  info: 'M12 8h.01M12 11v6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  compass: 'M12 3 15 12h-6l3-9Zm0 18-3-9h6l-3 9Z',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  heart: 'M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z',
  textSize: 'M3 9h8M7 9v10m6-14h8m-4 0v14',
  elevator: 'M4 3h16v18H4V3Zm5 6.5 2-2.5 2 2.5M9 14.5l2 2.5 2-2.5M16 8v8',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-9-9h18M12 3c2.5 2.4 3.8 5.4 3.8 9s-1.3 6.6-3.8 9c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3Z',
  arrowRight: 'M5 12h14m-6-6 6 6-6 6',
  down: 'm6 9 6 6 6-6',
} as const

export type IconName = keyof typeof paths

defineProps<{ name: IconName; size?: number }>()
</script>

<template>
  <svg class="app-icon" :width="size ?? 22" :height="size ?? 22" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name]" />
  </svg>
</template>
