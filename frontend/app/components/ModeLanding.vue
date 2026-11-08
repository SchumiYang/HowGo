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
  features: { icon: IconName | 'simplified'; label: string }[]
}[] = [
  {
    key: 'general',
    title: '一般模式',
    subtitle: '標準多功能地圖',
    description: '適合熟悉手機操作的用戶，可使用完整地圖資訊、設施標示與導航功能。',
    icon: 'map',
    features: [{ icon: 'layers', label: '3D 室內圖資' }, { icon: 'routes', label: '多元路線' }],
  },
  {
    key: 'accessible',
    title: '友善模式',
    subtitle: '高對比・輪椅與長者友善',
    description: '適合長者、輪椅人士、視障及數位操作較不熟悉的用戶，提供高對比、大字體與更簡化的操作流程。',
    icon: 'heart',
    badge: '推薦',
    features: [{ icon: 'simplified', label: '功能簡化' }, { icon: 'navCard', label: '大字卡導航' }],
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

      <!-- UI-016: no hero icon; the title follows the language picker. -->
      <h1 class="landing-title">{{ t('歡迎使用 好行 How Go？') }}</h1>

      <div class="landing-modes" role="radiogroup" :aria-label="t('使用模式')" @keydown="onKey">
        <div v-for="mode in modes" :key="mode.key" class="landing-mode" :data-mode="mode.key" role="radio"
          :aria-checked="selected === mode.key" :tabindex="selected === mode.key ? 0 : -1"
          @click="selected = mode.key" @keydown.space.prevent="selected = mode.key"
          @keydown.enter.prevent="emit('choose', mode.key)">
          <span class="landing-mode-icon" aria-hidden="true"><AppIcon :name="mode.icon" /></span>
          <div class="landing-mode-body">
            <div class="landing-mode-head">
              <h2>{{ t(mode.title) }}</h2>
              <span v-if="mode.badge" class="landing-badge">{{ t(mode.badge) }}</span>
            </div>
            <p class="landing-mode-sub">{{ t(mode.subtitle) }}</p>
            <p class="landing-mode-desc">{{ t(mode.description) }}</p>
            <ul class="landing-features">
              <li v-for="feature in mode.features" :key="feature.label">
                <!-- public/icons/welcome/simplified-features.svg, inlined so it follows currentColor -->
                <svg v-if="feature.icon === 'simplified'" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <defs>
                    <mask id="landing-simplified-cutout" x="0" y="0" width="24" height="24" maskUnits="userSpaceOnUse">
                      <path d="M0 0h24v24H0z" fill="#fff" />
                      <circle cx="12" cy="12" r="5.5" fill="#000" />
                      <path d="m7.9 12.2 3.8 3.7 7.8-9.2" fill="none" stroke="#000" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
                    </mask>
                  </defs>
                  <polygon mask="url(#landing-simplified-cutout)" fill="currentColor" stroke="currentColor" stroke-width=".7"
                    stroke-linejoin="round" points="9.74,4.12 10.18,1.66 13.82,1.66 14.26,4.12 15.98,4.83 18.02,3.40 20.60,5.98 19.17,8.02
                    19.88,9.74 22.34,10.18 22.34,13.82 19.88,14.26 19.17,15.98 20.60,18.02 18.02,20.60 15.98,19.17
                    14.26,19.88 13.82,22.34 10.18,22.34 9.74,19.88 8.02,19.17 5.98,20.60 3.40,18.02 4.83,15.98
                    4.12,14.26 1.66,13.82 1.66,10.18 4.12,9.74 4.83,8.02 3.40,5.98 5.98,3.40 8.02,4.83" />
                  <path d="m7.9 12.2 3.8 3.7 7.8-9.2" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <AppIcon v-else :name="feature.icon" :size="18" />{{ t(feature.label) }}
              </li>
            </ul>
          </div>
          <span class="landing-radio" aria-hidden="true">
            <AppIcon v-if="selected === mode.key" name="check" :size="18" />
          </span>
        </div>
      </div>

      <div class="landing-action">
        <button type="button" class="landing-continue" :data-mode="selected" @click="emit('choose', selected)">
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
  background: var(--primary-50);
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
  background: var(--background-grey);
  color: var(--text-primary);
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
.landing-title { margin: clamp(16px, 4vh, 32px) 0 0; text-align: center; font-size: 26px; line-height: 36px; font-weight: 800; color: var(--text-primary); }

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
  gap: 14px;
  padding: clamp(12px, 2.2vh, 18px) 14px;
  border: 2px solid transparent;
  border-radius: 20px;
  background: var(--background-white);
  box-shadow: 0 1px 3px color-mix(in srgb, var(--shadow-tint) 8%, transparent);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.landing-mode:focus-visible { outline: 3px solid var(--primary-700); outline-offset: 3px; }
/*
 * UI-012: the left column holds the mode glyph as large as the column allows. The 24x24 glyph is square,
 * so it fills the column width, capped by the card height, centred, with the card gap separating it from the text.
 */
.landing-mode-icon {
  flex: none;
  align-self: stretch;
  width: clamp(48px, 15vw, 68px);
  display: grid;
  place-items: center;
  color: var(--primary-700);
}
.landing-mode-icon :deep(svg) { width: 100%; height: auto; max-height: 100%; aspect-ratio: 1; }
.landing-mode[data-mode="accessible"] .landing-mode-icon { color: var(--secondary-800); }
.landing-mode-body { flex: 1; min-width: 0; }
.landing-mode-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding-right: 34px; }
.landing-mode h2 { margin: 0; font-size: 19px; line-height: 28px; font-weight: 800; color: var(--text-primary); }
.landing-badge { padding: 1px 10px; border-radius: 999px; background: var(--secondary-500); color: var(--secondary-900); font-size: 13px; line-height: 22px; font-weight: 800; }
.landing-mode-sub { margin: 2px 0 0; font-size: 15px; font-weight: 700; color: var(--primary-700); }
.landing-mode[data-mode="accessible"] .landing-mode-sub { color: var(--secondary-800); }
.landing-mode-desc { margin: 8px 0 0; font-size: 0.875rem; line-height: 1.6; color: var(--text-primary); }
.landing-features { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.landing-features li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--grey-50);
  font-size: 13.5px;
  line-height: 22px;
  color: var(--text-primary);
}
.landing-features :deep(svg) { flex: none; color: var(--primary-700); }
.landing-mode[data-mode="accessible"] .landing-features :deep(svg) { color: var(--secondary-700); }
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
  color: var(--white);
}

