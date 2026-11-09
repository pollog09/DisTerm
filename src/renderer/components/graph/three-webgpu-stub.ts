// Stands in for `three/webgpu` (aliased in electron.vite.config.ts).
//
// The agent graph's 3D view (3d-force-graph, through three-render-objects) imports `WebGPURenderer`
// at the top of a module, but builds it only when asked for WebGPU, and this app asks for WebGL. The
// real entry is the whole WebGPU renderer and its node system, most of the 3D chunk's weight for a
// path that never runs. Constructing this says so instead of drawing nothing.
export class WebGPURenderer {
  constructor() {
    throw new Error('The WebGPU renderer is not bundled in DisTerm')
  }
}
