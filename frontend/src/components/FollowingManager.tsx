import { useMemo, useState } from 'react'
import { Users, X } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverHeading,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useChubFollows, useDatacatFollows } from '@/hooks/use-discover'
import type { ChubAuth } from '@/lib/providers/chub'
import type { Provider } from '@/lib/discover-state'
import { toast } from '@/lib/toast'

/**
 * The followed-creator list, managed where you actually use it.
 *
 * Both providers declare `supportsFollowingManager` in `web/`
 * (`browse-view.js:1285-1592`) and both had one; the rewrite put DataCat's list
 * in Settings and gave Chub's no surface at all, which means following someone
 * you just found meant leaving the page you found them on.
 *
 * The two halves are asymmetric on purpose, and that is a decision rather than
 * an omission: Chub's follows live in a real account and are managed on chub.ai,
 * so this only reads them. DataCat has no accounts, so its list is settings data
 * this app owns outright — add and remove are real here.
 */
export function FollowingManager({
  provider,
  auth,
  onBrowseCreator,
}: {
  provider: Provider
  auth: ChubAuth
  /** Jump the grid to that creator's catalogue. */
  onBrowseCreator: (id: string, name: string) => void
}) {
  const [filter, setFilter] = useState('')
  const [entry, setEntry] = useState('')
  const chub = useChubFollows(auth)
  const datacat = useDatacatFollows()

  const rows = useMemo(() => {
    const all =
      provider === 'chub'
        ? (chub.data ?? []).map((c) => ({ id: c.username, name: c.name }))
        : datacat.creators.map((c) => ({ id: c.id, name: c.name }))
    const needle = filter.trim().toLowerCase()
    const matched = needle
      ? all.filter((c) => c.name.toLowerCase().includes(needle))
      : all
    return [...matched].sort((a, b) => a.name.localeCompare(b.name))
  }, [provider, chub.data, datacat.creators, filter])

  return (
    <Popover>
      <PopoverTrigger className="inline-flex flex-none items-center gap-[6px] rounded-full border border-line px-3 py-1.5 text-[13px] text-muted-foreground hover:border-white/20 hover:text-text">
        <Users className="size-3.5" />
        Following
        <span className="font-mono text-[11.5px] text-faint">
          {rows.length}
        </span>
      </PopoverTrigger>
      <PopoverContent className="max-h-[70vh] w-[320px] overflow-y-auto">
        <PopoverHeading>
          {provider === 'chub' ? 'Followed on Chub' : 'Followed on DataCat'}
        </PopoverHeading>

        {provider === 'datacat' && (
          <form
            className="flex gap-1.5 px-1 pt-1 pb-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!entry.trim()) return
              datacat.follow.mutate(entry, {
                onSuccess: (row) => {
                  toast(`Following ${row.name}.`)
                  setEntry('')
                },
                onError: (error) => toast(error.message, 'bad'),
              })
            }}
          >
            <input
              value={entry}
              onChange={(event) => setEntry(event.target.value)}
              placeholder="Creator id or profile URL…"
              className="h-[30px] min-w-0 flex-1 rounded-lg border border-line bg-ground px-2.5 text-[12.5px] outline-none focus:border-sage"
            />
            <button
              type="submit"
              disabled={datacat.follow.isPending}
              className="h-[30px] rounded-lg border border-sage bg-sage px-2.5 text-[12.5px] font-semibold text-on-sage disabled:opacity-60"
            >
              Follow
            </button>
          </form>
        )}

        {rows.length > 6 && (
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a creator…"
            className="mx-1 mb-1.5 h-[30px] w-[calc(100%-8px)] rounded-lg border border-line bg-ground px-2.5 text-[12.5px] outline-none focus:border-sage"
          />
        )}

        {provider === 'chub' && !auth.token && (
          <p className="px-2.5 py-3 text-[12.5px] leading-[1.55] text-faint">
            Add your Chub token in Settings → Providers to see who you follow.
            Following and unfollowing stay on chub.ai.
          </p>
        )}

        {rows.length === 0 && (provider !== 'chub' || !!auth.token) && (
          <p className="px-2.5 py-3 text-[12.5px] text-faint">
            {chub.isPending && provider === 'chub'
              ? 'reading your follows…'
              : 'Nobody yet.'}
          </p>
        )}

        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-center gap-1.5 rounded-[9px] px-1 hover:bg-raised"
          >
            <button
              type="button"
              onClick={() => onBrowseCreator(row.id, row.name)}
              className="min-w-0 flex-1 truncate py-2 pl-1.5 text-left text-[13.5px] hover:text-sage"
            >
              {row.name}
            </button>
            {provider === 'datacat' && (
              <button
                type="button"
                title={`Unfollow ${row.name}`}
                onClick={() =>
                  datacat.unfollow.mutate(row.id, {
                    onSuccess: () => toast(`Unfollowed ${row.name}.`),
                  })
                }
                className="grid size-6 shrink-0 place-items-center rounded-md text-faint hover:bg-white/8 hover:text-bad"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}
