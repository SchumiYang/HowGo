<script setup lang="ts">
import type { Place } from '~/composables/usePlaceSearch'

const props = defineProps<{ target: 'start' | 'end'; locating: boolean; mapReady: boolean; message: string }>()
const emit = defineEmits<{ back: []; choose: [place: Place]; useLocation: []; pickOnMap: [] }>()

const label = computed(() => props.target === 'start' ? '起點' : '終點')
const { query, results, status } = usePlaceSearch()
const { recent, remember, clear } = useRecentPlaces()
const input = useTemplateRef<HTMLInputElement>('input')
const suggestions = ['捷運士林站', '天母運動公園', '臺北車站']

function choose(place: Place) {
  remember(place)
  input.value?.blur()
  emit('choose', place)
}

onMounted(() => input.value?.focus())
</script>

<template>
  <section class="location-search" :aria-label="`選擇${label}`">
    <header class="search-header">
      <button type="button" class="icon-button" aria-label="返回路線預覽" @click="emit('back')">
        <AppIcon name="back" />
      </button>
      <form class="search-field" role="search" @submit.prevent="results[0] && choose(results[0])">
        <span class="endpoint-tag" :data-target="target">{{ label }}</span>
        <input ref="input" v-model="query" type="search" enterkeyhint="search" maxlength="80" autocomplete="off"
          :aria-label="`搜尋${label}`" placeholder="輸入地址、地點或建築名稱"
          @keydown.esc.prevent="query ? query = '' : emit('back')">
        <AppIcon name="search" class="search-field-icon" />
      </form>
    </header>

    <div class="search-body">
      <div class="quick-list">
        <button type="button" class="quick-row" :disabled="locating" @click="emit('useLocation')">
          <span class="quick-icon"><AppIcon name="locate" /></span>
          <span class="quick-text">
            <strong>{{ locating ? '定位中…' : '你的位置' }}</strong>
            <small>取得目前 GPS 位置</small>
          </span>
          <AppIcon name="chevron" class="quick-chevron" />
        </button>
        <button type="button" class="quick-row" :disabled="!mapReady" @click="emit('pickOnMap')">
          <span class="quick-icon"><AppIcon name="pin" /></span>
          <span class="quick-text">
            <strong>在地圖上選擇</strong>
            <small>拖曳地圖選取點位</small>
          </span>
          <AppIcon name="chevron" class="quick-chevron" />
        </button>
      </div>
      <p v-if="message" class="notice" role="status">{{ message }}</p>

      <template v-if="query.trim().length >= 2">
        <p v-if="status" class="hint search-status" role="status">{{ status }}</p>
        <ul v-if="results.length" class="place-list" aria-label="搜尋結果">
          <li v-for="(place, index) in results" :key="index">
            <button type="button" @click="choose(place)">
              <AppIcon name="pin" class="place-list-icon" />
              <span>
                <strong>{{ place.name }}</strong>
                <small v-if="place.address">{{ place.address }}</small>
                <small v-else-if="place.is_road">道路參考點</small>
              </span>
            </button>
          </li>
        </ul>
      </template>

      <template v-else>
        <div class="section-heading">
          <h2><AppIcon name="history" :size="18" />最近搜尋紀錄</h2>
          <button v-if="recent.length" type="button" class="text-button" @click="clear">清除紀錄</button>
        </div>
        <ul v-if="recent.length" class="place-list" aria-label="最近搜尋紀錄">
          <li v-for="place in recent" :key="place.name">
            <button type="button" @click="choose(place)">
              <AppIcon name="history" class="place-list-icon" />
              <span>
                <strong>{{ place.name }}</strong>
                <small v-if="place.address">{{ place.address }}</small>
              </span>
            </button>
          </li>
        </ul>
        <div v-else class="empty-card">
          <span class="empty-icon"><AppIcon name="navigation" /></span>
          <h3>快速出發</h3>
          <p>可輸入捷運站出入口、公車站或地標名稱。</p>
          <div class="suggestion-chips">
            <button v-for="name in suggestions" :key="name" type="button" class="chip" @click="query = name">{{ name }}</button>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>
