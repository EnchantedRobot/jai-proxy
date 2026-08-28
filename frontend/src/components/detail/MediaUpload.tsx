import { useRef, useState } from 'react'
import { FileArchive, ImagePlus, Loader2 } from 'lucide-react'
import { useUploadMedia, type MediaKind } from '@/hooks/use-media-upload'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

/**
 * Putting images into a card's gallery or expressions folder by hand
 * (docs/FORKS_AND_EXTRAS_PLAN.md §9) — a drop zone that is also a file
 * picker, plus the report of what landed.
 *
 * Rendered by both media panes, including in their empty states: a folder
 * with nothing in it is exactly where a first import happens, and before this
 * existed there was no way to put an image in at all except by having the
 * card mention its URL.
 *
 * Every file is re-encoded to WebP server-side, so nothing here inspects or
 * converts bytes; the client's only job is to hand them over and say what came
 * back.
 */
export function MediaUpload({
  kind,
  folder,
  zip = false,
}: {
  kind: MediaKind
  folder: string | undefined
  /** Offer a `.zip` as well as loose images — expression packs are shipped
   *  that way, and it is the shape `Download all` writes. */
  zip?: boolean
}) {
  const upload = useUploadMedia(kind, folder)
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const send = (files: FileList | null) => {
    const list = files ? Array.from(files) : []
    if (list.length === 0) return
    upload.mutate(list, {
      onError: (error) => toast(error.message, 'bad'),
    })
  }

  const noun = kind === 'expressions' ? 'sprites' : 'images'
  const result = upload.data

  return (
    <div className="mb-4">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          send(event.dataTransfer.files)
        }}
        className={cn(
          'flex items-center gap-3 rounded-xl border border-dashed px-[13px] py-[11px] text-[13px]',
          over ? 'border-sage-line bg-sage-dim' : 'border-line',
        )}
      >
        {upload.isPending ? (
          <Loader2 className="size-4 flex-none animate-spin text-sage" />
        ) : (
          <ImagePlus className="size-4 flex-none text-faint" />
        )}
        <span className="text-muted">
          {upload.isPending
            ? `Uploading ${noun}…`
            : `Drop ${noun} here${zip ? ' — loose files or a .zip pack' : ''}`}
        </span>
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={upload.isPending}
          className="ml-auto flex h-7 items-center gap-1.5 rounded-lg border border-line px-3 text-[12.5px] text-muted hover:border-sage-line hover:text-sage disabled:opacity-60"
        >
          {zip && <FileArchive className="size-3.5" />}
          Choose files
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={zip ? 'image/*,.zip,application/zip' : 'image/*'}
          className="hidden"
          onChange={(event) => {
            send(event.target.files)
            // Same file twice in a row must fire `change` the second time.
            event.target.value = ''
          }}
        />
      </div>
      {result && (
        <UploadReport result={result} onDismiss={() => upload.reset()} />
      )}
    </div>
  )
}

function UploadReport({
  result,
  onDismiss,
}: {
  result: NonNullable<ReturnType<typeof useUploadMedia>['data']>
  onDismiss: () => void
}) {
  const added = result.written.filter((file) => !file.replaced).length
  const replaced = result.written.length - added
  const parts = [
    `${added} added`,
    replaced ? `${replaced} replaced` : null,
    result.skipped.length ? `${result.skipped.length} skipped` : null,
  ].filter(Boolean)

  return (
    <div
      className={cn(
        'mt-2 rounded-xl border px-[13px] py-[11px] text-[13px]',
        result.skipped.length
          ? 'border-line-soft bg-surface'
          : 'border-sage-line bg-sage-dim',
      )}
    >
      <div className="flex items-center gap-3">
        <span>{`${parts.join(' · ')}.`}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto text-[12.5px] text-faint hover:text-text"
        >
          dismiss
        </button>
      </div>
      {result.skipped.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-[12.5px] text-faint">
          {result.skipped.map((file) => (
            <li key={file.name}>
              <span className="text-muted">{file.name}</span> — {file.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
