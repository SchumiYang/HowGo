import { readonly, ref } from 'vue'
import { english } from './messages.en'

export type Locale = 'zh-Hant' | 'en'
const storageKey = 'howgo-locale'

function savedLocale(): Locale {
  try {
    return globalThis.localStorage?.getItem(storageKey) === 'en' ? 'en' : 'zh-Hant'
  } catch {
    return 'zh-Hant'
  }
}

const selected = ref<Locale>(savedLocale())
export const locale = readonly(selected)

export function setLocale(value: Locale) {
  selected.value = value
  if (typeof document !== 'undefined') document.documentElement.lang = value
  try {
    globalThis.localStorage?.setItem(storageKey, value)
  } catch {
    // Private or embedded browsers may disable storage.
  }
}

// Traditional Chinese messages are also the fallback for untranslated source data.
export function t(message: string, ...values: unknown[]): string {
  const text = locale.value === 'en' && Object.hasOwn(english, message) ? english[message]! : message
  return text.replace(/\{(\d+)\}/g, (token, index: string) =>
    Number(index) < values.length ? String(values[Number(index)] ?? '') : token,
  )
}
