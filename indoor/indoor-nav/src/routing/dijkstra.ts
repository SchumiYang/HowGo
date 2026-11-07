/** Minimal binary min-heap keyed by number. */
export class MinHeap<T> {
  private items: { k: number; v: T }[] = []

  get size() {
    return this.items.length
  }

  push(k: number, v: T) {
    const a = this.items
    a.push({ k, v })
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].k <= a[i].k) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }

  pop(): { k: number; v: T } | undefined {
    const a = this.items
    if (!a.length) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l].k < a[m].k) m = l
        if (r < a.length && a[r].k < a[m].k) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

export interface Arc<E> {
  to: string
  cost: number
  /** payload describing how the arc was traversed (e.g. the nav edge) */
  via: E
}

export interface DijkstraResult<E> {
  /** the target that was reached first */
  target: string
  cost: number
  /** node ids from source to target */
  path: string[]
  /** arc payloads, path.length - 1 entries */
  vias: E[]
}

/**
 * Single-source, multi-target Dijkstra. Stops at the first target settled, which is the
 * nearest target by route cost.
 */
export function dijkstra<E>(
  source: string,
  neighbors: (id: string) => Iterable<Arc<E>>,
  isTarget: (id: string) => boolean,
): DijkstraResult<E> | null {
  const best = new Map<string, number>([[source, 0]])
  const prev = new Map<string, { id: string; via: E }>()
  const done = new Set<string>()
  const heap = new MinHeap<string>()
  heap.push(0, source)
  while (heap.size) {
    const { k, v: u } = heap.pop()!
    if (done.has(u)) continue
    done.add(u)
    if (isTarget(u)) {
      const path = [u]
      const vias: E[] = []
      for (let c = u; prev.has(c); ) {
        const p = prev.get(c)!
        vias.unshift(p.via)
        path.unshift(p.id)
        c = p.id
      }
      return { target: u, cost: k, path, vias }
    }
    for (const arc of neighbors(u)) {
      if (done.has(arc.to)) continue
      const nk = k + arc.cost
      if (nk < (best.get(arc.to) ?? Infinity)) {
        best.set(arc.to, nk)
        prev.set(arc.to, { id: u, via: arc.via })
        heap.push(nk, arc.to)
      }
    }
  }
  return null
}
