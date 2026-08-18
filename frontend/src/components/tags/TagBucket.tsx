import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { Variant } from '@/lib/tags/tag-analysis'
import type { Bucket } from '@/lib/tags/tags-editor'
import { ChipMoveMenu, type GroupTarget } from './ChipMoveMenu'
import type { MoveDest } from './move-types'

const META = {
  unassigned: {
    header: (n: number) => `Unassigned — no canonical mapping (${n})`,
    empty: 'Every tag on your cards is mapped or removed. 🎉',
    chip: 'border-warn/40 text-warn',
    bulkLabel: '🗑 Remove',
    bulkDest: 'removed' as MoveDest,
    single: (move: (dest: MoveDest) => void) => [
      {
        label: '🗑 Remove (delete from cards)',
        onSelect: () => move('removed'),
      },
      { label: '＋ New canonical from this tag', onSelect: () => move('new') },
    ],
  },
  removed: {
    header: (n: number) => `Removed — deleted from all cards on apply (${n})`,
    empty: 'No tags flagged for removal.',
    chip: 'border-bad/40 text-bad',
    bulkLabel: '↩ To Unassigned',
    bulkDest: 'unassigned' as MoveDest,
    single: (move: (dest: MoveDest) => void) => [
      { label: '↩ Restore to Unassigned', onSelect: () => move('unassigned') },
      { label: '＋ New canonical from this tag', onSelect: () => move('new') },
    ],
  },
} as const

const stripHash = (t: string) => t.toLowerCase().replace(/^#+/, '')

export function TagBucket({
  kind,
  variants,
  targets,
  onMove,
  onBulkMove,
}: {
  kind: Bucket
  variants: Variant[]
  targets: GroupTarget[]
  onMove: (variant: Variant, from: Bucket, dest: MoveDest) => void
  onBulkMove: (variants: Variant[], from: Bucket, dest: MoveDest) => void
}) {
  const meta = META[kind]
  const [filter, setFilter] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<Variant>>(new Set())

  // Removed shows only observed junk; Unassigned shows everything it holds.
  const visible = useMemo(
    () => (kind === 'removed' ? variants.filter((v) => v.count > 0) : variants),
    [kind, variants],
  )
  const sorted = useMemo(
    () =>
      [...visible].sort((a, b) =>
        kind === 'removed'
          ? b.count - a.count || a.tag.localeCompare(b.tag)
          : stripHash(a.tag).localeCompare(stripHash(b.tag)),
      ),
    [visible, kind],
  )
  const q = stripHash(filter.trim())
  const shown = q ? sorted.filter((v) => stripHash(v.tag).includes(q)) : sorted

  const cancelSelection = () => {
    setSelecting(false)
    setSelected(new Set())
  }
  const toggle = (v: Variant) => {
    const next = new Set(selected)
    if (!next.delete(v)) next.add(v)
    setSelected(next)
  }
  const bulk = (dest: MoveDest) => {
    onBulkMove([...selected], kind, dest)
    cancelSelection()
  }

  return (
    <div className="mt-4 rounded-[15px] border border-line bg-surface p-4">
      <div className="mb-3 flex items-center gap-3">
        <span className="text-[13px] font-semibold text-muted">
          {meta.header(visible.length)}
        </span>
        {visible.length > 0 && (
          <button
            type="button"
            onClick={() => (selecting ? cancelSelection() : setSelecting(true))}
            className="text-[12px] text-sage hover:underline"
          >
            {selecting ? 'Cancel' : 'Select'}
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="text-[13px] text-faint">{meta.empty}</div>
      ) : (
        <>
          {selecting && selected.size > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-ground px-3 py-2">
              <span className="text-[12.5px] text-muted">
                {selected.size} selected
              </span>
              <ChipMoveMenu
                groups={targets}
                onPickGroup={(id) => bulk({ groupId: id })}
                fixed={[
                  { label: '＋ New canonical', onSelect: () => bulk('new') },
                ]}
                trigger={
                  <button
                    type="button"
                    className="rounded-full border border-line px-3 py-1 text-[12.5px] hover:border-sage-line"
                  >
                    Move to canonical…
                  </button>
                }
              />
              <button
                type="button"
                onClick={() => bulk(meta.bulkDest)}
                className="rounded-full border border-line px-3 py-1 text-[12.5px] hover:border-sage-line"
              >
                {meta.bulkLabel}
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-[12px] text-faint hover:text-text"
              >
                Deselect all
              </button>
            </div>
          )}

          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${visible.length} tags…`}
            className="mb-3 w-full rounded-[9px] border border-line bg-ground px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:border-sage"
          />

          <div className="flex flex-wrap gap-1.5">
            {shown.map((variant) =>
              selecting ? (
                <button
                  key={variant.tag}
                  type="button"
                  onClick={() => toggle(variant)}
                  className={cn(
                    'inline-flex h-[26px] items-center gap-1.5 rounded-full border bg-ground pr-2 pl-2.5 text-[12.5px]',
                    meta.chip,
                    selected.has(variant) && 'ring-2 ring-sage',
                  )}
                >
                  <span>{variant.tag}</span>
                  <span className="font-mono text-[11px] opacity-70">
                    {variant.count}
                  </span>
                </button>
              ) : (
                <ChipMoveMenu
                  key={variant.tag}
                  groups={targets}
                  onPickGroup={(id) => onMove(variant, kind, { groupId: id })}
                  fixed={meta.single((dest) => onMove(variant, kind, dest))}
                  trigger={
                    <button
                      type="button"
                      className={cn(
                        'inline-flex h-[26px] items-center gap-1.5 rounded-full border bg-ground pr-2.5 pl-2.5 text-[12.5px] hover:brightness-125',
                        meta.chip,
                      )}
                    >
                      <span>{variant.tag}</span>
                      <span className="font-mono text-[11px] opacity-70">
                        {variant.count}
                      </span>
                    </button>
                  }
                />
              ),
            )}
          </div>
        </>
      )}
    </div>
  )
}
