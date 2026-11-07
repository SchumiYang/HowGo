<script setup lang="ts">
import { locale, setLocale, t } from '~/i18n'
/** Landing page (uiux_disable_v1/messageImage_1794069269376.jpg): pick 一般模式 or 友善模式 before entering. */
import type { IconName } from './AppIcon.vue'

export type AppMode = 'general' | 'accessible'

const props = defineProps<{ initial: AppMode }>()
const emit = defineEmits<{ choose: [mode: AppMode] }>()

const selected = ref<AppMode>(props.initial)

const modes: {
  key: AppMode
  title: string
  subtitle: string
  description: string
  icon: IconName
  badge?: string
  features: { icon: IconName; label: string }[]
}[] = [
  {
    key: 'general',
    title: '一般模式',
    subtitle: '標準多功能地圖',
    description: '適合熟悉手機操作的使用者，可使用完整地圖資訊、設施標示與導航功能。',
    icon: 'map',
    features: [{ icon: 'layers', label: '3D 室內圖資' }, { icon: 'navigation', label: '即時轉彎引導' }],
  },
  {
    key: 'accessible',
    title: '友善模式',
    subtitle: '高對比・輪椅與長者友善',
    description: '適合長者、輪椅使用者、視障及聽障者與數位操作較不熟悉的使用者，提供高對比、大字體與更簡化的操作流程。',
    icon: 'heart',
    badge: '推薦',
    features: [{ icon: 'textSize', label: '放大字體按鍵' }, { icon: 'elevator', label: '電梯優先規劃' }],
  },
]

/** Arrow keys move the selection inside the radio group, as native radios do. */
function onKey(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  const index = modes.findIndex(mode => mode.key === selected.value)
  const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
  selected.value = modes[(index + step + modes.length) % modes.length]!.key
  nextTick(() => (document.querySelector('.landing-mode[aria-checked="true"]') as HTMLElement | null)?.focus())
}
</script>

