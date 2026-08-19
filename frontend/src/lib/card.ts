import type { components } from './api-schema'

export type CardDetail = components['schemas']['CardDetailOut']
export type GalleryFile = components['schemas']['GalleryFileOut']

/**
 * Reading the embedded V3 card.
 *
 * `CardDetailOut.card` is the card's `data` object verbatim off the PNG, typed
 * as `Record<string, unknown>` because that is honestly what it is: 3,868 cards
 * written by five importers out of four platforms, and a card missing
 * `mes_example` or carrying a `character_book` with no `entries` is ordinary,
 * not corrupt. Every accessor here answers with an empty value rather than
 * throwing, so one odd card renders a thin detail page instead of a blank one.
 */
export type CardData = Record<string, unknown>

export function str(card: CardData, key: string): string {
  const value = card[key]
  return typeof value === 'string' ? value : ''
}

/** A lorebook entry, as much of it as the detail view reads. */
export interface LoreEntry {
  id: number
  name: string
  keys: string[]
  secondaryKeys: string[]
  content: string
  comment: string
  enabled: boolean
  constant: boolean
  insertionOrder: number
}

export function loreEntries(card: CardData): LoreEntry[] {
  const book = card.character_book
  if (!book || typeof book !== 'object') return []
  const raw = (book as CardData).entries
  if (!Array.isArray(raw)) return []
  return raw.map((entry, index) => {
    const e = (entry ?? {}) as CardData
    return {
      id: typeof e.id === 'number' ? e.id : index,
      name: typeof e.name === 'string' ? e.name : '',
      keys: strings(e.keys),
      secondaryKeys: strings(e.secondary_keys),
      content: typeof e.content === 'string' ? e.content : '',
      comment: typeof e.comment === 'string' ? e.comment : '',
      // Absent means on: SillyTavern treats a missing `enabled` as enabled, and
      // several importers never write the field at all.
      enabled: e.enabled !== false,
      constant: e.constant === true,
      insertionOrder:
        typeof e.insertion_order === 'number' ? e.insertion_order : index,
    }
  })
}

export function lorebookName(card: CardData): string {
  const book = card.character_book
  if (!book || typeof book !== 'object') return ''
  return str(book as CardData, 'name')
}

/**
 * Every greeting the card carries, primary first.
 *
 * `group_only_greetings` is deliberately left out — it is a SillyTavern group-chat
 * affordance, not a greeting a reader of this card would ever be shown first.
 */
export function greetings(card: CardData): string[] {
  const first = str(card, 'first_mes')
  const alternates = strings(card.alternate_greetings)
  return first ? [first, ...alternates] : alternates
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : []
}

/** The `extensions.<provider>` block, or an empty object. */
export function extension(card: CardData, name: string): CardData {
  const extensions = card.extensions
  if (!extensions || typeof extensions !== 'object') return {}
  const block = (extensions as CardData)[name]
  return block && typeof block === 'object' ? (block as CardData) : {}
}

const SOURCE_LABELS: Record<string, string> = {
  janitor_core: 'JanitorAI',
  chub_import: 'Chub',
  datacat_import: 'DataCat',
  saucepan_core: 'Saucepan',
  jannyai_import: 'JannyAI',
  card_import: 'Imported file',
}

export function sourceLabel(kind: string): string {
  return SOURCE_LABELS[kind] ?? kind.replace(/_/g, ' ') ?? 'unknown'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * An ISO-8601 stamp as a plain date, or an em dash.
 *
 * Sliced rather than parsed: `linked_at` and `create_date` are passed through
 * exactly as the importer stamped them, which across this archive includes
 * shapes `Date` mis-parses or reads in the wrong zone. The first ten characters
 * are the date the card claims, and that is what the page should show.
 */
export function formatDate(iso: string | undefined | null): string {
  return iso ? iso.slice(0, 10) : '—'
}

export function formatCount(n: number): string {
  return n.toLocaleString()
}

/**
 * Rough prompt-token estimate from a character count, at the standard
 * `1 token ≈ 4 characters` rule of thumb used by SillyTavern and most LLM
 * tooling. This is intentionally not a real tokenizer -- just enough to give
 * a "how big is this" sense at display time.
 */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4)
}

export function formatTokens(chars: number): string {
  return `${formatCount(estimateTokens(chars))} tokens`
}
