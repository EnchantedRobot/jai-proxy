import { useState } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { CardTile } from '@/components/CardTile'
import { CardGrid } from '@/components/CardGrid'
import {
  useGalleryFiles,
  useSameCreator,
  useSharesTag,
  type CardDetail,
} from '@/hooks/use-character-detail'
import {
  estimateTokens,
  formatBytes,
  formatDate,
  formatTokens,
  greetings,
  loreEntries,
  lorebookName,
  sourceLabel,
  str,
  type GalleryFile,
  type LoreEntry,
} from '@/lib/card'
import { setField, setGreetings } from '@/lib/card-edit'
import { cn } from '@/lib/utils'
import { CreatorNotes } from './CreatorNotes'
import { EditActions, EditButton, useEdit } from './edit-context'
import { InlineTextField } from './editors'
import { Lightbox } from './Lightbox'
import { MediaDiscovery } from './MediaDiscovery'
import { ClampedProse, EmptyState, ProseBox, Section } from './Section'

/** Save / Cancel row shared by the editors, right-aligned under the field. */
function SaveRow({
  onSave,
  disabled,
}: {
  onSave: () => void
  disabled?: boolean
}) {
  return (
    <div className="mt-2.5 flex">
      <EditActions onSave={onSave} disabled={disabled} />
    </div>
  )
}

// ---- Overview --------------------------------------------------------------

export function OverviewPane({ card }: { card: CardDetail }) {
  const data = card.card
  // The source page's title blurb is the closest thing a JAI/Chub card has to a
  // tagline; hide it when it merely repeats the name (common on JAI, where the
  // page title is often just the character's name).
  const tagline =
    card.page_name && card.page_name !== card.name ? card.page_name : ''

  return (
    <>
      {tagline && (
        <Section title="Tagline">
          <div className="mt-2.5 font-serif text-[19px] leading-[1.45] text-[#d2d8da]">
            {tagline}
          </div>
        </Section>
      )}
      <Section title="At a glance">
        <div className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(116px,1fr))] gap-2.5">
          <Stat
            value={estimateTokens(card.description_chars).toLocaleString()}
            label="description tokens"
          />
          <Stat value={card.greetings} label="greetings" />
          <Stat value={card.lore_entries} label="lore entries" />
          <Stat value={formatDate(card.create_date)} label="created" />
        </div>
      </Section>
      <CardTextSection data={data} field="description" title="Description" />
      <CardTextSection data={data} field="scenario" title="Scenario" />
      <CardTextSection data={data} field="personality" title="Personality" />
      {/* No "First message" here. It is greeting 1, which the Greetings tab
          already shows in full and is the only place it can be edited --
          rendering it twice made a long greeting dominate Overview and left two
          copies that could disagree mid-edit (Stage 6B D7). */}
    </>
  )
}

/**
 * One of the card's three main prose fields (description, scenario,
 * personality). Always rendered, even when the field is empty -- an empty
 * field is still worth showing, as an empty text box ready for an edit,
 * rather than hidden behind a separate empty state. Long text clamps to 20
 * lines with a click to expand, same as a long greeting.
 */
function CardTextSection({
  data,
  field,
  title,
}: {
  data: CardDetail['card']
  field: string
  title: string
}) {
  const { editing, save } = useEdit()
  const value = str(data, field)
  const isEditing = editing === field
  return (
    <Section
      title={title}
      count={value ? `(${formatTokens(value.length)})` : undefined}
      action={<EditButton section={field} />}
    >
      {isEditing ? (
        <TextFieldEditor
          initial={value}
          onSave={(next) => save(setField(data, field, next))}
        />
      ) : (
        <ClampedProse lines={20}>{value}</ClampedProse>
      )}
    </Section>
  )
}

function TextFieldEditor({
  initial,
  onSave,
}: {
  initial: string
  onSave: (value: string) => void
}) {
  const [draft, setDraft] = useState(initial)
  return (
    <>
      <InlineTextField value={draft} onChange={setDraft} autoFocus />
      <SaveRow onSave={() => onSave(draft)} />
    </>
  )
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="rounded-xl border border-line-soft bg-surface px-[13px] py-[11px]">
      <b className="block font-mono text-[18px] font-semibold">{value}</b>
      <span className="text-[11.5px] text-faint">{label}</span>
    </div>
  )
}

// ---- Creator notes ---------------------------------------------------------

export function NotesPane({ card }: { card: CardDetail }) {
  const notes = str(card.card, 'creator_notes')
  if (!notes.trim())
    return <EmptyState>This card carries no creator notes.</EmptyState>
  return (
    <Section title="Creator notes">
      <div className="mt-2.5">
        <CreatorNotes notes={notes} />
        <p className="mt-3 border-t border-line-soft pt-3 text-[12.5px] text-faint">
          Rendered from the card's{' '}
          <span className="font-mono">creator_notes</span> in an isolated frame.
          Layout is kept; the creator's palette is not.
        </p>
      </div>
    </Section>
  )
}

// ---- Greetings -------------------------------------------------------------

