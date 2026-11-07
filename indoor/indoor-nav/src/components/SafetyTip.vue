<script setup lang="ts">
import { onMounted, useTemplateRef } from 'vue'

const emit = defineEmits<{ close: [] }>()
const btn = useTemplateRef<HTMLButtonElement>('btn')
// move focus into the dialog so screen readers announce it
onMounted(() => btn.value?.focus())
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="tip tp-card" role="dialog" aria-modal="true" aria-labelledby="tip-title" aria-describedby="tip-body">
      <svg class="phone" viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
        <!-- phone held flat, top pointing in the walking direction (arrow) -->
        <rect x="15" y="12" width="18" height="32" rx="3" fill="none" stroke="currentColor" stroke-width="2.5" />
        <path d="M24 2l6 7h-12z" fill="currentColor" />
      </svg>
      <h2 id="tip-title">開始即時定位</h2>
      <p id="tip-body">請將手機平拿、頂端朝前進方向（傾斜不超過 45°）。</p>
      <p class="safety">本服務僅供參考，無法取代手杖或導盲犬。</p>
      <button ref="btn" class="btn primary" @click="emit('close')">知道了</button>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: absolute;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(23, 27, 29, 0.45);
}
.tip {
  width: min(360px, 100%);
  padding: 20px 16px 16px;
  text-align: center;
}
.phone {
  color: var(--tp-primary700);
}
h2 {
  margin: 4px 0 8px;
  font-size: 18px;
}
p {
  margin: 0 0 8px;
  font-size: 16px;
}
.safety {
  font-size: 14px;
  color: var(--tp-grayscale700);
}
.btn {
  width: 100%;
  margin-top: 8px;
}
</style>
