import { Link, useLocation } from 'react-router'
import { GitFork, Star } from 'lucide-react'
import type { Card } from '@/lib/browse'
import { cn } from '@/lib/utils'

/**
 * One card in the grid: portrait, name, creator, and the two badges the mock
 * puts on the art — lore-entry count (or greeting count, when there is no
 * lorebook) and the star.
 *
 * The whole tile is a link, so middle-click and ⌘-click open a card in a new
 * tab. Deep links are the point of the SPA fallback; a div with an onClick
 * would throw that away for every card in the archive.
 */
export function CardTile({
  card,
  isNew,
  search,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Link>, 'to'> & {
  card: Card
  isNew?: boolean
  /** The browse querystring to carry onto the link, so the detail page can
   *  rebuild the set this tile belonged to for prev/next. Defaults to the
   *  current URL's — surfaces with their own ordering (the recently-added
   *  shelf) pass theirs, which the page's filters would not otherwise capture. */
  search?: string
}) {
  const location = useLocation()
  const linkSearch = search ?? location.search
  const badge = card.lore_entries
    ? `${card.lore_entries} lore`
    : card.greetings > 1
      ? `${card.greetings} greetings`
      : null

  return (
    <Link
      to={{
        pathname: `/characters/${encodeURIComponent(card.id)}`,
        search: linkSearch,
      }}
      className={cn('group block', className)}
      {...props}
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl border border-line-soft bg-raised group-hover:border-sage-line">
        {badge && (
          <span
            className={cn(
              'absolute top-[7px] left-[7px] z-2 rounded-[7px] border border-white/12 bg-ground/78 px-[7px] py-0.5 text-[10.5px] backdrop-blur-[6px]',
              card.lore_entries ? 'border-sage-line text-sage' : 'text-text',
            )}
          >
            {badge}
          </span>
        )}
        {card.favorite && (
          <span className="absolute top-1.5 right-1.5 z-2 grid size-6 place-items-center rounded-[7px] bg-ground/72 text-sage backdrop-blur-[6px]">
            <Star className="size-3.5 fill-current" />
          </span>
        )}
        {isNew && (
          <span className="absolute bottom-[7px] left-[7px] z-2 rounded-md bg-sage px-1.5 py-px text-[10px] font-bold tracking-[0.08em] text-on-sage uppercase">
            new
          </span>
        )}
        {card.is_fork && (
          <span
            title="Fork"
            className="absolute right-1.5 bottom-1.5 z-2 grid size-6 place-items-center rounded-[7px] bg-ground/72 text-faint backdrop-blur-[6px]"
          >
            <GitFork className="size-3.5" />
          </span>
        )}
        <img
          // The grid track's min width is 158px (CardGrid) and tiles routinely
          // render wider than that as auto-fill stretches the last column, so
          // the inherited 96x144 avatar cache -- built for a much smaller old-UI
          // tile -- upscales visibly. 560 is roughly 2x a typical rendered
          // height, the same retina-margin CharacterDetailPage uses for the
          // portrait.
          src={`${card.thumb_url}?size=560`}
          alt=""
          loading="lazy"
          className="size-full object-cover transition-transform duration-[450ms] ease-[cubic-bezier(.2,.7,.3,1)] group-hover:scale-105"
        />
        {/* The gradient the mock lays over the bottom of every tile, so a
            light-coloured portrait does not fight the name beneath it. */}
        <span className="pointer-events-none absolute inset-0 shadow-[inset_0_-54px_44px_-30px_#0f1113de]" />
      </div>
      <h3 className="mt-2 line-clamp-2 text-[13.5px] leading-[1.3] font-medium">
        {card.name}
      </h3>
      <div className="mt-px truncate text-[11.5px] text-faint">
        {card.creator || 'unknown'}
      </div>
    </Link>
  )
}
