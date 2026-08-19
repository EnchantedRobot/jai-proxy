import { useState } from 'react'
import { Link } from 'react-router'
import { Pencil } from 'lucide-react'
import type { CardDetail } from '@/hooks/use-character-detail'
import { setTags } from '@/lib/card-edit'
import { EditActions, useEdit } from './edit-context'
import { InlineTagEditor } from './editors'

/**
 * The card's tags under the title: links that filter the grid when read-only,
 * an editor when the row's own pencil is clicked. Part of the one-section-at-a-
 * time edit model — its section id is `tags`, so opening it hides every other
 * Edit button and vice versa.
 */
export function HeaderTags({ card }: { card: CardDetail }) {
  const { editing, begin, save } = useEdit()
  const isEditing = editing === 'tags'

  if (isEditing)
    return <TagEditor initial={card.tags} onSave={save} data={card.card} />

  return (
    <div className="mt-[15px] flex flex-wrap items-center gap-1.5">
      {card.tags.map((tag) => (
        <Link
          key={tag}
          to={`/?tag=${encodeURIComponent(tag)}`}
          className="rounded-lg border border-line bg-surface px-2.5 py-1 text-[12px] text-[#c3cacd] hover:border-sage-line hover:text-sage"
        >
          {tag}
        </Link>
      ))}
      {editing === null && (
        <button
          type="button"
          onClick={() => begin('tags')}
          className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-muted hover:border-sage-line hover:text-sage"
        >
          <Pencil className="size-3" />{' '}
          {card.tags.length ? 'Edit tags' : 'Add tags'}
        </button>
      )}
    </div>
  )
}

function TagEditor({
  initial,
  data,
  onSave,
}: {
  initial: string[]
  data: CardDetail['card']
  onSave: (next: CardDetail['card']) => void
}) {
  const [draft, setDraft] = useState<string[]>(initial)
  return (
    <div className="mt-[15px]">
      <InlineTagEditor tags={draft} onChange={setDraft} />
      <div className="mt-2.5 flex">
        <EditActions onSave={() => onSave(setTags(data, draft))} />
      </div>
    </div>
  )
}
