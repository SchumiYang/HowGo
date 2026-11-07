<script setup lang="ts">
/**
 * Drop-in sensor hints while positioning runs: an uncalibrated magnetometer (iPhone sends no
 * samples) and a low sensor rate (Android battery saver). Usage:
 *   <MagCalibrationHint :active="positioningRunning" />
 * Reusable outside the main app (admin 驗證 tab); styling uses the --tp-* tokens with fallbacks.
 */
import { useSensorHints } from '../composables/useMagHint'

const props = defineProps<{ active: boolean }>()
const { mag, power, dismissMag, dismissPower } = useSensorHints(() => props.active)
</script>

<template>
  <div v-if="mag || power" class="hints">
    <div v-if="mag" class="tn-hint" role="alert">
      <svg class="ic" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
        <path d="M12 12c-2.5-3.5-7-3.5-7 0s4.5 3.5 7 0 7-3.5 7 0-4.5 3.5-7 0z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <span class="txt">磁力計尚未校正：請拿著手機在空中畫幾次 8 字</span>
      <button class="x" aria-label="關閉磁力計校正提示" @click="dismissMag">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>
      </button>
    </div>
    <div v-if="power" class="tn-hint" role="alert">
      <svg class="ic" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
        <rect x="3" y="7" width="16" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2" />
        <path d="M21 10.5v3M6 10v4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <span class="txt">感測器頻率偏低，可能是省電模式：關閉省電模式可提高定位準確度</span>
      <button class="x" aria-label="關閉省電模式提示" @click="dismissPower">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.hints {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tn-hint {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px 6px 12px;
  border-radius: var(--tpnav-radius-small);
  border: 1px solid var(--tp-orange500, #fd853a);
  background: #fff4ec;
  color: var(--tp-grayscale900, #171b1d);
  box-shadow: var(--tpnav-shadow-floating);
}
.ic {
  flex: none;
  color: var(--tp-orange500, #fd853a);
}
.txt {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.35;
}
.x {
  flex: none;
  width: 48px;
  height: 48px;
  border: 0;
  border-radius: var(--tpnav-radius-control);
  background: transparent;
  color: var(--tp-grayscale700, #475259);
  display: grid;
  place-items: center;
}
</style>
