import { useEffect, useState, type RefObject } from 'react'

/**
 * How many columns the grid at `ref` is currently rendering.
 *
 * Measured off the element's own computed `grid-template-columns` rather than
 * derived from the viewport, which is the same trick the mock uses: the track
 * definition stays in one place (the grid's own class) and the shelf asks the
 * grid how wide a row is instead of duplicating the breakpoints.
 */
export function useGridColumns(ref: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const tracks = getComputedStyle(element)
        .gridTemplateColumns.split(' ')
        .filter(Boolean).length
      setColumns(tracks)
    }
    measure()
    // ResizeObserver rather than a window resize listener: the grid also
    // changes width when something beside it does (a scrollbar appearing as
    // the next page loads), and that never fires a window resize.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return columns
}
