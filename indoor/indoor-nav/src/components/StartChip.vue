<script setup lang="ts">
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
      <span class="pin" :class="{ unset: (!start && !live) || locate?.kind === 'fallback', pulse: (live && !live.low) || locate?.kind === 'locating' }" aria-hidden="true"></span>
      <!-- automatic start position (CityGeni-style: show the estimate honestly, make correcting easy) -->
      <span v-if="locate?.kind === 'locating'" class="lbl" role="status">正在定位你的位置…</span>
      <span v-else-if="locate?.kind === 'estimate'" class="lbl wrap" role="status">目前位置：{{ locate.place }}（±{{ locate.acc }} 公尺）· 正確嗎？</span>
      <span v-else-if="locate?.kind === 'fallback'" class="lbl wrap" role="status">
        請點地圖標出你的位置
        <span class="sub">目前以{{ locate.fallbackLabel }}為起點</span>
      </span>
      <span v-else-if="live" class="lbl">
        {{ live.label }}
        <span v-if="live.low" class="sub">定位精度較低</span>
      </span>
      <span v-else class="lbl">
        <template v-if="start">起點：{{ start.label }}</template>
        <template v-else>尚未設定起點</template>
      </span>
      <span v-if="locate?.kind === 'fallback'" class="src">未定位</span>
      <template v-else-if="!locate">
        <span v-if="live" class="src">即時</span>
        <span v-else-if="start" class="src">{{ SOURCE_LABEL[start.source] }}</span>
      </template>
      <span class="more">{{ open ? '收合' : '更改' }}</span>
    </button>
    <div v-if="locate?.kind === 'estimate'" class="ask-row">
      <button class="btn primary" @click="emit('confirm')">是</button>
      <button class="btn" @click="emit('correct')">點地圖修正</button>
    </div>
    <div v-else-if="locate?.kind === 'fallback'" class="ask-row one">
      <button class="btn primary" @click="emit('correct')">點地圖標示位置</button>
    </div>
    <div v-if="open" id="start-actions" class="actions">
      <button class="btn" @click="act('pick')">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" fill="none" stroke="currentColor" stroke-width="2" /><circle cx="12" cy="10" r="2.2" fill="currentColor" /></svg>
        點地圖設定
      </button>
      <button class="btn" :disabled="scanning" @click="act('scan')">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M7 12h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        {{ scanning ? '掃描中…' : '掃描定位碼' }}
      </button>
      <button class="btn wide" :class="{ primary: !!live }" :aria-pressed="!!live" :disabled="liveStarting" @click="act('live')">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="currentColor" /><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" /></svg>
        即時定位：{{ liveStarting ? '啟動中…' : live ? '開' : '關' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tn-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 48px;
  padding: 8px 12px;
  border: 1px solid var(--tp-grayscale200);
  border-radius: var(--tpnav-radius-control);
  background: var(--tp-grayscale50);
  text-align: left;
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
  flex: 1;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  flex: none;
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
.lbl.wrap {
  white-space: normal;
}
.ask-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 8px;
}
.ask-row.one {
  grid-template-columns: 1fr;
}
.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 8px;
}
</style>
