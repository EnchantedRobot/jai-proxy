import { useEffect, useRef, useState } from 'react'
import { Download, ImageDown, Loader2 } from 'lucide-react'
import {
  useInvalidateMediaCaches,
  useMediaJobStatus,
  useScanCharacterMedia,
  useSubmitDiscoveredMedia,
} from '@/hooks/use-media-discovery'
import { describeScan } from '@/lib/media-scan'
import { toast } from '@/lib/toast'

/**
 * The scan/job UI docs/UI_REWRITE_PLAN.md §3.4 describes: trigger a scan,
 * show the count, trigger a job, poll it, render progress. Shown at the top
 * of the Gallery pane whether or not a gallery exists yet — the common real
 * case is a card with no folder on disk (§3.3's "never downloaded").
 */
export function MediaDiscovery({ cardId }: { cardId: string }) {
  const scan = useScanCharacterMedia(cardId)
  const submit = useSubmitDiscoveredMedia(cardId)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useMediaJobStatus(jobId)
  const invalidate = useInvalidateMediaCaches(cardId)
  const handled = useRef<string | null>(null)

  useEffect(() => {
    if (!jobId || !job.data) return
    const { state, saved, skipped, errors, error } = job.data
    if (state === 'queued' || state === 'running') return
    if (handled.current === jobId) return
    handled.current = jobId
    if (state === 'done') {
      toast(
        `Media: ${saved} saved, ${skipped} skipped${errors ? `, ${errors} failed` : ''}.`,
        errors ? 'bad' : 'ok',
      )
    } else {
      toast(`Media download ${state}: ${error ?? 'unknown error'}`, 'bad')
    }
    invalidate()
  }, [jobId, job.data, invalidate])

  const reset = () => {
    scan.reset()
    submit.reset()
    setJobId(null)
  }

  // --- a job is running or just finished ---
  if (jobId && job.data) {
    const { state, done, total, saved, skipped, errors } = job.data
    const running = state === 'queued' || state === 'running'
    return (
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-line-soft bg-surface px-[13px] py-[11px] text-[13px]">
        {running ? (
          <Loader2 className="size-4 flex-none animate-spin text-sage" />
        ) : (
          <ImageDown className="size-4 flex-none text-sage" />
        )}
        <span className="text-muted-foreground">
          {running
            ? `Downloading media… ${done}/${total}`
            : `Done — ${saved} saved, ${skipped} skipped${errors ? `, ${errors} failed` : ''}.`}
        </span>
        {!running && (
          <button
            type="button"
            onClick={reset}
            className="ml-auto text-[12.5px] text-faint hover:text-text"
          >
            dismiss
          </button>
        )}
      </div>
    )
  }

  // --- a scan already ran ---
  if (scan.data) {
    const total = scan.data.embedded.length + scan.data.lorebook.length
    // A gallery link is media the scan can see but deliberately does not
    // resolve — it would cost an outbound request per source for a preview the
    // user is about to follow with a job that does the same work for real. So
    // it is counted, not opened. Before this, a card whose whole gallery was a
    // single Civitai post reported two empty lists and got told it had nothing.
    const galleries = (scan.data.sources ?? []).filter(
      (s) => s.status === 'ready',
    )
    if (total === 0 && galleries.length === 0)
      return (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-line-soft bg-surface px-[13px] py-[11px] text-[13px] text-faint">
          No remote media URLs found in this card's text.
          <button
            type="button"
            onClick={reset}
            className="ml-auto text-[12.5px] hover:text-text"
          >
            dismiss
          </button>
        </div>
      )
    return (
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-sage-line bg-sage-dim px-[13px] py-[11px] text-[13px]">
        <ImageDown className="size-4 flex-none text-sage" />
        <span>
          {describeScan(total, scan.data.lorebook.length, galleries.length)}
        </span>
        <button
          type="button"
          onClick={() =>
            submit.mutate(undefined, {
              onSuccess: (result) => setJobId(result.job_id),
              onError: (err) => toast(err.message, 'bad'),
            })
          }
          disabled={submit.isPending}
          className="ml-auto flex h-7 items-center gap-1.5 rounded-lg bg-sage px-3 text-[12.5px] font-semibold text-on-sage disabled:opacity-60"
        >
          <Download className="size-3.5" />
          {submit.isPending ? 'Starting…' : 'Download'}
        </button>
        <button
          type="button"
          onClick={reset}
          className="text-[12.5px] text-faint hover:text-text"
        >
          dismiss
        </button>
      </div>
    )
  }

  // --- idle ---
  return (
    <button
      type="button"
      onClick={() => scan.mutate()}
      disabled={scan.isPending}
      className="mb-4 flex h-9 items-center gap-2 rounded-xl border border-dashed border-line px-3.5 text-[13px] text-muted hover:border-sage-line hover:text-sage disabled:opacity-60"
    >
      {scan.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <ImageDown className="size-4" />
      )}
      {scan.isPending ? 'Scanning…' : 'Find media in this card'}
    </button>
  )
}
