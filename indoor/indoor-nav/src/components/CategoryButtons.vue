<script setup lang="ts">
import { QUICK_ACTIONS, type QuickActionId } from '../data/catalog'
import { iconDataUrl } from '../map/icons'

defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ action: [QuickActionId] }>()

// accessible toilet first and visually primary
const ITEMS: { id: QuickActionId; icon: string; primary?: boolean }[] = [
  { id: 'accessibleToilet', icon: 'toilet.accessible', primary: true },
  { id: 'toilet', icon: 'toilet.male' },
  { id: 'elevator', icon: 'elevator' },
]
</script>

<template>
  <div class="cats" role="group" aria-label="找最近的設施">
    <button
      v-for="it in ITEMS"
      :key="it.id"
      class="cat"
      :class="{ primary: it.primary }"
      :disabled="disabled"
      :aria-label="`前往最近的${QUICK_ACTIONS[it.id].label}`"
      @click="emit('action', it.id)"
    >
      <img :src="iconDataUrl(it.icon)" width="36" height="36" alt="" />
      <span>{{ QUICK_ACTIONS[it.id].label }}</span>
    </button>
  </div>
</template>

<style scoped>
.cats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.cat {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 64px;
  padding: 8px 16px;
  border-radius: var(--tpnav-radius-control);
  border: 1px solid var(--tp-primary500);
  background: var(--tp-white);
  color: var(--tp-primary700);
  font-size: 16px;
  font-weight: 600;
}
.cat:active {
  background: var(--tp-primary50);
}
.cat.primary {
  grid-column: 1 / -1;
  min-height: 72px;
  font-size: 18px;
  background: var(--tp-primary700);
  border-color: var(--tp-primary700);
  color: var(--tp-white);
}
.cat.primary:active {
  background: var(--tp-primary600);
}
.cat:disabled {
  background: var(--tp-grayscale100);
  border-color: var(--tp-grayscale100);
  color: var(--tp-grayscale500);
}
</style>
