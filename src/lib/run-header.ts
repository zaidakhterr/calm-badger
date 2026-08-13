import { createContext, useContext } from "react"

/**
 * What the run route lends the global header.
 *
 * The header shows the current run's status and its Start over control, but the
 * run route owns the polled state those come from. Rather than fetching twice,
 * the route publishes a small summary here and the shell renders it; nothing
 * else in the application writes to it.
 */
export type RunHeaderState = {
  /** A short status sentence, e.g. "4 of 9 steps complete". */
  status: string
  /** Present only for the browser that started the run. */
  startOver: { label: string; disabled: boolean; onSelect: () => void } | null
}

export type RunHeaderPublisher = (state: RunHeaderState | null) => void

export const RunHeaderContext = createContext<RunHeaderPublisher>(() => {})

export function usePublishRunHeader(): RunHeaderPublisher {
  return useContext(RunHeaderContext)
}
