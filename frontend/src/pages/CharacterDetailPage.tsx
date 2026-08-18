import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ArrowLeft, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import {
  useCharacterDetail,
  type CardDetail,
} from '@/hooks/use-character-detail'
import { useCharacters } from '@/hooks/use-characters'
import { readState } from '@/lib/browse'
import { sourceLabel, formatDate, formatBytes } from '@/lib/card'
import { cn } from '@/lib/utils'
import {
  GalleryPane,
  InfoPane,
  GreetingsPane,
  LorebookPane,
  NotesPane,
  OverviewPane,
  RelatedPane,
} from '@/components/detail/panes'
import { EditProvider } from '@/components/detail/edit-context'
import { HeaderTags } from '@/components/detail/HeaderTags'
import { PortraitActions } from '@/components/detail/PortraitActions'
import { PANES, type Pane } from '@/components/detail/panes-def'

const TAB_LABELS: Record<Pane, string> = {
  overview: 'Overview',
  notes: 'Creator notes',
  greetings: 'Greetings',
  lore: 'Lorebook',
  gallery: 'Gallery',
  related: 'Related',
  info: 'Info',
}

/**
 * The full-page card detail: a blurred hero, a sticky portrait column with its
 * actions, and the seven tabbed panes (docs/UI_REWRITE_PLAN.md §4.5).
 *
 * The active tab lives in `?tab=` so a pane is deep-linkable; every other query
 * param is the browse filter this card was opened from, carried in by the tile
 * link so prev/next can step through the same filtered set the grid showed.
 */
