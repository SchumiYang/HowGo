<script setup lang="ts">
import { t } from '../i18n'
import { CATEGORY_LABEL, type PlaceEntry } from '../data/catalog'

defineProps<{ place: PlaceEntry; levelName: (id: string) => string; canRoute: boolean }>()
const emit = defineEmits<{ go: []; start: []; close: [] }>()
</script>

<template>
  <section class="card" aria-labelledby="place-name">
    <div class="head">
      <div class="title">
        <h2 id="place-name" class="name">{{ place.ref && !place.name.includes(place.ref) ? `${place.ref} ${place.name}` : place.name }}</h2>
        <div class="mut">{{ t(CATEGORY_LABEL[place.category] ?? place.category) }} · {{ levelName(place.level) }}</div>
      </div>
      <button class="close" :aria-label="t('關閉')" @click="emit('close')">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>
      </button>
    </div>
    <div class="row">
      <button class="btn" @click="emit('start')">{{ t('設為起點') }}</button>
      <button class="btn primary" :disabled="!canRoute" @click="emit('go')">{{ t('導航到這裡') }}</button>
    </div>
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
  font-size: 18px;
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
.row {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 8px;
  margin-top: 12px;
}
</style>
