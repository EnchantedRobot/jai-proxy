import { useSyncExternalStore } from 'react'

/**
 * A one-line toast store.
 *
 * Imperative rather than declarative because a toast is fired from a mutation
 * callback, not rendered from state — `toast('Saved')` after a `PUT` resolves,
 * with no component owning the message. The `Toaster` in the shell subscribes
 * and paints the stack; everything else just calls `toast()`.
 */
export interface Toast {
  id: number
  message: string
  variant: 'ok' | 'bad'
}

let toasts: Toast[] = []
const listeners = new Set<() => void>()
let nextId = 1

function emit() {
  for (const listener of listeners) listener()
}

export function toast(message: string, variant: Toast['variant'] = 'ok') {
  const id = nextId++
  toasts = [...toasts, { id, message, variant }]
  emit()
  // Auto-dismiss; the Toaster also lets the user close one early.
  setTimeout(() => dismissToast(id), 4000)
  return id
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => toasts,
    () => toasts,
  )
}
