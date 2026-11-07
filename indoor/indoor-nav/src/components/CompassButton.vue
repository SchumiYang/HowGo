<script setup lang="ts">
import { t } from '../i18n'
import { computed } from 'vue'

const props = defineProps<{ bearing: number }>()
const emit = defineEmits<{ reset: [] }>()

/** screen-up direction as a compass heading, 0–359 */
const heading = computed(() => ((Math.round(props.bearing) % 360) + 360) % 360)
</script>

<template>
  <button class="compass" :aria-label="t('指北，目前方位 {0} 度', heading)" @click="emit('reset')">
    <!-- the needle points to north on screen, i.e. rotated against the map bearing -->
    <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" :style="{ transform: `rotate(${-bearing}deg)` }">
      <path d="M12 2.5l4 9.5h-8z" fill="var(--tp-red600)" />
      <path d="M12 21.5l-4-9.5h8z" fill="var(--tp-grayscale500)" />
      <circle cx="12" cy="12" r="1.6" fill="var(--tp-white)" />
    </svg>
    <span class="n" aria-hidden="true">N</span>
  </button>
</template>

<style scoped>
.compass {
  position: relative;
  width: 56px;
  height: 56px;
  border: 0;
  border-radius: 50%;
  background: var(--tp-white);
  box-shadow: var(--float-shadow);
  display: grid;
  place-items: center;
}
.n {
  position: absolute;
  top: 2px;
  right: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--tp-red600);
}
</style>
