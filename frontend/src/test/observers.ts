import { act } from '@testing-library/react'
import { intersectionObservers, resizeObservers } from './setup'

/**
 * Drive the observer stubs installed in `setup.ts`.
 *
 * Both of the app's scroll-driven behaviours — paging the grid, measuring a
 * shelf row — hang off an observer jsdom does not implement, so without these
 * they are untestable rather than merely untested.
 */
export function scrollSentinelIntoView() {
  act(() => {
    for (const observer of intersectionObservers) observer.fire()
  })
}

export function resizeObservedElements() {
  act(() => {
    for (const observer of resizeObservers) observer.fire()
  })
}
