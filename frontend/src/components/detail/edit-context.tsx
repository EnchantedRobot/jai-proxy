import { createContext, use, useCallback, useMemo, useState } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import type { CardData } from '@/lib/card'
import { StaleWriteError, usePutCharacter } from '@/hooks/use-card-mutations'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

/**
 * The editing surface shared by the detail panes.
 *
 * One section edits at a time (docs/UI_REWRITE_PLAN.md §4.4) — a deliberate
 * constraint that removes any need for a cross-section dirty guard. A pane reads
 * the current card, builds a modified copy with `lib/card-edit`, and calls
 * `save`, which PUTs the whole document with the read's `If-Match`. A 412 keeps
 * the editor open and tells the user to reload rather than clobbering silently.
 */
interface EditState {
  /** The card's current `data` object, the base every edit copies from. */
  data: CardData
  /** Which section is in edit mode, or null. */
  editing: string | null
  isSaving: boolean
  begin: (section: string) => void
  cancel: () => void
  /** Rewrite the card. Resolves `true` when it landed (the section closes),
   *  `false` on a stale write (the section stays open for a retry after reload). */
  save: (next: CardData) => Promise<boolean>
}

const Ctx = createContext<EditState | null>(null)

// The provider and its hook belong together; fast-refresh's "components only"
// rule does not apply to a context module.
// oxlint-disable-next-line react/only-export-components
export function useEdit(): EditState {
  const value = use(Ctx)
  if (!value) throw new Error('useEdit must be used inside <EditProvider>')
  return value
}

export function EditProvider({
  id,
  data,
  etag,
  children,
}: {
  id: string
  data: CardData
  etag: string | null
  children: React.ReactNode
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const put = usePutCharacter(id)

  const save = useCallback(
    async (next: CardData) => {
      try {
        await put.mutateAsync({ card: next, etag })
        setEditing(null)
        toast('Saved.')
        return true
      } catch (error) {
        if (error instanceof StaleWriteError) {
          toast(error.message, 'bad')
          return false
        }
        toast(error instanceof Error ? error.message : 'Could not save.', 'bad')
        return false
      }
    },
    [put, etag],
  )

  const value = useMemo<EditState>(
    () => ({
      data,
      editing,
      isSaving: put.isPending,
      begin: setEditing,
      cancel: () => setEditing(null),
      save,
    }),
    [data, editing, put.isPending, save],
  )

  return <Ctx value={value}>{children}</Ctx>
}

/**
 * The Edit button for a section's `action` slot. Hidden while another section is
 * being edited, so only one editor is ever open.
 */
export function EditButton({ section }: { section: string }) {
  const { editing, begin } = useEdit()
  if (editing !== null) return null
  return (
    <button
      type="button"
      onClick={() => begin(section)}
      className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-muted hover:border-sage-line hover:text-sage"
    >
      <Pencil className="size-3" /> Edit
    </button>
  )
}

/** The Save / Cancel pair every editor closes with. */
export function EditActions({
  onSave,
  disabled,
}: {
  onSave: () => void
  disabled?: boolean
}) {
  const { cancel, isSaving } = useEdit()
  return (
    <div className="ml-auto flex items-center gap-2">
      <button
        type="button"
        onClick={cancel}
        disabled={isSaving}
        className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12px] text-muted hover:bg-raised disabled:opacity-50"
      >
        <X className="size-3" /> Cancel
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={disabled || isSaving}
        className={cn(
          'flex items-center gap-1.5 rounded-lg border border-sage bg-sage px-2.5 py-1 text-[12px] font-semibold text-on-sage hover:bg-[#68d0b1]',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        <Check className="size-3" /> {isSaving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}