/* UI-001 v2「模式選擇頁配色」: selected 一般模式 card. */
.landing-mode[data-mode="general"][aria-checked="true"] { border-color: var(--primary-700); background: var(--primary-700); box-shadow: none; }
.landing-mode[data-mode="general"][aria-checked="true"] :is(h2, .landing-mode-sub, .landing-mode-desc, .landing-mode-icon) { color: var(--white-50); }
.landing-mode[data-mode="general"][aria-checked="true"] .landing-features li { background: var(--primary-50); color: var(--primary-800); }
.landing-mode[data-mode="general"][aria-checked="true"] .landing-features :deep(svg) { color: var(--primary-800); }
.landing-mode[data-mode="general"][aria-checked="true"] .landing-radio { background: var(--white-50); color: var(--primary-700); }
/* Selected 友善模式 card. */
.landing-mode[data-mode="accessible"][aria-checked="true"] { border-color: var(--secondary-500); background: var(--secondary-500); box-shadow: none; }
.landing-mode[data-mode="accessible"][aria-checked="true"] :is(h2, .landing-mode-sub, .landing-mode-desc, .landing-mode-icon) { color: var(--grey-950); }
.landing-mode[data-mode="accessible"][aria-checked="true"] .landing-features li { background: var(--secondary-50); color: var(--secondary-800); }
.landing-mode[data-mode="accessible"][aria-checked="true"] .landing-features :deep(svg) { color: var(--secondary-800); }
.landing-mode[data-mode="accessible"][aria-checked="true"] .landing-radio { background: var(--secondary-800); color: var(--white-50); }
/* The 推薦 badge would vanish on the yellow card; invert it to the checkmark colours. */
.landing-mode[data-mode="accessible"][aria-checked="true"] .landing-badge { background: var(--secondary-800); color: var(--white-50); }

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
  background: var(--primary-500);
  color: var(--primary-950);
  font-size: 19px;
  font-weight: 800;
  box-shadow: var(--shadow-floating);
}
/* UI-012: the button follows the selected mode (UI-001 v2「模式選擇頁配色」). */
.landing-continue:hover, .landing-continue:active { background: var(--primary-400); }
.landing-continue[data-mode="accessible"] { background: var(--secondary-500); color: var(--grey-950); }
.landing-continue[data-mode="accessible"]:hover, .landing-continue[data-mode="accessible"]:active { background: var(--secondary-400); }
.landing-continue:focus-visible { outline: 3px solid var(--primary-800); outline-offset: 3px; }
@media (max-width: 360px) {
  .landing-inner { padding-inline: 14px; }
  .landing-mode { gap: 10px; padding-inline: 10px; }
  .landing-mode-icon { width: 44px; }
  .landing-radio { right: 12px; }
}

/* Keep the action visible while the mode list scrolls on short screens. */
@media (max-height: 700px) {
  .landing-title { font-size: 23px; line-height: 32px; }
  .landing-mode-desc { margin-top: 6px; }
  .landing-features { margin-top: 8px; }
  .landing-continue { min-height: 52px; }
}
@media (max-height: 600px) {
  .landing-lang { min-height: 38px; }
  .landing-mode-desc { display: none; }
}
</style>
