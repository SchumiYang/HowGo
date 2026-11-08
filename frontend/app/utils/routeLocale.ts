import { locale, t } from '~/i18n'

const coverage = '部分路段|全段|前約 \\d+ 公尺|約第 \\d+–\\d+ 公尺'
const side = '左側|右側'
const walkway = '實體人行道|有整平紀錄的騎樓|標線型人行道'

// The route API sends Chinese sentences. Localize its known forms at display
// time and retain the original when the service introduces an unfamiliar form.
export function localizeRouteText(text: string): string {
  if (locale.value !== 'en' || !text) return text
  const direct = t(text)
  if (direct !== text) return direct

  const road = /^(.*?)，沿(.+)前進$/.exec(text)
  if (road) return t('{0}，沿{1}前進', t(road[1]!), road[2]!)
  const alongRoad = /^沿(.+)前進$/.exec(text)
  if (alongRoad) return t('沿{0}前進', alongRoad[1]!)
  if (text.startsWith('通過後')) return t('通過後{0}', localizeRouteText(text.slice(3)))

  const ramp = /^(.*?)，(起段附近有坡道紀錄|沿線有無障礙坡道紀錄)$/.exec(text)
  if (ramp) return [localizeRouteText(ramp[1]!), t(ramp[2]!)].join(' ')

  const initial = /^前約 (\d+) 公尺$/.exec(text)
  if (initial) return t('前約 {0} 公尺', initial[1]!)
  const interval = /^約第 (\d+)–(\d+) 公尺$/.exec(text)
  if (interval) return t('約第 {0}–{1} 公尺', interval[1]!, interval[2]!)

  const alongside = new RegExp(`^(${coverage})沿(${walkway})前進$`).exec(text)
  if (alongside) return t('{0}沿{1}前進', localizeRouteText(alongside[1]!), t(alongside[2]!))
  const onSide = new RegExp(`^(${coverage})?(${side})有(${walkway})$`).exec(text)
  if (onSide) {
    const [prefix, where, kind] = onSide.slice(1)
    return prefix ? t('{0}{1}有{2}', localizeRouteText(prefix), t(where!), t(kind!))
      : t('{0}有{1}', t(where!), t(kind!))
  }
  return text
}

export function localizeRouteError(detail?: { code?: string; message?: string; endpoint?: 'start' | 'end' }): string | undefined {
  if (!detail?.message || locale.value !== 'en') return detail?.message
  if (detail.code === 'UNROUTABLE_ENDPOINT' && detail.endpoint) {
    const endpoint = detail.endpoint === 'start' ? '起點' : '終點'
    return t('{0}附近找不到可接上的步行路網，請改選附近出入口或道路。', t(endpoint))
  }
  if (detail.code === 'NO_ROUTE') return t('此方式找不到符合條件的路線。')
  return t(detail.message)
}