<template>
  <div class="landing">
    <div class="landing-inner">
      <label class="landing-lang">
        <AppIcon name="globe" :size="22" aria-hidden="true" />
        <select :value="locale" :aria-label="t('語言')"
          @change="setLocale(($event.target as HTMLSelectElement).value === 'en' ? 'en' : 'zh-Hant')">
          <option value="zh-Hant" lang="zh-Hant">繁體中文</option>
          <option value="en" lang="en">English</option>
        </select>
      </label>

      <div class="landing-hero" aria-hidden="true"><AppIcon name="accessible" :size="28" /></div>
      <h1 class="landing-title">{{ t('歡迎使用無障礙導航') }}</h1>

      <div class="landing-modes" role="radiogroup" :aria-label="t('使用模式')" @keydown="onKey">
        <div v-for="mode in modes" :key="mode.key" class="landing-mode" :data-mode="mode.key" role="radio"
          :aria-checked="selected === mode.key" :tabindex="selected === mode.key ? 0 : -1"
          @click="selected = mode.key" @keydown.space.prevent="selected = mode.key"
          @keydown.enter.prevent="emit('choose', mode.key)">
          <span class="landing-mode-icon" aria-hidden="true"><AppIcon :name="mode.icon" :size="19" /></span>
          <div class="landing-mode-body">
            <div class="landing-mode-head">
              <h2>{{ t(mode.title) }}</h2>
              <span v-if="mode.badge" class="landing-badge">{{ t(mode.badge) }}</span>
            </div>
            <p class="landing-mode-sub">{{ t(mode.subtitle) }}</p>
            <p class="landing-mode-desc">{{ t(mode.description) }}</p>
            <ul class="landing-features">
              <li v-for="feature in mode.features" :key="feature.label">
                <AppIcon :name="feature.icon" :size="18" />{{ t(feature.label) }}
              </li>
            </ul>
          </div>
          <span class="landing-radio" aria-hidden="true">
            <AppIcon v-if="selected === mode.key" name="check" :size="18" />
          </span>
        </div>
      </div>

      <div class="landing-action">
        <button type="button" class="landing-continue" @click="emit('choose', selected)">
          {{ t('繼續') }}<AppIcon name="arrowRight" :size="24" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.landing {
  position: fixed;
  inset: 0;
  z-index: 60;
  /* Keep controls reachable when longer translations wrap on small screens. */
  height: 100vh;
  height: 100dvh;
  overflow-y: auto;
  background: #F6FAFB;
  color: var(--text-primary);
  font-synthesis: weight;
}
.landing-inner {
  max-width: 480px;
  margin: 0 auto;
  height: 100%;
  padding: calc(var(--safe-top) + clamp(8px, 2vh, 16px)) 20px 0;
  display: flex;
  flex-direction: column;
}
.landing-lang {
  flex: none;
  align-self: flex-end;
  min-height: 44px;
  padding: 0 18px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border-radius: 999px;
  background: var(--grey-100);
  color: var(--grey-800);
  font-size: 16px;
  font-weight: 700;
}
.landing-lang select {
  min-height: 44px;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.landing-lang :deep(svg) { color: var(--primary-700); }
.landing-hero {
  align-self: center;
  width: 52px;
  height: 52px;
  margin-top: clamp(4px, 2vh, 16px);
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--primary-50);
  color: var(--primary-700);
}
.landing-title { margin: clamp(8px, 2vh, 16px) 0 0; text-align: center; font-size: 26px; line-height: 36px; font-weight: 800; color: #1B2124; }

.landing-modes {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: clamp(10px, 1.8vh, 16px);
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  margin-top: clamp(14px, 4vh, 32px);
  padding: 3px;
}
.landing-mode {
  position: relative;
  display: flex;
  gap: 12px;
  padding: clamp(12px, 2.2vh, 18px) 14px;
  border: 2px solid transparent;
  border-radius: 20px;
  background: #fff;
  box-shadow: 0 1px 3px #22474E14;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.landing-mode[aria-checked="true"] { border-color: var(--primary-500); background: var(--primary-50); box-shadow: none; }
.landing-mode:focus-visible { outline: 3px solid var(--primary-700); outline-offset: 3px; }
/* Mode icon at 80% of the mock size. */
.landing-mode-icon {
  flex: none;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--primary-100);
  color: var(--primary-700);
}
.landing-mode[data-mode="accessible"] .landing-mode-icon { background: var(--secondary-50); color: var(--secondary-800); box-shadow: inset 0 0 0 1px var(--secondary-200); }
.landing-mode-body { flex: 1; min-width: 0; }
.landing-mode-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding-right: 34px; }
.landing-mode h2 { margin: 0; font-size: 19px; line-height: 28px; font-weight: 800; color: #1B2124; }
.landing-badge { padding: 1px 10px; border-radius: 999px; background: var(--secondary-500); color: #3D2A05; font-size: 13px; line-height: 22px; font-weight: 800; }
.landing-mode-sub { margin: 2px 0 0; font-size: 15px; font-weight: 700; color: var(--primary-700); }
.landing-mode[data-mode="accessible"] .landing-mode-sub { color: var(--secondary-800); }
.landing-mode-desc { margin: 10px 0 0; font-size: 16px; line-height: 26px; color: var(--grey-800); }
.landing-features { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.landing-features li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: #fff;
  font-size: 13.5px;
  line-height: 22px;
  color: var(--grey-800);
}
.landing-mode:not([aria-checked="true"]) .landing-features li { background: var(--grey-50); }
.landing-features :deep(svg) { flex: none; color: var(--primary-700); }
.landing-mode[data-mode="accessible"] .landing-features :deep(svg) { flex: none; color: var(--secondary-700); }
.landing-radio {
  position: absolute;
  top: 18px;
  right: 16px;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--grey-100);
  color: #fff;
}
.landing-mode[aria-checked="true"] .landing-radio { background: var(--primary-700); }

.landing-action {
  flex: none;
  margin-top: auto;
  padding: clamp(12px, 2vh, 20px) 0 calc(var(--safe-bottom) + clamp(12px, 3vh, 28px));
}
.landing-continue {
  width: 100%;
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 0;
  border-radius: 16px;
  background: var(--action);
  color: #fff;
  font-size: 19px;
  font-weight: 800;
  box-shadow: var(--shadow-floating);
}
.landing-continue:active { background: var(--action-hover); }
.landing-continue:focus-visible { outline: 3px solid var(--primary-800); outline-offset: 3px; }
@media (max-width: 360px) {
  .landing-inner { padding-inline: 14px; }
  .landing-mode { gap: 8px; padding-inline: 10px; }
  .landing-mode-icon { width: 32px; height: 32px; }
  .landing-radio { right: 12px; }
}

/* Keep the action visible while the mode list scrolls on short screens. */
@media (max-height: 700px) {
  .landing-hero { width: 44px; height: 44px; }
  .landing-title { font-size: 23px; line-height: 32px; }
  .landing-mode-desc { margin-top: 6px; font-size: 15px; line-height: 23px; }
  .landing-features { margin-top: 8px; }
  .landing-continue { min-height: 52px; }
}
@media (max-height: 600px) {
  .landing-hero { display: none; }
  .landing-lang { min-height: 38px; }
  .landing-mode-desc { display: none; }
}
</style>
