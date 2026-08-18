import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ImageUp, MoreHorizontal, Star, Trash2 } from 'lucide-react'
import type { CardDetail } from '@/hooks/use-character-detail'
import {
  useDeleteCharacter,
  useReplaceAvatar,
  useSetFavorite,
} from '@/hooks/use-card-mutations'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/**
 * The portrait's own actions: favourite, replace image, and the More menu whose
 * only live item is Delete (Duplicate has no endpoint and Export is the Download
 * button above — docs/UI_REWRITE_PLAN.md §3.12). These sit outside the section
 * edit model: a star is a targeted write, and the avatar is a separate endpoint.
 */
export function PortraitActions({
  card,
  etag,
  onAvatarReplaced,
}: {
  card: CardDetail
  etag: string | null
  onAvatarReplaced: () => void
}) {
  const navigate = useNavigate()
  const favorite = useSetFavorite(card.id)
  const avatar = useReplaceAvatar(card.id)
  const remove = useDeleteCharacter(card.id)
  const fileRef = useRef<HTMLInputElement>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [alsoGallery, setAlsoGallery] = useState(false)

  const onFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = '' // let the same file be picked again after a failure
    if (!file) return
    avatar.mutate(
      { file, etag },
      {
        onSuccess: () => {
          toast('Portrait replaced.')
          onAvatarReplaced()
        },
        onError: (error) => toast(error.message, 'bad'),
      },
    )
  }

  const onDelete = () =>
    remove.mutate(alsoGallery ? 'delete' : 'keep', {
      onSuccess: () => {
        toast(`Moved “${card.name}” to the bin.`)
        navigate('/')
      },
      onError: (error) => toast(error.message, 'bad'),
    })

  return (
    <>
      <button
        type="button"
        onClick={() => favorite.mutate(!card.favorite)}
        className={cn(
          'flex h-[38px] items-center justify-center gap-2 rounded-[10px] border text-[13.5px] font-medium hover:bg-raised',
          card.favorite
            ? 'border-sage-line text-sage'
            : 'border-line text-text',
        )}
      >
        <Star className={cn('size-4', card.favorite && 'fill-current')} />
        {card.favorite ? 'Favourited' : 'Favourite'}
      </button>

      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={avatar.isPending}
        className="flex h-[38px] items-center justify-center gap-2 rounded-[10px] border border-line text-[13.5px] font-medium text-text hover:bg-raised disabled:opacity-60"
      >
        <ImageUp className="size-4" />
        {avatar.isPending ? 'Replacing…' : 'Replace image'}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={onFile}
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-[34px] items-center justify-center gap-2 rounded-[10px] text-[12.5px] text-faint hover:bg-raised hover:text-text"
          >
            <MoreHorizontal className="size-4" /> More
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="min-w-[200px]">
          <DropdownMenuItem
            destructive
            onSelect={() => {
              setAlsoGallery(false)
              setConfirmOpen(true)
            }}
          >
            <Trash2 className="size-4" /> Delete card
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete “{card.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            The card is moved to the bin, not erased — it can be recovered from{' '}
            <span className="font-mono">data/.trash/</span> until the bin is
            emptied.
          </AlertDialogDescription>
          {card.gallery.exists && (
            <label className="mt-3.5 flex items-center gap-2.5 rounded-lg border border-line-soft bg-raised px-3 py-2.5 text-[13px]">
              <input
                type="checkbox"
                checked={alsoGallery}
                onChange={(e) => setAlsoGallery(e.target.checked)}
                className="size-4 accent-[var(--sage)]"
              />
              Delete its gallery folder too
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <button
                type="button"
                className="rounded-[10px] border border-line px-3.5 py-2 text-[13px] hover:bg-raised"
              >
                Cancel
              </button>
            </AlertDialogCancel>
            <AlertDialogAction asChild>
              <button
                type="button"
                onClick={onDelete}
                disabled={remove.isPending}
                className="rounded-[10px] border border-bad bg-bad/90 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-bad disabled:opacity-60"
              >
                {remove.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
