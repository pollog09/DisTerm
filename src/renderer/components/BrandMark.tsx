// Inlined: Chromium fetches a mask image with CORS, which a file:// page cannot satisfy, so a mask
// from an asset url would draw nothing in the packaged app. A data: url has no such fetch.
import markUrl from '../assets/disterm-mark.png?inline'

/** The DisTerm mark, in the surrounding text colour so it reads on both themes. The image is only a
 *  mask: it is white on transparent, invisible on a light surface as is. */
export function BrandMark({ size, className }: { size: number; className?: string }): React.JSX.Element {
  const mask = `url("${markUrl}") center / contain no-repeat`
  return (
    <span
      aria-hidden="true"
      className={className ? `brand-mark ${className}` : 'brand-mark'}
      style={{ width: size, height: size, mask, WebkitMask: mask }}
    />
  )
}
