import { useCallback, useState } from "react"
import { ArrowClockwiseIcon } from "@phosphor-icons/react"
import { Link, Outlet } from "@tanstack/react-router"

import { SystemDetailsDrawer } from "@/components/system-details"
import { Button } from "@/components/ui/button"
import { RunHeaderContext, type RunHeaderState } from "@/lib/run-header"

/**
 * The whole application chrome: a wordmark, the current run's status, System
 * details, and Start over. There is no sidebar, no navigation, and no metrics
 * strip — the workflow underneath is the interface.
 */
export function AppShell() {
  const [header, setHeader] = useState<RunHeaderState | null>(null)
  const publish = useCallback((state: RunHeaderState | null) => {
    setHeader(state)
  }, [])

  return (
    <RunHeaderContext.Provider value={publish}>
      <div className="min-h-svh bg-background">
        <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur-sm">
          <div className="mx-auto flex h-12 max-w-4xl items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-2.5">
              <Link
                to="/"
                className="flex shrink-0 items-center gap-2 text-sm font-medium tracking-[-0.01em]"
              >
                <span className="flex size-5 items-center justify-center rounded-sm bg-foreground text-[10px] font-semibold text-background">
                  R
                </span>
                RFQ Relay
              </Link>
              {header ? (
                <span
                  className="hidden truncate text-[13px] leading-4 text-muted-foreground sm:inline"
                  aria-live="polite"
                >
                  {header.status}
                </span>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <SystemDetailsDrawer />
              {header?.startOver ? (
                <Button
                  variant="outline"
                  size="lg"
                  type="button"
                  disabled={header.startOver.disabled}
                  onClick={header.startOver.onSelect}
                >
                  <ArrowClockwiseIcon data-icon="inline-start" />
                  {header.startOver.label}
                </Button>
              ) : null}
            </div>
          </div>
          {header ? (
            <div className="mx-auto max-w-4xl px-4 pb-2 sm:hidden">
              <p className="text-[13px] leading-4 text-muted-foreground">
                {header.status}
              </p>
            </div>
          ) : null}
        </header>

        <Outlet />
      </div>
    </RunHeaderContext.Provider>
  )
}
