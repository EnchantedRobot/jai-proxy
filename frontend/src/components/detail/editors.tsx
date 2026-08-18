import { useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { LoreEntry } from '@/lib/card'
import { cn } from '@/lib/utils'

/**
 * A textarea styled like the `ProseBox` it replaces, so entering edit mode does
 * not move the prose. Grows with its content — a greeting can be long, and a
 * fixed height either clips it or wastes the page.
 */
export function InlineTextField({
  value,
  onChange,
  placeholder,
  className,
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }
  return (
    <textarea
      ref={(el) => {
        ref.current = el
        grow(el)
      }}
      value={value}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(e) => {
        onChange(e.target.value)
        grow(e.target)
      }}
      className={cn(
        'mt-2.5 w-full resize-none rounded-xl border border-sage-line bg-surface px-[17px] py-[15px] text-[14.5px] leading-[1.68] text-[#e6ebed] outline-none focus:border-sage',
        className,
      )}
    />
  )
}

/**
 * The tag row as an editor: each tag a chip with a remove ×, plus an input that
 * commits on Enter or comma. Backspace on the empty input lifts the last chip,
 * the ordinary quick-delete.
 */
export function InlineTagEditor({
  tags,
  onChange,
}: {
  tags: string[]
  onChange: (tags: string[]) => void
}) {
  const [draft, setDraft] = useState('')

  const commit = (raw: string) => {
    const tag = raw.trim().replace(/,$/, '').trim()
    setDraft('')
    if (!tag) return
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return
    onChange([...tags, tag])
  }

  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5 rounded-xl border border-sage-line bg-surface p-2.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-raised py-1 pr-1 pl-2.5 text-[12px] text-[#c3cacd]"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            className="grid size-4 place-items-center rounded text-faint hover:bg-line hover:text-text"
            aria-label={`Remove ${tag}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit(draft)
          } else if (e.key === 'Backspace' && draft === '' && tags.length) {
            onChange(tags.slice(0, -1))
          }
        }}
        onBlur={() => draft && commit(draft)}
        placeholder="Add a tag…"
        className="min-w-[120px] flex-1 bg-transparent px-1.5 py-1 text-[12px] text-text outline-none placeholder:text-faint"
      />
    </div>
  )
}

/**
 * The lorebook editor: one card per entry with its trigger keys and content,
 * add and remove. Reordering and the entries' advanced routing (`position`,
 * `probability`, `selectiveLogic`) are left untouched — `setLoreEntries` merges
 * these edits onto the raw entry, so those fields survive a save unread.
 */
export function LoreEntryEditor({
  entries,
  onChange,
}: {
  entries: LoreEntry[]
  onChange: (entries: LoreEntry[]) => void
}) {
  const patch = (index: number, next: Partial<LoreEntry>) =>
    onChange(entries.map((e, i) => (i === index ? { ...e, ...next } : e)))

  const add = () =>
    onChange([
      ...entries,
      {
        id: (entries.at(-1)?.id ?? -1) + 1,
        keys: [],
        secondaryKeys: [],
        content: '',
        comment: '',
        enabled: true,
        constant: false,
        insertionOrder: entries.length,
      },
    ])

  return (
    <div className="mt-2.5 flex flex-col gap-2.5">
      {entries.map((entry, index) => (
        <div
          key={index}
          className="rounded-xl border border-sage-line bg-surface p-3"
        >
          <div className="flex items-center gap-2.5">
            <input
              value={entry.keys.join(', ')}
              onChange={(e) =>
                patch(index, {
                  keys: e.target.value
                    .split(',')
                    .map((k) => k.trim())
                    .filter(Boolean),
                })
              }
              placeholder="trigger keys, comma-separated"
              className="flex-1 rounded-lg border border-line bg-raised px-2.5 py-1.5 font-mono text-[11.5px] text-sage outline-none focus:border-sage"
            />
            <button
              type="button"
              onClick={() => onChange(entries.filter((_, i) => i !== index))}
              className="grid size-7 flex-none place-items-center rounded-lg border border-line text-faint hover:border-bad/50 hover:text-bad"
              aria-label="Remove entry"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <textarea
            value={entry.content}
            onChange={(e) => patch(index, { content: e.target.value })}
            placeholder="Entry text…"
            rows={3}
            className="mt-2 w-full resize-y rounded-lg border border-line bg-raised px-2.5 py-2 text-[13px] leading-[1.6] text-[#c3cacd] outline-none focus:border-sage"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-line py-2.5 text-[12.5px] text-muted hover:border-sage-line hover:text-sage"
      >
        <Plus className="size-3.5" /> Add entry
      </button>
    </div>
  )
}
