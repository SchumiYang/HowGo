export type Coordinate = [number, number]
export type Place = { name: string; address: string; coordinates: Coordinate; is_road: boolean }

/** Debounced place search against /api/v1/places. */
export function usePlaceSearch() {
  const query = ref('')
  const results = shallowRef<Place[]>([])
  const status = ref('')

  watch(query, (value, _, onCleanup) => {
    const text = value.trim()
    results.value = []
    status.value = ''
    if (text.length < 2) return
    const request = new AbortController()
    status.value = '搜尋中…'
    const timer = setTimeout(async () => {
      try {
        const data = await $fetch<{ results: Place[] }>('/api/v1/places', {
          query: { q: text }, signal: request.signal,
        })
        if (request.signal.aborted) return
        results.value = data.results
        status.value = data.results.length ? '' : '找不到符合的地點，可改用路名或在地圖上選擇。'
      } catch {
        if (!request.signal.aborted) status.value = '搜尋暫時無法使用，可改在地圖上選擇。'
      }
    }, 300)
    onCleanup(() => {
      clearTimeout(timer)
      request.abort()
    })
  })

  return { query, results, status }
}

const RECENT_KEY = 'howgo-recent-places'

/** Recent picks, kept per browser. Storage failures fall back to an in-memory list. */
export function useRecentPlaces() {
  const recent = useState<Place[]>('recent-places', () => {
    try {
      const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
      return Array.isArray(saved) ? saved.slice(0, 6) : []
    } catch {
      return []
    }
  })

  function persist() {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value))
    } catch {}
  }

  function remember(place: Place) {
    recent.value = [place, ...recent.value.filter(item => item.name !== place.name)].slice(0, 6)
    persist()
  }

  function clear() {
    recent.value = []
    persist()
  }

  return { recent, remember, clear }
}

/** Web Speech API voice input; reports honestly when unsupported. */
export function useVoiceInput(onText: (text: string) => void) {
  const listening = ref(false)
  const message = ref('')

  function start() {
    const Recognition = (window as unknown as Record<string, unknown>).SpeechRecognition
      ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition
    if (typeof Recognition !== 'function') {
      message.value = '此裝置暫不支援語音搜尋，請改用鍵盤輸入。'
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition = new (Recognition as any)()
    recognition.lang = 'zh-TW'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    message.value = ''
    listening.value = true
    recognition.onresult = (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      const text = event.results[0]?.[0]?.transcript?.trim()
      if (text) onText(text)
    }
    recognition.onerror = (event: { error: string }) => {
      message.value = event.error === 'not-allowed' ? '尚未允許使用麥克風。' : '沒有辨識到語音，請再試一次。'
    }
    recognition.onend = () => { listening.value = false }
    recognition.start()
  }

  return { listening, message, start }
}
