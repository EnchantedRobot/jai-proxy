/** The detail tab keys, in the mock's order. Kept apart from the pane
 *  components so the module that only needs the list (the detail page's tab
 *  bar) does not import every pane, and fast-refresh stays happy. */
export const PANES = [
  'overview',
  'notes',
  'greetings',
  'lore',
  'gallery',
  'related',
  'info',
] as const

export type Pane = (typeof PANES)[number]
