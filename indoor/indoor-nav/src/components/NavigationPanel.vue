<script setup lang="ts">
import { t } from '../i18n'
import { computed, ref } from 'vue'
import type { Step } from '../routing/instructions'
import StepIcon from './StepIcon.vue'

const props = defineProps<{
  destLabel?: string
  summary: { meters: number; minutes: number; levels: string[] }
  steps: Step[]
  activeStep: number
  levelName: (id: string) => string
  /** live positioning status (null = off) */
  live?: { label: string; low: boolean } | null
  liveStarting?: boolean
  /** the current step's text with the live distance (「直走 12 公尺後右轉」); null = static text */
  liveText?: string | null
  /** live metres left to the destination; null = show the route total */
  remainingM?: number | null
}>()
const emit = defineEmits<{ step: [number]; end: []; reroute: []; live: [] }>()
/** 隨行方向 (course-up): the map turns so the current leg points up */
const courseUp = defineModel<boolean>('courseUp', { default: false })

const showList = ref(false)
const current = computed(() => props.steps[props.activeStep])
const arrived = computed(() => current.value?.kind === 'arrive')
const isLast = computed(() => props.activeStep >= props.steps.length - 1)
/** full sentence for screen readers: "第 2 步，共 6 步。直走 20 公尺後右轉。1F" */
const spoken = (s: Step, i: number) => t('第 {0} 步，共 {1} 步。{2}。{3}', i + 1, props.steps.length, s.text, props.levelName(s.level))
const nextLabel = computed(() => {
  const n = props.steps[props.activeStep + 1]
  if (!n) return t('下一步')
  if (current.value?.kind === 'elevator' || current.value?.kind === 'stairs') return t('已到 {0}', props.levelName(current.value.toLevel!))
  return t('下一步')
})
</script>

<template>
  <section class="nav" :aria-label="t('導航中')">
    <!-- next-step card; only the hidden sentence is live, so TalkBack / VoiceOver announce each new
         step but not every metre of the live distance -->
    <div class="next" :class="{ arrived }">
      <span class="visually-hidden" aria-live="polite" aria-atomic="true">{{ current ? spoken(current, activeStep) : '' }}</span>
      <div class="ic" aria-hidden="true"><StepIcon v-if="current" :step="current" :size="40" /></div>
      <div class="body" aria-hidden="true">
        <div class="txt">{{ liveText ?? current?.text }}</div>
        <div class="sub">
          {{ t('{0} · 第 {1} / {2} 步', current ? levelName(current.level) : '', activeStep + 1, steps.length) }}
          <template v-if="!arrived && remainingM != null"> {{ t('· 剩 {0} 公尺', Math.max(1, Math.round(remainingM))) }}</template>
          <template v-else-if="!arrived"> {{ t('· 全程 {0} 公尺', summary.meters) }}</template>
        </div>
      </div>
    </div>

    <div class="live" :class="{ low: live?.low }">
      <template v-if="live">
        <span class="live-dot" aria-hidden="true"></span>
        <span class="live-txt">{{ t(live.label) }}<span v-if="live.low" class="live-sub">{{ t('定位精度較低') }}</span></span>
        <button class="btn text small" @click="emit('reroute')">{{ t('重新規劃') }}</button>
      </template>
      <template v-else>
        <span class="live-txt">{{ t('手動切換步驟') }}</span>
        <button class="btn text small" :disabled="liveStarting" @click="emit('live')">{{ liveStarting ? t('啟動中…') : t('開啟即時定位') }}</button>
      </template>
    </div>

    <div class="ctrl">
      <button class="btn" :disabled="activeStep <= 0" @click="emit('step', activeStep - 1)">{{ t('上一步') }}</button>
      <button v-if="!isLast" class="btn primary" @click="emit('step', activeStep + 1)">{{ nextLabel }}</button>
      <button v-else class="btn primary" @click="emit('end')">{{ t('完成') }}</button>
    </div>

    <button class="course" :aria-pressed="courseUp" @click="courseUp = !courseUp">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3l6 16-6-4-6 4z" :fill="courseUp ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg>
      {{ t('隨行方向：{0}', courseUp ? '開' : '關') }}
    </button>

    <button class="list-toggle" :aria-expanded="showList" aria-controls="step-list" @click="showList = !showList">
      {{ showList ? t('收合路線步驟') : t('查看全部 {0} 個步驟', steps.length) }}
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" :class="{ flip: showList }"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    <ol v-if="showList" id="step-list" class="steps">
      <li v-for="(s, i) in steps" :key="i">
        <button class="step" :class="{ on: i === activeStep }" :aria-current="i === activeStep ? 'step' : undefined" :aria-label="spoken(s, i)" @click="emit('step', i)">
          <span class="sic" aria-hidden="true"><StepIcon :step="s" :size="28" /></span>
          <span class="stxt" aria-hidden="true">{{ s.text }}</span>
          <span class="slv" aria-hidden="true">{{ levelName(s.level) }}</span>
        </button>
      </li>
    </ol>

    <button class="btn text tn-end" @click="emit('end')">{{ t('結束導航') }}</button>
  </section>
</template>

<style scoped>
.next {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  border-radius: var(--tpnav-radius-small);
  background: var(--tp-primary700);
  color: var(--tp-white);
}
.next.arrived {
  background: var(--tp-primary600);
}
.ic {
  flex: none;
  width: 56px;
  height: 56px;
  border-radius: var(--tpnav-radius-control);
  background: rgba(255, 255, 255, 0.16);
  display: grid;
  place-items: center;
}
.body {
  flex: 1;
  min-width: 0;
}
.txt {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.35;
}
.sub {
  font-size: 14px;
  opacity: 0.92;
}
.live {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  margin-top: 6px;
}
.live-dot {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--tp-primary700);
  box-shadow: 0 0 0 4px var(--tp-primary100);
}
.live.low .live-dot {
  background: var(--tp-grayscale500);
  box-shadow: 0 0 0 4px var(--tp-grayscale100);
}
.live-txt {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
}
.live.low .live-txt {
  color: var(--tp-grayscale700);
}
.live-sub {
  display: block;
  font-weight: 400;
}
.small {
  min-height: 48px;
  padding: 8px 12px;
  font-size: 14px;
}
.ctrl {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: 8px;
  margin-top: 4px;
}
.course {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  min-height: 48px;
  margin-top: 8px;
  border: 1px solid var(--tp-grayscale200);
  border-radius: var(--tpnav-radius-control);
  background: var(--tp-white);
  color: var(--tp-grayscale900);
  font-weight: 600;
}
.course[aria-pressed='true'] {
  border-color: var(--tp-primary700);
  background: var(--tp-primary50);
  color: var(--tp-primary700);
}
.list-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 48px;
  margin-top: 4px;
  border: 0;
  background: transparent;
  color: var(--tp-primary700);
  font-weight: 600;
}
.flip {
  transform: rotate(180deg);
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 30vh;
  overflow-y: auto;
  border-top: 1px solid var(--tp-grayscale100);
}
.step {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 52px;
  padding: 6px 4px;
  border: 0;
  border-bottom: 1px solid var(--tp-grayscale100);
  background: transparent;
  text-align: left;
  color: var(--tp-grayscale900);
}
.step.on {
  background: var(--tp-primary50);
}
.sic {
  color: var(--tp-primary700);
  display: grid;
}
.stxt {
  flex: 1;
}
.slv {
  font-size: 14px;
  color: var(--tp-grayscale700);
}
.tn-end {
  width: 100%;
  margin-top: 4px;
  color: var(--tp-red600);
}
</style>
