import { onScopeDispose, ref, watch } from 'vue'
import { townpass, type MagnetometerStatus } from '../bridge/townpass'

/** no magnetometer samples for this long while streaming -> ask the user to calibrate */
export const MAG_SILENCE_MS = 3000
/** gyroscope below this (Hz, over ~5 s) suggests battery saver (A71: ~21 Hz vs ~50 Hz normally) */
export const LOW_GYRO_HZ = 35
const POWER_DISMISS_KEY = 'indoor-nav:power-hint-dismissed'

/**
 * Does the magnetometer need calibrating? On iOS uncalibrated samples are not sent at all (and
 * `magnetometer_accuracy` < 1 would mean low accuracy), so "streaming but silent" is the signal.
 */
export function needsMagCalibration(s: MagnetometerStatus, silenceMs = MAG_SILENCE_MS): boolean {
  if (!s.streaming || s.streamingForMs < silenceMs) return false
  if (s.accuracy !== null && s.accuracy < 1) return true
  return s.sinceLastSampleMs > silenceMs
}

/** Low sensor rate (likely power saving)? null rate = not enough samples yet. */
export function lowSensorRate(gyroHz: number | null, threshold = LOW_GYRO_HZ): boolean {
  return gyroHz !== null && gyroHz < threshold
}

interface SensorSource {
  magnetometerStatus(now?: number): MagnetometerStatus
  gyroscopeRateHz(): number | null
}

function sessionFlag(key: string): { get(): boolean; set(): void } {
  let mem = false
  return {
    get: () => {
      try {
        return mem || sessionStorage.getItem(key) === '1'
      } catch {
        return mem
      }
    },
    set: () => {
      mem = true
      try {
        sessionStorage.setItem(key, '1')
      } catch {
        /* storage unavailable: remembered for this page only */
      }
    },
  }
}

/**
 * Sensor hints while `active()` (live positioning / locate phase / survey eval run):
 * - mag: 「磁力計尚未校正」; dismissing hides it until samples come back and go missing again.
 * - power: 「感測器頻率偏低」; dismissal remembered for the browser session.
 * Positioning keeps running either way; these are advice only.
 */
export function useSensorHints(active: () => boolean, bridge: SensorSource = townpass, pollMs = 500) {
  const mag = ref(false)
  const power = ref(false)
  let magDismissed = false
  const powerDismissed = sessionFlag(POWER_DISMISS_KEY)
  const check = () => {
    const on = active()
    const needMag = on && needsMagCalibration(bridge.magnetometerStatus())
    if (!needMag) magDismissed = false
    mag.value = needMag && !magDismissed
    power.value = on && lowSensorRate(bridge.gyroscopeRateHz()) && !powerDismissed.get()
  }
  const timer = setInterval(check, pollMs)
  watch(active, check)
  onScopeDispose(() => clearInterval(timer))
  return {
    mag,
    power,
    dismissMag() {
      magDismissed = true
      mag.value = false
    },
    dismissPower() {
      powerDismissed.set()
      power.value = false
    },
    check,
  }
}

/** Magnetometer hint only (kept for callers that want just that). */
export function useMagCalibrationHint(active: () => boolean, bridge: SensorSource = townpass, pollMs = 500) {
  const h = useSensorHints(active, bridge, pollMs)
  return { show: h.mag, dismiss: h.dismissMag, check: h.check }
}
