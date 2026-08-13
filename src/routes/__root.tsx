import { createRootRoute, Link } from "@tanstack/react-router"

import { AppShell } from "@/components/app-shell"
import { buttonVariants } from "@/components/ui/button"

export const Route = createRootRoute({
  component: AppShell,
  notFoundComponent: NotFound,
})

function NotFound() {
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-12 sm:px-6">
      <div className="rounded-lg border bg-card p-5 shadow-xs">
        <p className="text-[13px] leading-4 font-medium text-muted-foreground">
          404
        </p>
        <h1 className="mt-1.5 text-base leading-5 font-medium">
          This page could not be found
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The link may be incorrect, or the run it pointed at may no longer
          exist.
        </p>
        <Link
          to="/"
          className={buttonVariants({ size: "lg", className: "mt-4" })}
        >
          Start a new request
        </Link>
      </div>
    </main>
  )
}
