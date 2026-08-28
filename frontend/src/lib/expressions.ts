import type { GalleryFile } from './card'

/**
 * SillyTavern's GoEmotions sprite set, verbatim -- the labels a sprite
 * folder's filenames are grouped and validated against
 * (docs/FORKS_AND_EXTRAS_PLAN.md §2).
 */
export const DEFAULT_EXPRESSIONS = [
  'admiration',
  'amusement',
  'anger',
  'annoyance',
  'approval',
  'caring',
  'confusion',
  'curiosity',
  'desire',
  'disappointment',
  'disapproval',
  'disgust',
  'embarrassment',
  'excitement',
  'fear',
  'gratitude',
  'grief',
  'joy',
  'love',
  'nervousness',
  'neutral',
  'optimism',
  'pride',
  'realization',
  'relief',
  'remorse',
  'sadness',
  'surprise',
] as const

/**
 * The label a sprite filename carries, exactly as ST's own
 * `src/endpoints/sprites.js` derives it: lowercase the stem (the filename
 * minus its *last* extension only), then cut at the first `-` or `.` still in
 * it. `joy.webp`, `joy-1.webp` and `joy-_00004_.webp` are all `joy` --
 * verified against a real 7,539-file corpus at 100.00%. Never used to rename
 * anything; filenames are stored and exported verbatim, this is a display
 * concern only.
 */
export function expressionLabel(filename: string): string {
  const stem = filename.replace(/\.[^./]*$/, '').toLowerCase()
  return stem.split(/[-.]/)[0]
}

/** One display group: a label and the files that parsed to it. */
export interface ExpressionGroup {
  label: string
  files: GalleryFile[]
}

/**
 * Group a folder's files by parsed label, `neutral` first -- it is ST's
 * fallback sprite, so "does this character have a neutral?" is the question
 * worth answering at a glance. Everything else sorts alphabetically.
 */
export function groupExpressions(files: GalleryFile[]): ExpressionGroup[] {
  const groups = new Map<string, GalleryFile[]>()
  for (const file of files) {
    const label = expressionLabel(file.name)
    const list = groups.get(label)
    if (list) list.push(file)
    else groups.set(label, [file])
  }
  return [...groups.entries()]
    .map(([label, group]) => ({ label, files: group }))
    .sort((a, b) => {
      if (a.label === 'neutral') return -1
      if (b.label === 'neutral') return 1
      return a.label.localeCompare(b.label)
    })
}
