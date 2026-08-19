import { ChevronDown } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverHeading,
  PopoverItem,
  PopoverSeparator,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  discoverSortLabel,
  discoverSortOptions,
  type DiscoverState,
} from '@/lib/discover-state'

/**
 * The mock's `#discSort` (`d-archive.html:371`) — a text button in the section
 * head, present for every provider and every feed.
 *
 * It was previously a `<select>` rendered only for Chub browse, so choosing
 * DataCat made the control vanish entirely and there was no way to order that
 * provider's results at all. The option list comes from `discoverSortOptions`,
 * which knows what each of the four feeds actually offers.
 */
export function DiscoverSort({
  state,
  onChange,
}: {
  state: DiscoverState
  onChange: (sort: string) => void
}) {
  const options = discoverSortOptions(state)
  let lastGroup: string | undefined

  return (
    <Popover>
      <PopoverTrigger className="inline-flex flex-none items-center gap-[5px] px-1 py-1.5 text-[13px] text-sage hover:underline">
        Sort{' '}
        <b className="font-semibold text-text">{discoverSortLabel(state)}</b>
        <ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverContent className="max-h-[70vh] overflow-y-auto">
        <PopoverHeading>Sort by</PopoverHeading>
        {options.map((option) => {
          const heading = option.group !== lastGroup ? option.group : undefined
          lastGroup = option.group
          return (
            <div key={option.value}>
              {heading && (
                <>
                  <PopoverSeparator />
                  <PopoverHeading>{heading}</PopoverHeading>
                </>
              )}
              <PopoverItem
                state={option.value === state.sort ? 'on' : undefined}
                onClick={() => onChange(option.value)}
              >
                {option.label}
              </PopoverItem>
            </div>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
