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

/** One line of a dialogue block. `speaker` is null for text that precedes the
 *  first `{{user}}:` / `{{char}}:` tag (rare, but real -- a freeform block with
 *  no turn markers at all reads as a single untagged turn). */
export interface DialogueTurn {
  speaker: 'user' | 'char' | null
  text: string
}

/** One `mes_example` block: its raw text (used by the editor) plus the turns
 *  parsed out of it (used by the read view). */
export interface DialogueBlock {
  raw: string
  turns: DialogueTurn[]
}

const TURN_TAG = /\{\{(user|char)\}\}:[ \t]*/gi

/** Split one block's raw text into `{{user}}:` / `{{char}}:` turns. A block
 *  with no recognized tag at all -- real in the archive -- falls back to a
 *  single untagged turn holding the whole block, rather than an empty list. */
function dialogueTurns(block: string): DialogueTurn[] {
  const tags = [...block.matchAll(TURN_TAG)]
  if (tags.length === 0) return [{ speaker: null, text: block }]

  const turns: DialogueTurn[] = []
  const preamble = block.slice(0, tags[0].index).trim()
  if (preamble) turns.push({ speaker: null, text: preamble })

  tags.forEach((tag, i) => {
    const start = tag.index + tag[0].length
    const end = i + 1 < tags.length ? tags[i + 1].index : block.length
    const text = block.slice(start, end).trim()
    if (text)
      turns.push({ speaker: tag[1].toLowerCase() as 'user' | 'char', text })
  })
  return turns
}

/**
 * `mes_example` split into blocks, each rendered as its own transcript.
 *
 * Blocks are separated by `<START>`, matched case-insensitively -- the
 * archive's own cards use the uppercase form but a real corpus of ST exports
 * uses lowercase `<start>` throughout. 318 archive cards carry `mes_example`
 * with zero `<START>` markers at all; `String.split` against a pattern that
 * never matches returns the whole string as its one element, so that case
 * falls out as a single block for free rather than needing its own branch.
 */
export function dialogueBlocks(card: CardData): DialogueBlock[] {
  const raw = str(card, 'mes_example')
  if (!raw.trim()) return []
  return raw
    .split(/<start>/gi)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({ raw: block, turns: dialogueTurns(block) }))
}

/** The `extensions.<provider>` block, or an empty object. */
export function extension(card: CardData, name: string): CardData {
  const extensions = card.extensions
  if (!extensions || typeof extensions !== 'object') return {}
  const block = (extensions as CardData)[name]
  return block && typeof block === 'object' ? (block as CardData) : {}
}

/**
 * Where a card came from, as a reader thinks of it.
 *
 * `source_kind` names the *importer*, not the site, and two of them exist per
 * site: `chub_import` is the bulk pass and `chub_core` a live capture, both of
 * them Chub. The suffix is provenance trivia — for reading a card and for
 * filtering the grid, the platform is the answer — so the suffix is stripped
 * and the remaining stem is labelled.
 *
 * Derived rather than table-driven so a kind nobody has written a label for yet
 * still groups and still reads: an unknown `foo_import` becomes "Foo" instead
 * of falling out of the Source list entirely.
 */
const PLATFORM_LABELS: Record<string, string> = {
  janitor: 'JanitorAI',
  chub: 'Chub',
  datacat: 'DataCat',
  saucepan: 'Saucepan',
  jannyai: 'JannyAI',
  card: 'Imported file',
}

export function sourcePlatform(kind: string): string {
  return kind.replace(/_(core|import)$/, '')
}

export function platformLabel(platform: string): string {
  if (PLATFORM_LABELS[platform]) return PLATFORM_LABELS[platform]
  const words = platform.replace(/_/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : 'unknown'
}

export function sourceLabel(kind: string): string {
  return platformLabel(sourcePlatform(kind))
}

/** One row of the Source filter: a platform, its total, and the kinds to ask
 *  the API for. Built from `/facets` so the list is whatever the archive holds. */
export interface SourceGroup {
  platform: string
  label: string
  count: number
  kinds: string[]
}

export function groupSources(
  sources: { value: string; count: number }[],
): SourceGroup[] {
  const groups = new Map<string, SourceGroup>()
  for (const { value, count } of sources) {
    const platform = sourcePlatform(value)
    const group = groups.get(platform) ?? {
      platform,
      label: platformLabel(platform),
      count: 0,
      kinds: [],
    }
    group.count += count
    group.kinds.push(value)
    groups.set(platform, group)
  }
  // Biggest first, name breaking the tie — the same order `/facets` uses, which
  // the merge above would otherwise disturb.
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  )
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
