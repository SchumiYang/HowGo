import { describe, expect, it } from 'vitest'
import type { Frame } from '../geo/frame'
import type { Route } from '../routing/route'
import { routeSources } from './convert'

const frame = { toLngLat: (p: [number, number]) => p } as unknown as Frame
const kinds = (r: Route) =>
  routeSources(r, frame, (l) => l).points.features.map((f) => `${(f.properties as { kind: string }).kind}@${(f.properties as { level: string }).level}:${(f.geometry as { coordinates: number[] }).coordinates.join(',')}`)

describe('route joints', () => {
  it('marks every interior vertex of a floor leg, not the start, transfers or destination', () => {
    const route: Route = {
      points: [
        { level: '1F', xy: [0, 0] },
        { level: '1F', xy: [10, 0], via: 'corridor' },
        { level: '1F', xy: [10, 10], via: 'corridor' },
        { level: '2F', xy: [10, 10], via: 'elevator' },
        { level: '2F', xy: [20, 10], via: 'corridor' },
        { level: '2F', xy: [20, 20], via: 'corridor' },
      ],
      cost: 0, walkLength: 40, targetIndex: 0,
    }
    expect(kinds(route)).toEqual([
      'transfer@1F:10,10', 'transfer@2F:10,10',
      'joint@1F:10,0', 'joint@2F:20,10',
      'dest@2F:20,20',
    ])
  })
})
