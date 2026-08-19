import type { CardData } from './card'

/**
 * Building the replacement `data` object for a whole-card `PUT`.
 *
 * Every function takes the card's `data` object and returns a *new* one with one
 * region changed — the edit page holds the complete card, mutates a copy, and
 * sends it whole (docs/UI_REWRITE_PLAN.md §4.4). Partial-field editing is safe
 * precisely because the document that goes back is complete; these helpers only
 * decide which keys the edit touches, and leave every other key exactly as the
 * card carried it. The server re-sanitizes nothing, so what the user typed is
 * what the card gets.
 */

/** Replace a single top-level string field (description, scenario, …). */
export function setField(data: CardData, key: string, value: string): CardData {
  return { ...data, [key]: value }
}

/**
 * Write the greetings back the way `greetings()` reads them: the first is
 * `first_mes`, the rest are `alternate_greetings`. Blank entries are dropped so
 * an emptied box does not leave a greeting that is present-but-empty, which the
 * reader would still count.
 */
export function setGreetings(data: CardData, greetings: string[]): CardData {
  const kept = greetings.map((g) => g.trim()).filter(Boolean)
  return {
    ...data,
    first_mes: kept[0] ?? '',
    alternate_greetings: kept.slice(1),
  }
}

/**
 * Replace the tag list, trimming and dropping blanks and case-insensitive
 * duplicates while keeping the first spelling seen — the archive treats `Female`
 * and `female` as one tag, and a tag editor is largely for collapsing exactly
 * that.
 */
export function setTags(data: CardData, tags: string[]): CardData {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (!tag) continue
    const fold = tag.toLowerCase()
    if (seen.has(fold)) continue
    seen.add(fold)
    kept.push(tag)
  }
  return { ...data, tags: kept }
}
