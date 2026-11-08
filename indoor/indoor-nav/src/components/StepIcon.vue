<script setup lang="ts">
import { iconDataUrl } from '../map/icons'
import type { Step } from '../routing/instructions'

const props = defineProps<{ step: Step; size?: number }>()
const s = props.size ?? 32

// arrow paths in a 24 viewBox
const PATHS: Record<string, string> = {
  straight: 'M12 20V5M6.5 10.5L12 5l5.5 5.5',
  'turn-left': 'M16 20v-7a3 3 0 0 0-3-3H6M10 6L6 10l4 4',
  'turn-right': 'M8 20v-7a3 3 0 0 1 3-3h7M14 6l4 4-4 4',
  'u-turn': 'M8 20V9a4 4 0 0 1 8 0v4M12.5 10.5L16 14l3.5-3.5',
  arrive: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11zM12 12.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z',
}
</script>

<template>
  <img v-if="step.kind === 'elevator' || step.kind === 'stairs'" :src="iconDataUrl(step.kind)" :width="s" :height="s" alt="" class="step-icon" />
  <svg v-else :width="s" :height="s" viewBox="0 0 24 24" aria-hidden="true" class="step-icon">
    <path
      :d="PATHS[step.kind === 'arrive' ? 'arrive' : step.maneuver ?? 'straight']"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<style scoped>
.step-icon {
  flex: none;
}
</style>
