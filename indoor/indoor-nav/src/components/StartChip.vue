<script setup lang="ts">
import { t } from '../i18n'
import { ref } from 'vue'
import { SOURCE_LABEL, type StartPoint } from '../composables/useNavigator'

defineProps<{
  start: StartPoint | null
  scanning?: boolean
  /** live positioning status (null = off) */
  live?: { label: string; low: boolean } | null
  liveStarting?: boolean
  /** automatic start position: asking the user (null = settled) */
  locate?:
    | { kind: 'locating' }
    | { kind: 'estimate'; place: string; acc: number }
    | { kind: 'fallback'; fallbackLabel: string }
    | null
}>()
const emit = defineEmits<{ pick: []; scan: []; live: []; confirm: []; correct: [] }>()
const open = ref(false)

function act(e: 'pick' | 'scan' | 'live') {
  open.value = false
  if (e === 'pick') emit('pick')
  else if (e === 'scan') emit('scan')
  else emit('live')
}
</script>

<template>
  <div class="tn-start">
    <button class="tn-chip" :class="{ low: live?.low && !locate, ask: locate }" :aria-expanded="open" aria-controls="start-actions" @click="open = !open">
      <span class="chip-header">
        <span class="pin" :class="{ unset: (!start && !live) || locate?.kind === 'fallback', pulse: (live && !live.low) || locate?.kind === 'locating' }" aria-hidden="true"></span>
        <span v-if="locate?.kind === 'fallback'" class="src">{{ t('未定位') }}</span>
        <template v-else-if="!locate">
          <span v-if="live" class="src">{{ t('即時') }}</span>
          <span v-else-if="start" class="src">{{ t(SOURCE_LABEL[start.source]) }}</span>
        </template>
        <span class="more">{{ open ? t('收合') : t('更改') }}</span>
      </span>
      <!-- automatic start position (CityGeni-style: show the estimate honestly, make correcting easy) -->
      <span v-if="locate?.kind === 'locating'" class="lbl" role="status">{{ t('正在定位你的位置…') }}</span>
      <span v-else-if="locate?.kind === 'estimate'" class="lbl" role="status">{{ t('目前位置：{0}（±{1} 公尺）· 正確嗎？', locate.place, locate.acc) }}</span>
      <span v-else-if="locate?.kind === 'fallback'" class="lbl" role="status">
        {{ t('請點地圖標出你的位置') }}
        <span class="sub">{{ t('目前以{0}為起點', t(locate.fallbackLabel)) }}</span>
      </span>
      <span v-else-if="live" class="lbl">
        {{ t(live.label) }}
        <span v-if="live.low" class="sub">{{ t('定位精度較低') }}</span>
      </span>
      <span v-else class="lbl">
        <template v-if="start">{{ t('起點：{0}', t(start.label)) }}</template>
        <template v-else>{{ t('尚未設定起點') }}</template>
      </span>

    </button>
    <div v-if="locate?.kind === 'estimate'" class="ask-row">
      <button class="btn primary" @click="emit('confirm')">{{ t('是') }}</button>
      <button class="btn" @click="emit('correct')">{{ t('點地圖修正') }}</button>
    </div>
    <div v-else-if="locate?.kind === 'fallback'" class="ask-row one">
      <button class="btn primary" @click="emit('correct')">{{ t('點地圖標示位置') }}</button>
    </div>
    <div v-if="open" id="start-actions" class="actions">
      <button class="btn" @click="act('pick')">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" fill="none" stroke="currentColor" stroke-width="2" /><circle cx="12" cy="10" r="2.2" fill="currentColor" /></svg>
        {{ t('點地圖設定') }}
      </button>
      <button class="btn" :disabled="scanning" @click="act('scan')">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M7 12h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        {{ scanning ? t('掃描中…') : t('掃描定位碼') }}
      </button>
      <button class="btn wide" :class="{ primary: !!live }" :aria-pressed="!!live" :disabled="liveStarting" @click="act('live')">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="currentColor" /><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" /></svg>
        {{ t('即時定位：{0}', t(liveStarting ? '啟動中…' : live ? '開' : '關')) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tn-chip {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 7px;
  width: 100%;
  min-height: 48px;
  padding: 10px 12px;
  border: 1px solid var(--tp-grayscale200);
  border-radius: var(--tpnav-radius-control);
  background: var(--tp-grayscale50);
  text-align: left;
}
.chip-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
}
.pin {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--tp-primary700);
  box-shadow: 0 0 0 3px var(--tp-white), 0 0 0 5px var(--tp-primary200);
}
.pin.unset {
  background: var(--tp-grayscale500);
  box-shadow: 0 0 0 3px var(--tp-white), 0 0 0 5px var(--tp-grayscale200);
}
.lbl {
  min-width: 0;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.src {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--tpnav-radius-control);
  background: var(--tp-primary100);
  color: var(--tp-primary700);
  font-size: 14px;
  font-weight: 600;
}
.more {
  margin-inline-start: auto;
  color: var(--tp-primary700);
  font-size: 14px;
  font-weight: 600;
}
.tn-chip.low {
  background: var(--tp-grayscale100);
  color: var(--tp-grayscale700);
}
.sub {
  display: block;
  margin-top: 2px;
  font-size: 14px;
  font-weight: 400;
  color: var(--tp-grayscale700);
}
.pin.pulse {
  box-shadow: 0 0 0 3px var(--tp-white), 0 0 0 6px var(--tp-primary500);
}
.wide {
  grid-column: 1 / -1;
}
.tn-chip.ask {
  border-color: var(--tp-primary500);
  background: var(--tp-primary50);
}
.ask-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 8px;
}
.ask-row.one {
  grid-template-columns: minmax(0, 1fr);
}
.actions .btn { min-width: 0; overflow-wrap: anywhere; }
.actions svg { flex: none; }
.actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 8px;
}
</style>
