// three.js ships no types, and `@types/three` is not a dependency of this repo. This declares only
// the part of it the agent graph's 3D view touches (`components/graph/AgentGraph3D.tsx`), so a call
// outside it fails to compile instead of passing as `any`. 3d-force-graph's own declarations import
// more names from 'three'; `skipLibCheck` leaves those to the library.
declare module 'three' {
  export interface Vector3Like {
    x: number
    y: number
    z: number
    set(x: number, y: number, z: number): this
  }

  export class Color {
    constructor(color?: string | number)
    set(color: string | number | Color): this
    getHexString(): string
  }

  export class Vector3 implements Vector3Like {
    constructor(x?: number, y?: number, z?: number)
    x: number
    y: number
    z: number
    set(x: number, y: number, z: number): this
  }

  export interface Intersection {
    distance: number
    object: Object3D
  }

  export class Object3D {
    position: Vector3Like
    scale: Vector3Like
    visible: boolean
    renderOrder: number
    parent: Object3D | null
    children: Object3D[]
    add(...objects: Object3D[]): this
    remove(...objects: Object3D[]): this
    /** Picking. Replaced with a no-op on objects a pointer must go through. */
    raycast(raycaster: Raycaster, intersects: Intersection[]): void
    updateMatrixWorld(force?: boolean): void
  }
  export class Group extends Object3D {}
  export class Scene extends Object3D {}
  export class Camera extends Object3D {}
  export class PerspectiveCamera extends Camera {
    constructor(fov?: number, aspect?: number, near?: number, far?: number)
  }

  export class Raycaster {
    constructor(origin?: Vector3, direction?: Vector3, near?: number, far?: number)
    camera: Camera | null
    intersectObject(object: Object3D, recursive?: boolean): Intersection[]
  }

  export class BufferGeometry {
    dispose(): void
  }
  export class SphereGeometry extends BufferGeometry {
    constructor(radius?: number, widthSegments?: number, heightSegments?: number)
  }
  export class IcosahedronGeometry extends BufferGeometry {
    constructor(radius?: number, detail?: number)
  }
  export class DodecahedronGeometry extends BufferGeometry {
    constructor(radius?: number, detail?: number)
  }
  export class OctahedronGeometry extends BufferGeometry {
    constructor(radius?: number, detail?: number)
  }
  export class TetrahedronGeometry extends BufferGeometry {
    constructor(radius?: number, detail?: number)
  }
  export class BoxGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, depth?: number)
  }

  export interface MaterialParameters {
    color?: string | number | Color
    emissive?: string | number | Color
    emissiveIntensity?: number
    transparent?: boolean
    opacity?: number
    depthWrite?: boolean
    depthTest?: boolean
    wireframe?: boolean
    flatShading?: boolean
    side?: number
    map?: Texture | null
  }
  export class Material {
    opacity: number
    transparent: boolean
    depthWrite: boolean
    needsUpdate: boolean
    dispose(): void
  }
  export class MeshLambertMaterial extends Material {
    constructor(parameters?: MaterialParameters)
    color: Color
    emissive: Color
    emissiveIntensity: number
  }
  export class MeshBasicMaterial extends Material {
    constructor(parameters?: MaterialParameters)
    color: Color
  }
  export class SpriteMaterial extends Material {
    constructor(parameters?: MaterialParameters)
    map: Texture | null
  }

  export class Mesh<G extends BufferGeometry = BufferGeometry, M extends Material = Material> extends Object3D {
    constructor(geometry?: G, material?: M)
    geometry: G
    material: M
  }
  export class Sprite extends Object3D {
    constructor(material?: SpriteMaterial)
    material: SpriteMaterial
  }

  export class Texture {
    needsUpdate: boolean
    colorSpace: string
    dispose(): void
  }
  export class CanvasTexture extends Texture {
    constructor(canvas: HTMLCanvasElement)
  }

  export class WebGLRenderer {
    domElement: HTMLCanvasElement
    dispose(): void
    forceContextLoss(): void
  }
  export interface WebGLRendererParameters {
    antialias?: boolean
    alpha?: boolean
    powerPreference?: 'default' | 'high-performance' | 'low-power'
    failIfMajorPerformanceCaveat?: boolean
  }

  export const BackSide: number
  export const SRGBColorSpace: string
}
