/**
 * Can this window draw WebGL at all? Asked before the 3D view's code is even fetched, so a machine that
 * cannot (an old GPU, a blocklisted driver, a browser with WebGL off) gets the 2D view and a notice,
 * never a blank pane.
 *
 * The probe's context is released at once: Chromium keeps a small number of live WebGL contexts per
 * page and drops the oldest past that, which here could be a terminal's renderer.
 */
export function webglAvailable(doc: Document = document): boolean {
  try {
    const canvas = doc.createElement('canvas')
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

export const WEBGL_UNAVAILABLE_NOTICE = 'The 3D view needs WebGL, which this window cannot create. Showing the 2D view.'
export const WEBGL_LOST_NOTICE = 'The 3D view lost its graphics context. Showing the 2D view.'
export const GRAPH_3D_LOAD_FAILED_NOTICE = 'The 3D view could not be loaded. Showing the 2D view.'
export const GRAPH_3D_FAILED_NOTICE = 'The 3D view stopped with an error. Showing the 2D view.'
