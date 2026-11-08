// Entry of the embedded indoor navigation (indoor/indoor-nav/src/IndoorNav.vue, aliased in
// nuxt.config.ts). Typed here so `nuxt typecheck` doesn't check the indoor sources themselves.
declare module '#indoor/IndoorNav.vue' {
  import type { DefineComponent } from 'vue'
  const IndoorNav: DefineComponent<
    { venue: string; dataBase?: string; initialLevel?: string; destination?: string },
    object,
    object,
    object,
    object,
    object,
    object,
    { close: () => void }
  >
  export default IndoorNav
}
