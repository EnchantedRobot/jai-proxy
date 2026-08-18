import { ChevronDown } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverHeading,
  PopoverItem,
  PopoverSeparator,
  PopoverTrigger,
} from '@/components/ui/popover'
import { SORTS, sortLabel } from '@/lib/browse'

/**
 * Sort, as the mock has it: a small text button rather than a select, with the
 * current ordering spelled out beside the word.
 *
 * Direction is a row in the popover rather than a second control, and it is
 * relative: each option carries the direction it is useful in ("Recently added"
 * is `-added`), and Reverse flips whatever is chosen.
 */
export function SortPopover({
  sort,
  onChange,
}: {
  sort: string
  onChange: (sort: string) => void
}) {
  const descending = sort.startsWith('-')
  const bare = sort.replace(/^-/, '')

  return (
    <Popover>
      <PopoverTrigger className="inline-flex flex-none items-center gap-[5px] px-1 py-1.5 text-[13px] text-sage hover:underline">
        Sort <b className="font-semibold text-text">{sortLabel(sort)}</b>
        <ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverContent>
        <PopoverHeading>Sort by</PopoverHeading>
        {SORTS.map((option) => {
          const optionBare = option.value.replace(/^-/, '')
          return (
            <PopoverItem
              key={option.value}
              state={optionBare === bare ? 'on' : undefined}
              onClick={() => onChange(option.value)}
            >
              {option.label}
              {option.hint && (
                <span className="ml-auto text-[11.5px] text-faint">
                  {option.hint}
                </span>
              )}
            </PopoverItem>
          )
        })}
        <PopoverSeparator />
        <PopoverItem onClick={() => onChange(descending ? bare : `-${bare}`)}>
          Reverse order
          <span className="ml-auto font-mono text-[11.5px] text-faint">
            {descending ? '↓' : '↑'}
          </span>
        </PopoverItem>
      </PopoverContent>
    </Popover>
  )
}
