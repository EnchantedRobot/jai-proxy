import { DropdownMenu as D } from 'radix-ui'
import { cn } from '@/lib/utils'

/**
 * The card's "More" menu, on radix's DropdownMenu. Same surface as the popover
 * (13px radius, its own shadow) so the two read as one system.
 */
export const DropdownMenu = D.Root
export const DropdownMenuTrigger = D.Trigger

export function DropdownMenuContent({
  className,
  align = 'end',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-60 min-w-[190px] rounded-[13px] border border-line bg-surface p-[7px] shadow-[0_22px_60px_#000000a6]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      />
    </D.Portal>
  )
}

export function DropdownMenuItem({
  className,
  destructive,
  ...props
}: React.ComponentProps<typeof D.Item> & { destructive?: boolean }) {
  return (
    <D.Item
      className={cn(
        'flex w-full cursor-default items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[13.5px] outline-none select-none',
        'data-[highlighted]:bg-raised',
        destructive
          ? 'text-bad data-[highlighted]:text-bad'
          : 'data-[highlighted]:text-text',
        className,
      )}
      {...props}
    />
  )
}

export function DropdownMenuSeparator() {
  return <D.Separator className="my-1.5 border-t border-line-soft" />
}