export function CharacterDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()

  const detail = useCharacterDetail(id)
  // A local cache-bust bumped only when the avatar is replaced. The portrait URL
  // is stable across an avatar swap (same filename, new pixels), and the browser
  // would otherwise keep showing the old face; a field edit or a favourite must
  // not trigger it, which is why it is a deliberate counter, not the ETag.
  const [avatarBust, setAvatarBust] = useState(0)

  // The neighbour list: the same query the grid ran, read from the filter
  // params carried in on the URL. TanStack Query serves it from cache when the
  // user came from the grid, and fetches page 0 on a cold deep link.
  const browseState = readState(params)
  const neighbours = useCharacters(browseState)
  // Memoized so the go() callback's identity is stable between renders that did
  // not change the page — flatMap makes a new array every render otherwise.
  const cards = useMemo(
    () => neighbours.data?.pages.flatMap((page) => page.items) ?? [],
    [neighbours.data],
  )
  const position = cards.findIndex((card) => card.id === id)

  const activeTab = (params.get('tab') as Pane) ?? 'overview'
  const setTab = (tab: Pane) => {
    const next = new URLSearchParams(params)
    if (tab === 'overview') next.delete('tab')
    else next.set('tab', tab)
    setParams(next, { replace: true })
  }

  const go = useCallback(
    (delta: number) => {
      if (position < 0) return
      const target = cards[position + delta]
      if (target) {
        const next = new URLSearchParams(params)
        next.delete('tab')
        navigate(
          {
            pathname: `/characters/${encodeURIComponent(target.id)}`,
            search: next.toString(),
          },
          { replace: true },
        )
      } else if (delta > 0 && neighbours.hasNextPage) {
        // The neighbour is on a page not yet fetched — pull it, then the effect
        // below runs again with a longer list.
        void neighbours.fetchNextPage()
      }
    },
    [position, cards, params, navigate, neighbours],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'j') go(1)
      else if (event.key === 'k') go(-1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [go])

  if (detail.isPending)
    return <p className="py-24 text-center text-faint">reading card…</p>
  if (detail.error)
    return <p className="py-24 text-center text-bad">{detail.error.message}</p>

  const { card, etag } = detail.data
  const thumb = avatarBust
    ? `${card.thumb_url}?v=${avatarBust}`
    : card.thumb_url
  const backSearch = new URLSearchParams(params)
  backSearch.delete('tab')

  return (
    <>
      <div className="sticky top-0 z-20 flex items-center gap-2.5 border-b border-line-soft bg-ground/85 px-5 py-[11px] backdrop-blur-[12px]">
        <Link
          to={{ pathname: '/', search: backSearch.toString() }}
          className="flex h-8 items-center gap-2 rounded-[10px] border border-line px-3 text-[13px] hover:bg-raised"
        >
          <ArrowLeft className="size-4" /> Back
        </Link>
        <span className="text-[12.5px] text-faint">Characters</span>
        <div className="ml-auto flex items-center gap-1.5">
          {position >= 0 && (
            <span className="font-mono text-[12.5px] text-faint">
              {position + 1} of{' '}
              {neighbours.data?.pages[0]?.total ?? cards.length}
            </span>
          )}
          <NavArrow onClick={() => go(-1)} disabled={position <= 0}>
            <ChevronLeft className="size-4" />
          </NavArrow>
          <NavArrow
            onClick={() => go(1)}
            disabled={
              position < 0 ||
              (position >= cards.length - 1 && !neighbours.hasNextPage)
            }
          >
            <ChevronRight className="size-4" />
          </NavArrow>
        </div>
      </div>

      <div className="relative overflow-hidden pt-[34px]">
        <div
          className="absolute -inset-10 bg-cover bg-center opacity-30 blur-[46px] saturate-125"
          style={{ backgroundImage: `url(${thumb})` }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-ground/70 to-ground" />
        <EditProvider id={card.id} data={card.card} etag={etag}>
          <div className="relative z-2 mx-auto grid max-w-[1240px] grid-cols-1 gap-[34px] px-5 md:grid-cols-[min(280px,25vw)_1fr]">
            <div className="flex flex-col gap-2.5 md:sticky md:top-[76px] md:self-start">
              <img
                src={thumb}
                alt={card.name}
                className="aspect-[2/3] w-full rounded-[15px] border border-line object-cover shadow-[0_24px_60px_#00000080]"
              />
              <a
                href={card.png_url}
                className="flex h-[38px] items-center justify-center gap-2 rounded-[10px] border border-sage bg-sage text-[13.5px] font-semibold text-on-sage hover:bg-[#68d0b1]"
                download
              >
                <Download className="size-4" /> Download card
              </a>
              <PortraitActions
                card={card}
                etag={etag}
                onAvatarReplaced={() => setAvatarBust((n) => n + 1)}
              />
            </div>

            <div>
              <h1 className="font-serif text-[clamp(30px,4.2vw,50px)] leading-[1.05] font-normal text-balance">
                {card.name}
              </h1>
              <div className="mt-2.5 flex flex-wrap items-center gap-2.5 text-[13.5px] text-muted">
                by{' '}
                <span className="text-sage">{card.creator || 'unknown'}</span>
                <Sep />{' '}
                <span className="font-mono">
                  {formatDate(card.create_date)}
                </span>
                <Sep /> {sourceLabel(card.source_kind)}
                <Sep />{' '}
                <span className="font-mono">{formatBytes(card.size)}</span>
              </div>

              <HeaderTags card={card} />

              <nav className="mt-6 flex gap-5 overflow-x-auto border-b border-line">
                {PANES.map((pane) => (
                  <button
                    key={pane}
                    type="button"
                    onClick={() => setTab(pane)}
                    className={cn(
                      '-mb-px border-b-2 border-transparent py-2.5 text-[13.5px] whitespace-nowrap text-muted hover:text-text',
                      activeTab === pane &&
                        'border-sage font-semibold text-text',
                    )}
                  >
                    {TAB_LABELS[pane]}
                    <PaneCount pane={pane} card={card} />
                  </button>
                ))}
              </nav>

              <div className="flex max-w-[80ch] flex-col gap-6 pt-[22px] pb-[90px]">
                {activeTab === 'overview' && <OverviewPane card={card} />}
                {activeTab === 'notes' && <NotesPane card={card} />}
                {activeTab === 'greetings' && <GreetingsPane card={card} />}
                {activeTab === 'lore' && <LorebookPane card={card} />}
                {activeTab === 'gallery' && <GalleryPane card={card} />}
                {activeTab === 'related' && <RelatedPane card={card} />}
                {activeTab === 'info' && <InfoPane card={card} />}
              </div>
            </div>
          </div>
        </EditProvider>
      </div>
    </>
  )
}

function PaneCount({ pane, card }: { pane: Pane; card: CardDetail }) {
  const count =
    pane === 'greetings'
      ? card.greetings
      : pane === 'lore'
        ? card.lore_entries
        : 0
  if (!count) return null
  return <span className="ml-1.5 text-[11px] text-faint">{count}</span>
}

function NavArrow({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="grid size-8 place-items-center rounded-lg border border-line text-muted hover:bg-raised disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

function Sep() {
  return <span className="text-faint">·</span>
}
