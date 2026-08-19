import type { PlanStats } from '@/lib/tags/tags-editor'

/**
 * The staged-change summary above the editor (the mock's `.tagstats` strip).
 * Every number is recomputed from the live plan on each render — they are the
 * point of the screen and move with every chip.
 */
export function TagStats({
  stats,
  unassigned,
  removed,
}: {
  stats: PlanStats
  unassigned: number
  removed: number
}) {
  return (
    <div className="my-5 flex flex-wrap items-center gap-x-9 gap-y-3 rounded-2xl border border-line bg-surface px-6 py-4">
      <Stat value={stats.renames} label="renames staged" />
      <Stat value={stats.removals} label="removals staged" />
      <Stat
        value={stats.affectedCards.toLocaleString()}
        label="cards affected"
      />
      <Stat
        value={
          <>
            {stats.vocabBefore} <span className="text-faint">→</span>{' '}
            {stats.vocabAfter}
          </>
        }
        label="vocabulary"
      />
      <div className="ml-auto max-w-[44ch] text-[12.5px] leading-relaxed text-faint">
        {unassigned.toLocaleString()} unassigned · {removed.toLocaleString()}{' '}
        removed · click a variant’s ✕ to send it back to Unassigned
      </div>
    </div>
  )
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div>
      <b className="block font-mono text-[21px] leading-tight font-semibold">
        {value}
      </b>
      <span className="text-[11.5px] text-faint">{label}</span>
    </div>
  )
}
