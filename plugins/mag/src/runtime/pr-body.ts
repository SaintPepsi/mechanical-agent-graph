import { Effect } from "effect"
import { RunInfo } from "mag/runtime/run-info"

/**
 * `<PREFIX>-<n>` to `n`, taken as the ticket id's trailing `-`-separated segment. Total, no guard:
 * by the time a ticket id reaches this seam it has already survived that exact same derivation once,
 * at `fetch-ticket`, which fails `TicketNotAddressable` for an id it can't map to a number before
 * `design` spends a token — a second check here would be a guard for a failure mode no run can
 * exhibit, which PRINCIPLES.md rules out: no guards for failures never experienced.
 */
export const issueNumber = (ticket: string): string => ticket.slice(ticket.lastIndexOf("-") + 1)

/** PR body: the writing session's description, then `Closes #<n>` alone for the tracker's parse, then the run id. */
export const prBody = (facts: { readonly description: string }) =>
  Effect.gen(function* () {
    const runInfo = yield* RunInfo
    const n = issueNumber(runInfo.ticket)
    return `${facts.description}\n\nCloses #${n}\n\nrun: ${runInfo.runId}`
  })
