import { Link, Outlet } from "@tanstack/react-router"

export function AppShell() {
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

          <span className="text-xs text-muted-foreground">
            Synthetic demo data
          </span>
        </div>
      </header>

      <Outlet />
    </div>
  )
}
