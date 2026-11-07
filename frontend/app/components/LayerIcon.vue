<script setup lang="ts">
import { layerIconUrl, type LayerIconName } from '../utils/mapLayerIcons'

/** UI-004 category badge (the same SVG the map markers use). Decorative unless `label` is given. */
const props = withDefaults(defineProps<{ name: LayerIconName; size?: number; label?: string }>(), { size: 16 })
const app = useRuntimeConfig().app
const src = computed(() => layerIconUrl(props.name, app.cdnURL || app.baseURL))
</script>

<template>
  <img class="layer-icon" :src="src" :width="size" :height="size" :alt="label ?? ''" :aria-hidden="label ? undefined : 'true'"
    draggable="false">
</template>

<style scoped>
.layer-icon { display: block; flex: none; object-fit: contain; }
</style>
