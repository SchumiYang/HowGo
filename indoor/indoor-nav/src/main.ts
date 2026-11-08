import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { setDataBase } from './data/loader'

// data defaults to the FastAPI indoor endpoint (/api/v1/indoor/data/); ?data=./data/ uses local static files
const dataParam = new URLSearchParams(location.search).get('data')
if (dataParam) setDataBase(dataParam)

// dev-only: replay a survey walk through a fake TownPass bridge (?replay=...); split out of the main bundle
if (new URLSearchParams(location.search).has('replay')) await (await import('./dev/replayBridge')).installReplayBridge()

createApp(App).mount('#app')
