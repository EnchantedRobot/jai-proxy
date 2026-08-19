import { useRef } from 'react'
import { useNavigate } from 'react-router'
import { FolderUp, Plus, Search, Upload } from 'lucide-react'
import { useImportCharacters } from '@/hooks/use-card-mutations'
import { toast } from '@/lib/toast'
import {
  Popover,
  PopoverContent,
  PopoverHeading,
  PopoverItem,
  PopoverSeparator,
  PopoverTrigger,
} from '@/components/ui/popover'

/**
 * The top bar's Add-to-archive menu.
 *
 * Only the doors that have something behind them today (docs/UI_REWRITE_PLAN.md
 * §3.10): upload PNGs, upload a folder of them, and jump to provider search.
 * Import-from-URL and bundle restore are deferred and deliberately absent rather
 * than shown as dead rows. A folder is just a multi-file pick with
 * `webkitdirectory` — the browser cannot hand over a directory any other way.
 */
export function ImportPopover() {
  const navigate = useNavigate()
  const importCards = useImportCharacters()
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  const onFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const all = Array.from(event.target.files ?? [])
    event.target.value = ''
    // A folder pick sweeps in everything; keep only the card PNGs.
    const files = all.filter((f) => /\.png$/i.test(f.name))
    if (files.length === 0) {
      if (all.length) toast('No PNG cards in that selection.', 'bad')
      return
    }
    importCards.mutate(
      { files, onDuplicate: 'skip' },
      {
        onSuccess: (results) => {
          const imported = results.filter(
            (r) => r.result && !r.result.duplicate,
          ).length
          const duplicate = results.filter((r) => r.result?.duplicate).length
          const failed = results.filter((r) => r.error)
          const parts: string[] = []
          if (imported) parts.push(`${imported} added`)
          if (duplicate) parts.push(`${duplicate} already here`)
          if (failed.length) parts.push(`${failed.length} failed`)
          toast(
            `Import: ${parts.join(', ') || 'nothing to do'}.`,
            failed.length ? 'bad' : 'ok',
          )
          for (const f of failed) toast(`${f.file}: ${f.error}`, 'bad')
        },
        onError: (error) => toast(error.message, 'bad'),
      },
    )
  }

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Import"
            className="grid size-[35px] place-items-center rounded-full border border-white/7 text-muted-foreground hover:border-white/17 hover:bg-raised hover:text-text disabled:opacity-60"
            disabled={importCards.isPending}
          >
            <Plus className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[266px]">
          <PopoverHeading>Add to the archive</PopoverHeading>
          <PopoverItem onClick={() => fileRef.current?.click()}>
            <Upload className="size-4 text-faint" />
            {importCards.isPending ? 'Importing…' : 'Upload PNG cards…'}
          </PopoverItem>
          <PopoverItem onClick={() => folderRef.current?.click()}>
            <FolderUp className="size-4 text-faint" />
            Import a folder…
          </PopoverItem>
          <PopoverSeparator />
          <PopoverItem onClick={() => navigate('/discover')}>
            <Search className="size-4 text-faint" />
            Search providers…
          </PopoverItem>
        </PopoverContent>
      </Popover>

      <input
        ref={fileRef}
        type="file"
        accept="image/png"
        multiple
        hidden
        onChange={onFiles}
      />
      <input
        ref={folderRef}
        type="file"
        hidden
        onChange={onFiles}
        // Non-standard but universally supported; typed loosely to satisfy TS.
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
      />
    </>
  )
}
