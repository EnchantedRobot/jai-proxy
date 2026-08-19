/** The Settings section keys and nav labels, in the mock's order. Kept apart
 *  from the components (as `panes-def.ts` does for the detail tabs) so fast
 *  refresh does not choke on a component file that also exports a constant. */
export const SETTINGS_SECTIONS = [
  { key: 'library', label: 'Library' },
  { key: 'archive', label: 'Archive & storage' },
  { key: 'providers', label: 'Providers' },
  { key: 'media', label: 'Media' },
  { key: 'userscripts', label: 'Userscripts' },
  { key: 'maintenance', label: 'Maintenance' },
] as const

export type SectionKey = (typeof SETTINGS_SECTIONS)[number]['key']
