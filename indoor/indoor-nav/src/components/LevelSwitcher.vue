<script setup lang="ts">
import { t } from '../i18n'
import { computed } from 'vue'
import type { Level } from '../data/types'

const props = defineProps<{ levels: Level[]; routeLevels?: string[]; levelsWithNav?: string[] }>()
const model = defineModel<string>({ required: true })

// highest floor on top, like an elevator panel
const ordered = computed(() => [...props.levels].sort((a, b) => b.ordinal - a.ordinal))
const label = (l: Level) =>
  `${l.name}${props.routeLevels?.includes(l.id) ? t('，路線經過') : ''}${props.levelsWithNav && !props.levelsWithNav.includes(l.id) ? t('，僅平面圖') : ''}`
</script>

<template>
  <div class="levels" role="radiogroup" :aria-label="t('切換樓層')">
    <button
      v-for="l in ordered"
      :key="l.id"
      class="lv"
      role="radio"
      :aria-checked="model === l.id"
      :aria-label="label(l)"
      :class="{ on: model === l.id }"
      @click="model = l.id"
    >
      {{ l.name }}
      <span v-if="routeLevels?.includes(l.id)" class="dot" aria-hidden="true"></span>
    </button>
  </div>
</template>

<style scoped>
.levels {
  display: flex;
  flex-direction: column;
  background: var(--tp-white);
  border-radius: 28px; /* pill, like HowGo's floating controls */
  box-shadow: var(--float-shadow);
  overflow: hidden;
}
.lv {
  position: relative;
  width: 56px;
  height: 52px;
  border: 0;
  background: transparent;
  color: var(--tp-grayscale900);
  font-weight: 600;
  font-size: 16px;
}
.lv + .lv {
  border-top: 1px solid var(--tp-grayscale100);
}
.lv.on {
  background: var(--tp-primary700);
  color: var(--tp-white);
}
.dot {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--tp-primary500);
  box-shadow: 0 0 0 2px var(--tp-white);
}
</style>