export function GreetingsPane({ card }: { card: CardDetail }) {
  const { editing, save } = useEdit()
  const all = greetings(card.card)
  const isEditing = editing === 'greetings'

  if (isEditing)
    return (
      <Section title="Greetings" action={<EditButton section="greetings" />}>
        <GreetingsEditor
          initial={all}
          onSave={(next) => save(setGreetings(card.card, next))}
        />
      </Section>
    )

  if (all.length === 0)
    return (
      <Section title="Greetings" action={<EditButton section="greetings" />}>
        <EmptyState>This card has no greeting.</EmptyState>
      </Section>
    )

  return (
    <>
      {all.map((greeting, index) => (
        <Section
          key={index}
          title={index === 0 ? 'Greeting 1 · primary' : `Greeting ${index + 1}`}
          count={`(${formatTokens(greeting.length)})`}
          action={index === 0 ? <EditButton section="greetings" /> : undefined}
        >
          <ClampedProse>{greeting}</ClampedProse>
        </Section>
      ))}
    </>
  )
}

function GreetingsEditor({
  initial,
  onSave,
}: {
  initial: string[]
  onSave: (greetings: string[]) => void
}) {
  const [drafts, setDrafts] = useState<string[]>(
    initial.length ? initial : [''],
  )
  const set = (index: number, value: string) =>
    setDrafts(drafts.map((g, i) => (i === index ? value : g)))

  return (
    <div className="mt-2.5 flex flex-col gap-3">
      {drafts.map((greeting, index) => (
        <div key={index}>
          <div className="flex items-center gap-2.5 text-[11.5px] text-faint">
            <span>
              {index === 0 ? 'Greeting 1 · primary' : `Greeting ${index + 1}`}
            </span>
            {drafts.length > 1 && (
              <button
                type="button"
                onClick={() => setDrafts(drafts.filter((_, i) => i !== index))}
                className="text-faint hover:text-bad"
              >
                remove
              </button>
            )}
          </div>
          <InlineTextField
            value={greeting}
            onChange={(value) => set(index, value)}
            autoFocus={index === 0}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => setDrafts([...drafts, ''])}
        className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-line py-2.5 text-[12.5px] text-muted hover:border-sage-line hover:text-sage"
      >
        <Plus className="size-3.5" /> Add greeting
      </button>
      <SaveRow onSave={() => onSave(drafts)} />
    </div>
  )
}

// ---- Lorebook --------------------------------------------------------------

export function LorebookPane({ card }: { card: CardDetail }) {
  const entries = loreEntries(card.card)
  const name = lorebookName(card.card)

  if (entries.length === 0)
    return (
      <Section title={name || 'Lorebook'}>
        <EmptyState>No lorebook on this card.</EmptyState>
      </Section>
    )
  return (
    <Section title={name || 'Lorebook'} count={`${entries.length} entries`}>
      <div className="mt-2 flex flex-col gap-2">
        {entries.map((entry) => (
          <LoreEntryRow key={entry.id} entry={entry} />
        ))}
      </div>
    </Section>
  )
}

/**
 * One lorebook entry. `name` is the entry's title, `comment` is a short
 * description of it, `keys` are what makes it fire, and `content` is what
 * actually gets sent to the LLM when it does. Collapsed, the comment
 * truncates to one line and keys/content show a short preview; the chevron
 * expands to the full keys list and content.
 */
function LoreEntryRow({ entry }: { entry: LoreEntry }) {
  const [open, setOpen] = useState(false)
  const title = entry.name || entry.comment || 'Untitled entry'
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      className="flex flex-col gap-1 rounded-xl border border-line-soft bg-surface px-[13px] py-[11px] text-left hover:border-sage-line"
    >
      <div className="flex items-start gap-3">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[#d2d8da]">
          {title}
        </span>
        <ChevronDown
          className={cn(
            'mt-0.5 size-3.5 flex-none text-faint transition-transform',
            open && 'rotate-180',
          )}
        />
      </div>
      {entry.comment && (
        <div
          className={cn('text-[12px] text-faint italic', !open && 'truncate')}
        >
          {entry.comment}
        </div>
      )}
      <div className="mt-1 flex items-start gap-3">
        <span
          className={cn(
            'w-[150px] flex-none font-mono text-[11.5px] text-sage',
            open ? 'whitespace-normal break-words' : 'line-clamp-2',
          )}
          title={entry.keys.join(', ')}
        >
          {entry.keys.join(', ') || '—'}
        </span>
        <span
          className={cn(
            'flex-1 text-[13px] whitespace-pre-wrap text-[#c3cacd]',
            !open && 'line-clamp-2',
          )}
        >
          {entry.content || 'Entry text…'}
        </span>
      </div>
    </button>
  )
}

// ---- Gallery ---------------------------------------------------------------

export function GalleryPane({ card }: { card: CardDetail }) {
  const gallery = useGalleryFiles(card.gallery.folder, card.gallery.exists)
  const [open, setOpen] = useState<number | null>(null)
  const files = gallery.data?.items ?? []

  if (!card.gallery.exists)
    return (
      <>
        <MediaDiscovery cardId={card.id} />
        <EmptyState>No gallery has been downloaded for this card.</EmptyState>
      </>
    )
  if (gallery.isPending)
    return <p className="mt-4 text-center text-faint">reading gallery…</p>
  if (files.length === 0)
    return (
      <>
        <MediaDiscovery cardId={card.id} />
        <EmptyState>The gallery folder is empty.</EmptyState>
      </>
    )

  return (
    <Section
      title={`${files.length} files`}
      count={formatBytes(gallery.data!.bytes)}
    >
      <MediaDiscovery cardId={card.id} />
      <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2.5">
        {files.map((file, index) => (
          <GalleryThumb
            key={file.name}
            file={file}
            onOpen={() => setOpen(index)}
          />
        ))}
      </div>
      {open !== null && (
        <Lightbox
          files={files}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </Section>
  )
}

function GalleryThumb({
  file,
  onOpen,
}: {
  file: GalleryFile
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative aspect-square overflow-hidden rounded-lg border border-line-soft bg-raised hover:border-sage-line"
    >
      {file.thumb_url ? (
        <img
          src={file.thumb_url}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      ) : (
        <span className="grid size-full place-items-center text-[11px] text-faint uppercase">
          {file.kind}
        </span>
      )}
    </button>
  )
}

// ---- Related ---------------------------------------------------------------

export function RelatedPane({ card }: { card: CardDetail }) {
  // The most specific tag is the best single "shares tags" signal — the last
  // one, since importers tend to lead with broad tags (Female, SFW) and end on
  // the character-specific ones. The list route ANDs tags, so we send just one.
  const tag = card.tags.at(-1)
  const sameCreator = useSameCreator(card.creator, card.id)
  const sharesTag = useSharesTag(tag, card.id)

  const creatorCards = sameCreator.data ?? []
  const tagCards = (sharesTag.data ?? []).filter(
    (other) => !creatorCards.some((c) => c.id === other.id),
  )

  return (
    <>
      <Section title={`Same creator · ${card.creator || 'unknown'}`}>
        {creatorCards.length ? (
          <CardGrid className="pt-2.5">
            {creatorCards.map((c) => (
              <CardTile key={c.id} card={c} />
            ))}
          </CardGrid>
        ) : (
          <EmptyState>No other cards by this creator.</EmptyState>
        )}
      </Section>
      {tag && (
        <Section title={`Shares the tag “${tag}”`}>
          {tagCards.length ? (
            <CardGrid className="pt-2.5">
              {tagCards.slice(0, 12).map((c) => (
                <CardTile key={c.id} card={c} />
              ))}
            </CardGrid>
          ) : (
            <EmptyState>Nothing else carries that tag.</EmptyState>
          )}
        </Section>
      )}
    </>
  )
}

// ---- Info ------------------------------------------------------------------

export function InfoPane({ card }: { card: CardDetail }) {
  const data = card.card
  return (
    <>
      <Section title="Card">
        <InfoRows
          rows={[
            ['File', card.id, true],
            ['Card id', card.card_id, true],
            ['Gallery id', card.gallery_id || '—', true],
            ['Spec', `${card.spec} ${card.spec_version}`.trim() || '—'],
            ['Size on disk', formatBytes(card.size), true],
          ]}
        />
      </Section>
      <Section title="Provenance">
        <InfoRows
          rows={[
            ['Source', sourceLabel(card.source_kind)],
            ['Creator', card.creator || 'unknown'],
            ['Created', formatDate(card.create_date), true],
            ['Added to archive', formatDate(card.linked_at), true],
            ['Version', card.character_version || '—', true],
            card.source_url
              ? ['Link', <SourceLink key="l" url={card.source_url} />]
              : null,
          ]}
        />
      </Section>
      <Section title="Content">
        <InfoRows
          rows={[
            ['Description', formatTokens(card.description_chars), true],
            ['Prompt weight', formatTokens(card.prompt_chars), true],
            ['Greetings', String(card.greetings), true],
            ['Lore entries', String(card.lore_entries), true],
            ['Example dialogue', card.has_example_dialogue ? 'yes' : 'none'],
          ]}
        />
      </Section>
      <Section title="card.json">
        <ProseBox className="max-h-[420px] overflow-auto font-mono text-[12.5px] leading-[1.6]">
          {JSON.stringify(data, null, 2)}
        </ProseBox>
      </Section>
    </>
  )
}

type Row = [label: string, value: React.ReactNode, mono?: boolean] | null

function InfoRows({ rows }: { rows: Row[] }) {
  return (
    <div className="mt-2.5 grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-x-[26px]">
      {rows
        .filter((row): row is [string, React.ReactNode, boolean?] => !!row)
        .map(([label, value, mono]) => (
          <div
            key={label}
            className="flex items-baseline gap-3 border-b border-line-soft px-0.5 py-[9px]"
          >
            <span className="min-w-[118px] text-[12.5px] text-faint">
              {label}
            </span>
            <b
              className={
                'ml-auto text-right text-[13.5px] font-medium' +
                (mono ? ' font-mono break-all' : '')
              }
            >
              {value}
            </b>
          </div>
        ))}
    </div>
  )
}

function SourceLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="text-sage hover:underline"
    >
      open ↗
    </a>
  )
}
