<script setup lang="ts">
/**
 * Embeddable indoor navigation (used by the HowGo Nuxt app's IndoorOverlay). All styles are scoped
 * under .tpnav (embed.css) and pick up the host's tokens; data comes from `dataBase` (default: the
 * FastAPI indoor endpoint behind the host's /api proxy).
 */
import App from './App.vue'
import { DEFAULT_DATA_BASE, setDataBase } from './data/loader'
import './embed.css'

const props = defineProps<{
  venue: string
  /** default '/api/v1/indoor/data/' (FastAPI GET /v1/indoor/data/{venue}/{path}) */
  dataBase?: string
  initialLevel?: string
  /** quick action (accessibleToilet | toilet | elevator) or a place id / ref / name */
  destination?: string
}>()
const emit = defineEmits<{ close: [] }>()

// before App mounts and starts loading
setDataBase(props.dataBase ?? DEFAULT_DATA_BASE)
</script>

<template>
  <div class="tpnav">
    <App :venue="venue" :initial-level="initialLevel" :destination="destination" embedded @close="emit('close')" />
  </div>
</template>
