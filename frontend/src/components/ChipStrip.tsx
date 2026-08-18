import { X } from 'lucide-react'
import {
  FLAG_LABELS,
  PRESET_FLAGS,
  type BrowseState,
  type Flag,
  type TagMode,
} from '@/lib/browse'
import { cn } from '@/lib/utils'
import { FilterPopover } from './FilterPopover'

/**
 * The mock's one filter surface. It replaces the old UI's 726-line advanced
 * filter builder, and the expressiveness lost with it (nested AND/OR groups) is
 * a decision, not an oversight — docs/UI_REWRITE_PLAN.md §1.1.
 *
 * Two kinds of chip live here. Preset chips are always shown, on or off. Chips
 * the user added from the ＋ Filter popover are shown only while they are
 * active, and carry an ✕ that removes them outright — otherwise a tag chosen
 * once would sit in the strip forever.
 */
export function ChipStrip({
  state,
  onChange,
  pinned = [],
}: {
  state: BrowseState
  onChange: (next: BrowseState) => void
  /**
   * Flags the route itself applies, so the strip must not offer to turn them
   * off. `/favorites` is the case: the tab *is* the filter, and a Favorites
   * chip beside it would be a control that cannot be switched off.
   */
  pinned?: Flag[]
}) {
  const setFlag = (flag: Flag) => {
    const flags = new Set(state.flags)
    if (!flags.delete(flag)) flags.add(flag)
    onChange({ ...state, flags })
  }

  // Include → exclude → gone. The same cycle in the popover and in the strip,
  // because they are the same chip in two places.
  const cycleTag = (tag: string) => {
    const tags = new Map(state.tags)
    const current = tags.get(tag)
    if (!current) tags.set(tag, 'inc')
    else if (current === 'inc') tags.set(tag, 'exc')
    else tags.delete(tag)
    onChange({ ...state, tags })
  }

  const dropTag = (tag: string) => {
    const tags = new Map(state.tags)
    tags.delete(tag)
    onChange({ ...state, tags })
  }

  // "All" clears what the user chose, not what the route pinned.
  const clearAll = () =>
    onChange({ ...state, flags: new Set(pinned), tags: new Map(), q: '' })

  const userFiltered =
    state.tags.size > 0 ||
    state.q !== '' ||
    [...state.flags].some((f) => !pinned.includes(f))

  const presetFlags = PRESET_FLAGS.filter((f) => !pinned.includes(f))
  const extraFlags = [...state.flags].filter(
    (f) => !PRESET_FLAGS.includes(f) && !pinned.includes(f),
  )

  return (
    <div className="flex min-w-0 flex-[0_1_auto] items-center gap-1.5 overflow-x-auto rounded-full border border-white/6 bg-white/3 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <Chip on={!userFiltered} onClick={clearAll}>
        All
      </Chip>

      {presetFlags.map((flag) => (
        <Chip
          key={flag}
          on={state.flags.has(flag)}
          onClick={() => setFlag(flag)}
        >
          {FLAG_LABELS[flag]}
        </Chip>
      ))}

      {extraFlags.map((flag) => (
        <Chip key={flag} on onClick={() => setFlag(flag)}>
          {FLAG_LABELS[flag]}
          <Remove label={FLAG_LABELS[flag]} onRemove={() => setFlag(flag)} />
        </Chip>
      ))}

      {[...state.tags].map(([tag, mode]) => (
        <Chip key={tag} on mode={mode} onClick={() => cycleTag(tag)}>
          {mode === 'exc' && '− '}
          {tag}
          <Remove label={tag} onRemove={() => dropTag(tag)} />
        </Chip>
      ))}

      <FilterPopover state={state} onChange={onChange} pinned={pinned} />
    </div>
  )
}

function Chip({
  on,
  mode,
  className,
  ...props
}: React.ComponentProps<'button'> & { on?: boolean; mode?: TagMode }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-[30px] flex-none items-center gap-[7px] rounded-full border border-transparent px-3.5 text-[13px] text-muted-foreground hover:bg-white/5 hover:text-text',
        on && 'border-sage-line bg-sage-dim text-sage hover:bg-sage-dim',
        on &&
          mode === 'exc' &&
          'border-bad/30 bg-bad/12 text-bad hover:bg-bad/12',
        className,
      )}
      {...props}
    />
  )
}

/**
 * The ✕ inside a chip. A `<span role="button">` rather than a nested `<button>`
 * — HTML forbids a button inside a button, and React renders it anyway, so the
 * bug would be a silently invalid tree rather than an error.
 */
function Remove({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Remove ${label} filter`}
      className="opacity-65 hover:opacity-100"
      onClick={(event) => {
        event.stopPropagation()
        onRemove()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        onRemove()
      }}
    >
      <X className="size-3" />
    </span>
  )
}
