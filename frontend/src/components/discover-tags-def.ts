/** Discover's tri-state tag selection, kept apart from the component (as
 *  `panes-def.ts` and `sections-def.ts` do) so fast refresh does not choke on a
 *  component file that also exports constants and helpers. */

/** The shape `matchesTagFilters` consumes. */
export interface TagSelection {
  include: string[]
  exclude: string[]
}

export const EMPTY_TAGS: TagSelection = { include: [], exclude: [] }

export function tagState(
  selection: TagSelection,
  tag: string,
): 'inc' | 'exc' | undefined {
  if (selection.include.includes(tag)) return 'inc'
  if (selection.exclude.includes(tag)) return 'exc'
  return undefined
}

/** none → include → exclude → none, the same cycle the archive's own filter
 *  popover uses, so the two read identically. */
export function cycleTag(selection: TagSelection, tag: string): TagSelection {
  const current = tagState(selection, tag)
  const include = selection.include.filter((t) => t !== tag)
  const exclude = selection.exclude.filter((t) => t !== tag)
  if (!current) return { include: [...include, tag], exclude }
  if (current === 'inc') return { include, exclude: [...exclude, tag] }
  return { include, exclude }
}
