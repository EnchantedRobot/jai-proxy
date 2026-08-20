/** The Tools section keys and nav labels. Kept apart from the components (as
 *  `settings/sections-def.ts` does for Settings) so fast refresh does not
 *  choke on a component file that also exports a constant. */
export const TOOLS_SECTIONS = [
  { key: 'tags', label: 'Tags' },
  { key: 'duplicates', label: 'Duplicates' },
] as const

export type SectionKey = (typeof TOOLS_SECTIONS)[number]['key']
