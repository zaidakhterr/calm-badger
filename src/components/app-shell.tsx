import { Link, Outlet, useRouterState } from "@tanstack/react-router"

import { buttonVariants } from "@/components/ui/button"

export function AppShell() {
  const isRunRoute = useRouterState({
    select: (state) => state.location.pathname.startsWith("/runs/"),
  })

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex h-12 max-w-4xl items-center justify-between px-4 sm:px-6">
          <Link
            to="/"
            className="flex items-center gap-2 text-sm font-medium tracking-[-0.01em]"
          >
            <span className="flex size-5 items-center justify-center rounded-sm bg-foreground text-[10px] font-semibold text-background">
              R
            </span>
            RFQ Relay
          </Link>

          {isRunRoute ? (
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-muted-foreground sm:inline">
                Foundation preview
              </span>
              <Link
                to="/"
                className={buttonVariants({ variant: "ghost", size: "lg" })}
              >
                Start over
              </Link>
            </div>
          ) : null}
        </div>
      </header>

      <Outlet />
    </div>
  )
}
