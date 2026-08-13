import { createRootRoute, Link } from "@tanstack/react-router"

import { AppShell } from "@/components/app-shell"
import { buttonVariants } from "@/components/ui/button"

export const Route = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFound,
})

function NotFound() {
  return (
    <main className="mx-auto flex min-h-[calc(100svh-3rem)] max-w-lg flex-col items-center justify-center px-4 text-center">
      <p className="text-xs font-medium text-muted-foreground">404</p>
      <h1 className="mt-2 text-base font-medium">
        This run could not be found
      </h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        The link may be incorrect or the temporary run may have expired.
      </p>
      <Link
        to="/"
        className={buttonVariants({ size: "lg", className: "mt-5" })}
      >
        Return to RFQ Relay
      </Link>
    </main>
  )
}
