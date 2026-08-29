import { Data } from "effect"

/** `gh issue view` fails to run at all, or exits with `gh`'s documented auth-required code, 4 (`gh help exit-codes`). */
export class TrackerUnreachable extends Data.TaggedError("FETCH_TICKET_TRACKER_UNREACHABLE")<{
  readonly ticket: string
  readonly detail: string
}> {}

/** The ticket id has no trailing `<PREFIX>-<n>` segment, or `gh issue view` reports no such issue. */
export class TicketNotAddressable extends Data.TaggedError("FETCH_TICKET_NOT_ADDRESSABLE")<{
  readonly ticket: string
  readonly detail: string
}> {}

/** `gh issue view` exited non-zero for a reason with no documented meaning, or its JSON didn't decode. */
export class TrackerFailed extends Data.TaggedError("FETCH_TICKET_TRACKER_FAILED")<{
  readonly ticket: string
  readonly exitCode: number
  readonly detail: string
}> {}

/** The issue's author isn't the maintainer: no maintainer text survives, so the ticket is refused rather than filtered to nothing. */
export class TicketNotMaintainerAuthored extends Data.TaggedError("FETCH_TICKET_NOT_MAINTAINER_AUTHORED")<{
  readonly ticket: string
}> {}

/**
 * The tracker answered successfully but the title was blank. Every downstream use of a ticket
 * needs a title, so an empty one is caught here rather than travelling as an empty string.
 */
export class EmptyTicket extends Data.TaggedError("FETCH_TICKET_EMPTY")<{
  readonly ticket: string
}> {}

/**
 * The ticket file could not land in the run root: the run has no run directory (`discover`'s own
 * "run root missing" detail, checked before the tracker is asked), or the write itself failed.
 * Every later node reads this file, so a run without it has nothing to work from.
 */
export class TicketWriteFailed extends Data.TaggedError("FETCH_TICKET_WRITE_FAILED")<{
  readonly ticket: string
  readonly path: string
  readonly detail: string
}> {}
