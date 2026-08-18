import { useState } from 'react'
import { Plus } from 'lucide-react'
import { CardTile } from '@/components/CardTile'
import { CardGrid } from '@/components/CardGrid'
import {
  useGalleryFiles,
  useSameCreator,
  useSharesTag,
  type CardDetail,
} from '@/hooks/use-character-detail'
import {
  formatBytes,
  formatCount,
  formatDate,
  greetings,
  loreEntries,
  lorebookName,
  sourceLabel,
  str,
  type GalleryFile,
  type LoreEntry,
} from '@/lib/card'
import { setField, setGreetings, setLoreEntries } from '@/lib/card-edit'
import { CreatorNotes } from './CreatorNotes'
import { EditActions, EditButton, useEdit } from './edit-context'
import { InlineTextField, LoreEntryEditor } from './editors'
import { Lightbox } from './Lightbox'
import { EmptyState, ProseBox, Section } from './Section'

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
  const first = greetings(data)[0] ?? ''

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
            value={`${(card.description_chars / 1000).toFixed(1)}k`}
            label="description chars"
          />
          <Stat value={card.greetings} label="greetings" />
          <Stat value={card.lore_entries} label="lore entries" />
          <Stat value={formatDate(card.create_date)} label="created" />
        </div>
      </Section>
      <DescriptionSection data={data} />
      {first && (
        <Section title="First message">
          <ProseBox>{first}</ProseBox>
        </Section>
      )}
    </>
  )
}

function DescriptionSection({ data }: { data: CardDetail['card'] }) {
  const { editing, save } = useEdit()
  const description = str(data, 'description')
  const isEditing = editing === 'description'
  // Editable even when currently empty, so a description can be written onto a
  // card that arrived without one; the read-only empty state is only shown when
  // no editor could open it.
  if (!description && !isEditing)
    return (
      <Section
        title="Description"
        action={<EditButton section="description" />}
      >
        <EmptyState>This card has no description.</EmptyState>
      </Section>
    )
  return (
    <Section title="Description" action={<EditButton section="description" />}>
      {isEditing ? (
        <DescriptionEditor
          initial={description}
          onSave={(value) => save(setField(data, 'description', value))}
        />
      ) : (
        <ProseBox>{description}</ProseBox>
      )}
    </Section>
  )
}

function DescriptionEditor({
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
          action={index === 0 ? <EditButton section="greetings" /> : undefined}
        >
          <ProseBox>{greeting}</ProseBox>
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
  const { editing, save } = useEdit()
  const entries = loreEntries(card.card)
  const name = lorebookName(card.card)
  const isEditing = editing === 'lore'

  // Editing needs a `character_book` to write into; `setLoreEntries` is a no-op
  // on a card that never had one, so the editor is only offered where there is a
  // book (even an empty one) to add entries to.
  const canEdit = !!card.card.character_book
  const action = canEdit ? <EditButton section="lore" /> : undefined

  if (isEditing)
    return (
      <Section title={name || 'Lorebook'} action={action}>
        <LoreEditorBody
          initial={entries}
          onSave={(next) => save(setLoreEntries(card.card, next))}
        />
      </Section>
    )

  if (entries.length === 0)
    return (
      <Section title={name || 'Lorebook'} action={action}>
        <EmptyState>No lorebook on this card.</EmptyState>
      </Section>
    )
  return (
    <Section
      title={name || 'Lorebook'}
      count={`${entries.length} entries`}
      action={action}
    >
      <div className="mt-2 flex flex-col gap-2">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="flex items-baseline gap-3 rounded-xl border border-line-soft bg-surface px-[13px] py-[11px]"
          >
            <span
              className="w-[150px] flex-none truncate font-mono text-[11.5px] text-sage"
              title={entry.keys.join(', ')}
            >
              {entry.keys.join(', ') || entry.comment || '—'}
            </span>
            <span className="line-clamp-2 text-[13px] text-[#c3cacd]">
              {entry.content || 'Entry text…'}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function LoreEditorBody({
  initial,
  onSave,
}: {
  initial: LoreEntry[]
  onSave: (entries: LoreEntry[]) => void
}) {
  const [drafts, setDrafts] = useState<LoreEntry[]>(initial)
  return (
    <>
      <LoreEntryEditor entries={drafts} onChange={setDrafts} />
      <SaveRow onSave={() => onSave(drafts)} />
    </>
  )
}

// ---- Gallery ---------------------------------------------------------------

export function GalleryPane({ card }: { card: CardDetail }) {
  const gallery = useGalleryFiles(card.gallery.folder, card.gallery.exists)
  const [open, setOpen] = useState<number | null>(null)
  const files = gallery.data?.items ?? []

  if (!card.gallery.exists)
    return (
      <EmptyState>No gallery has been downloaded for this card.</EmptyState>
    )
  if (gallery.isPending)
    return <p className="mt-4 text-center text-faint">reading gallery…</p>
  if (files.length === 0)
    return <EmptyState>The gallery folder is empty.</EmptyState>

  return (
    <Section
      title={`${files.length} files`}
      count={formatBytes(gallery.data!.bytes)}
    >
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
            [
              'Description',
              `${formatCount(card.description_chars)} chars`,
              true,
            ],
            ['Prompt weight', `${formatCount(card.prompt_chars)} chars`, true],
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
