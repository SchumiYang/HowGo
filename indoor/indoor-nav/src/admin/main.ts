// fakeBridge must run before anything touches the bridge (?fake=1 only)
import '../survey/fakeBridge'
import { createApp } from 'vue'
import '../style.css'
import AdminApp from './AdminApp.vue'

createApp(AdminApp).mount('#app')
