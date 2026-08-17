import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { InfoIcon } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"

/**
 * A small "i" that explains something on hover or focus. The detail stays out
 * of the layout until it is asked for, which keeps dense choices scannable.
 */
export function InfoTooltip({
  label,
  className,
  children,
}: {
  /** What the trigger is for, read by assistive technology. */
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        aria-label={label}
        className={cn(
          "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 data-[popup-open]:bg-muted data-[popup-open]:text-foreground",
          className
        )}
      >
        <InfoIcon className="size-4" aria-hidden />
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="top" sideOffset={6}>
          <TooltipPrimitive.Popup className="z-50 max-w-72 rounded-md border bg-popover px-3 py-2 text-[13px] leading-5 text-popover-foreground shadow-md">
            {children}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}
