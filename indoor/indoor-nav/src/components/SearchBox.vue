<script setup lang="ts">
import { t } from '../i18n'
import { computed } from 'vue'
import { CATEGORY_LABEL, searchCatalog, type PlaceEntry } from '../data/catalog'

const props = defineProps<{ catalog: PlaceEntry[]; levelName: (id: string) => string }>()
const emit = defineEmits<{ select: [PlaceEntry] }>()
/** the query is a model so the parent can collapse other content while searching */
const query = defineModel<string>({ default: '' })

const results = computed(() => searchCatalog(props.catalog, query.value))
const active = computed(() => query.value.trim().length > 0)

function choose(p: PlaceEntry) {
  emit('select', p)
  query.value = ''
  ;(document.activeElement as HTMLElement | null)?.blur()
}
</script>

<template>
  <div class="search" role="search">
    <label class="box">
      <span class="visually-hidden">{{ t('搜尋地點') }}</span>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M10.5 4a6.5 6.5 0 0 1 5.2 10.4l4.4 4.4-1.4 1.4-4.4-4.4A6.5 6.5 0 1 1 10.5 4zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z" fill="currentColor" /></svg>
      <input
        v-model="query"
        type="search"
        enterkeyhint="search"
        :placeholder="t('搜尋教室編號（如 A101）、設施')"
        autocomplete="off"
        @keydown.enter="results[0] && choose(results[0])"
      />
      <button v-if="query" class="clear" :aria-label="t('清除搜尋')" @click="query = ''">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" /></svg>
      </button>
    </label>
    <template v-if="active">
      <p class="visually-hidden" role="status">{{ results.length ? t('找到 {0} 個結果', results.length) : t('沒有結果') }}</p>
      <ul v-if="results.length" class="results">
        <li v-for="p in results" :key="p.key">
          <button class="item" @click="choose(p)">
            <span class="name">{{ p.ref && !p.name.includes(p.ref) ? `${p.ref} ${p.name}` : p.name }}</span>
            <span class="meta">{{ t(CATEGORY_LABEL[p.category] ?? p.category) }} · {{ levelName(p.level) }}</span>
          </button>
        </li>
      </ul>
      <p v-else class="empty">{{ t('找不到「{0}」', query) }}</p>
    </template>
  </div>
</template>

<style scoped>
.box {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 0 4px 0 12px;
  border: 1px solid var(--tp-grayscale200);
  border-radius: var(--tpnav-radius-control);
  background: var(--tp-white);
  color: var(--tp-grayscale700);
}
.box:focus-within {
  border-color: var(--tp-primary700);
  box-shadow: 0 0 0 2px var(--tp-primary200);
}
input {
  flex: 1;
  min-width: 0;
  min-height: 46px;
  border: 0;
  outline: 0;
  font-size: 16px; /* >= 16px avoids iOS zoom-on-focus */
  color: var(--tp-grayscale900);
  background: transparent;
}
input::placeholder {
  color: var(--tp-grayscale700);
}
input::-webkit-search-cancel-button {
  display: none;
}
.clear {
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: var(--tpnav-radius-control);
  background: transparent;
  display: grid;
  place-items: center;
}
.results {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  min-height: 56px;
  padding: 8px 4px;
  border: 0;
  border-bottom: 1px solid var(--tp-grayscale100);
  background: transparent;
  text-align: left;
}
.item:active {
  background: var(--tp-primary50);
}
.name {
  font-weight: 600;
}
.meta {
  font-size: 14px;
  color: var(--tp-grayscale700);
}
.empty {
  margin: 12px 4px 0;
  color: var(--tp-grayscale700);
}
</style>
