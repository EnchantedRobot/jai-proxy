import { useEffect, useState } from 'react'

/**
 * `value`, but held back until it has stopped changing for `delay` ms.
 *
 * Used by the search overlay: a query per keystroke would fire a request for
 * every prefix of what the user is typing, and the archive answers fast enough
 * that they would all land, in whatever order they finished.
 */
export function useDebounced<T>(value: T, delay = 200): T {
  const [held, setHeld] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setHeld(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return held
}
