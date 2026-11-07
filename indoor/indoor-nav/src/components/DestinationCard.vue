<script setup lang="ts">
import AccessibleToggle from './AccessibleToggle.vue'

defineProps<{
  destLabel?: string
  destLevel?: string
  summary: { meters: number; minutes: number; levels: string[] }
  levelName: (id: string) => string
}>()
const accessibleOnly = defineModel<boolean>('accessibleOnly', { required: true })
const emit = defineEmits<{ start: []; close: [] }>()
</script>

<template>
  <section class="dest" aria-labelledby="dest-name">
    <div class="head">
      <div class="title">
        <h2 id="dest-name" class="name">{{ destLabel ?? '目的地' }}</h2>
        <div class="meta">
          <span v-if="destLevel">{{ levelName(destLevel) }} · </span>
          <b>{{ summary.meters }} 公尺</b> · 約 {{ summary.minutes }} 分鐘
          <span v-if="summary.levels.length > 1"> · 經過 {{ summary.levels.map(levelName).join(' → ') }}</span>
        </div>
      </div>
      <button class="close" aria-label="取消路線" @click="emit('close')">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>
      </button>
    </div>
    <AccessibleToggle v-model="accessibleOnly" />
    <button class="btn primary go" @click="emit('start')">開始導航</button>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.title {
  flex: 1;
  min-width: 0;
}
.name {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}
.meta {
  color: var(--tp-grayscale700);
}
.meta b {
  color: var(--tp-grayscale900);
  font-weight: 600;
}
.close {
  width: 48px;
  height: 48px;
  margin: -6px -8px 0 0;
  border: 0;
  border-radius: var(--tpnav-radius-control);
  background: transparent;
  color: var(--tp-grayscale700);
  display: grid;
  place-items: center;
}
.go {
  width: 100%;
  min-height: 56px;
  margin-top: 8px;
  font-size: 18px;
}
</style>
