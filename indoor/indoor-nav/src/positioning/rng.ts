/** Seedable PRNG (mulberry32) + Gaussian sampler, so filter runs and evaluations are reproducible. */

export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard normal sampler (Box–Muller, caches the second value). */
export function makeGauss(rng: Rng): () => number {
  let spare: number | null = null
  return () => {
    if (spare !== null) {
      const s = spare
      spare = null
      return s
    }
    let u = 0
    while (u < 1e-12) u = rng()
    const r = Math.sqrt(-2 * Math.log(u))
    const v = 2 * Math.PI * rng()
    spare = r * Math.sin(v)
    return r * Math.cos(v)
  }
}
