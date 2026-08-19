import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Whether a keyboard event landed in something the user is typing into.
 *
 * Any single-letter shortcut bound at the window has to ask this first — the
 * listener fires wherever focus is, and "j" is both "next card" and a letter
 * people type into a description. `contentEditable` is checked as well as the
 * form elements because the creator-notes frame and any future rich editor are
 * neither an input nor a textarea.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}
