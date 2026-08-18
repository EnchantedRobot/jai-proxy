import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Variant } from '@/lib/tags/tag-analysis'
import type { EditorGroup } from '@/lib/tags/tags-editor'
import { ChipMoveMenu, type GroupTarget } from './ChipMoveMenu'
import type { MoveDest, MoveFrom } from './move-types'

/** Union of card avatars across a group's variants — the "Cards" column. */
function cardCount(group: EditorGroup): number {
  const set = new Set<string>()
  for (const v of group.variants) for (const a of v.avatars) set.add(a)
  return set.size
}

/** True if this group will actually rename at least one tag on a real card. */
function groupHasRename(group: EditorGroup): boolean {
  return group.variants.some((v) => v.count > 0 && v.tag !== group.canonical)
}

export function CanonicalRow({
  group,
  targets,
  onRename,
  onMove,
  onDelete,
}: {
  group: EditorGroup
  /** All canonicals, for the move menu; the row filters out its own. */
  targets: GroupTarget[]
  onRename: (id: string, name: string) => void
  onMove: (variant: Variant, from: MoveFrom, dest: MoveDest) => void
  onDelete: (id: string) => void
}) {
  const visible = group.variants.filter((v) => v.count > 0)
  const otherTargets = targets.filter((t) => t.id !== group.id)

  return (
    <div
      className={cn(
        'grid grid-cols-[minmax(180px,1.1fr)_minmax(260px,2fr)_72px_34px] items-center gap-4 rounded-xl px-3 py-2.5 hover:bg-raised',
        !groupHasRename(group) && 'opacity-60',
      )}
    >
      <input
        defaultValue={group.canonical}
        // Committed on blur (and Enter), matching the old `change` listener —
        // not on every keystroke.
        key={group.canonical}
        onBlur={(e) => onRename(group.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="w-full rounded-[9px] border border-transparent bg-transparent px-2.5 py-1.5 text-[14px] font-medium hover:border-line focus:border-sage focus:bg-ground focus:outline-none"
      />

      <div className="flex flex-wrap gap-1.5">
        {group.patterns.map((p) => (
          <RuleChip key={p} source={p} />
        ))}
        {visible.map((variant) => (
          <ChipMoveMenu
            key={variant.tag}
            groups={otherTargets}
            onPickGroup={(id) => onMove(variant, group, { groupId: id })}
            fixed={[
              {
                label: '✕ Unassign (leave unmapped)',
                onSelect: () => onMove(variant, group, 'unassigned'),
              },
              {
                label: '🗑 Remove (delete from cards)',
                onSelect: () => onMove(variant, group, 'removed'),
              },
              {
                label: '＋ New canonical from this tag',
                onSelect: () => onMove(variant, group, 'new'),
              },
            ]}
            trigger={
              <button
                type="button"
                title={
                  variant.matchedBy?.startsWith('pattern:')
                    ? `matched by rule ${variant.matchedBy.slice(8)}`
                    : 'Click to move'
                }
                className={cn(
                  'inline-flex h-[26px] items-center gap-1.5 rounded-full border border-line bg-ground pr-2 pl-2.5 text-[12.5px] text-[#c3cacd] hover:border-sage-line',
                  variant.matchedBy?.startsWith('pattern:') &&
                    'border-sage-line/60',
                )}
              >
                <span>{variant.tag}</span>
                <span className="font-mono text-[11px] text-faint">
                  {variant.count}
                </span>
                <span
                  role="button"
                  aria-label="Remove from group"
                  title="Remove from group"
                  onClick={(e) => {
                    e.stopPropagation()
                    onMove(variant, group, 'unassigned')
                  }}
                  className="text-[11px] text-faint hover:text-bad"
                >
                  ✕
                </span>
              </button>
            }
          />
        ))}
      </div>

      <span className="text-right font-mono text-[13px] text-muted">
        {cardCount(group)}
      </span>

      <button
        type="button"
        title="Delete canonical — send all variants to Unassigned"
        onClick={() => onDelete(group.id)}
        className="grid size-[26px] place-items-center rounded-lg text-faint hover:bg-bad/10 hover:text-bad"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

/**
 * A glob rule chip. Deliberately inert — no menu, no count, no ✕. Rules come
 * from the shipped dictionary only; a user redirects a tag a rule caught by
 * moving that tag's own chip, which writes a literal override that outranks it.
 */
function RuleChip({ source }: { source: string }) {
  const kind =
    source.startsWith('*') && source.endsWith('*')
      ? 'containing'
      : source.endsWith('*')
        ? 'starting with'
        : 'ending with'
  const needle = source.replace(/^\*|\*$/g, '')
  return (
    <span
      title={`Core match rule — claims any unmapped tag ${kind} “${needle}”. Move a tag's own chip to override it.`}
      className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-warn/30 bg-ground px-2.5 font-mono text-[11.5px] text-warn"
    >
      <span aria-hidden>⌇</span>
      <span>{source}</span>
    </span>
  )
}
