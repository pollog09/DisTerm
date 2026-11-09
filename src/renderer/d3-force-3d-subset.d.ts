// d3-force-3d ships no types. This declares only what the agent graph's 3D view and its tests touch, as
// `three-subset.d.ts` does for three, so a call outside it fails to compile instead of passing as `any`.
declare module 'd3-force-3d' {
  export interface SimNode {
    x?: number
    y?: number
    z?: number
    [key: string]: unknown
  }

  export interface Force {
    (alpha: number): void
    initialize?: (nodes: SimNode[], ...args: unknown[]) => void
  }

  export interface StrengthForce extends Force {
    strength(strength: number): this
  }

  export interface LinkForce extends Force {
    id(id: (node: SimNode) => string): this
    links(links: Array<{ source: string | SimNode; target: string | SimNode }>): this
  }

  export interface Simulation {
    numDimensions(n: 1 | 2 | 3): this
    nodes(nodes: SimNode[]): this
    force(name: string): Force | undefined
    force(name: string, force: Force | null): this
    tick(iterations?: number): this
    stop(): this
  }

  export function forceSimulation(nodes?: SimNode[]): Simulation
  export function forceLink(): LinkForce
  export function forceManyBody(): StrengthForce
  export function forceCenter(): Force
  export function forceX(x?: number): StrengthForce
  export function forceY(y?: number): StrengthForce
  export function forceZ(z?: number): StrengthForce
}
