import { Data } from "effect"

/** `ticketPath` holds no file. Checked before anything is spawned (`comment-ticket`'s `CommentBodyMissing` precedent). */
export class TicketDraftMissing extends Data.TaggedError("TICKET_DRAFT_MISSING")<{
  readonly path: string
}> {}

/** The file at `ticketPath` does not decode as a `Ticket`. A file is a trust boundary: it is decoded, never assumed. */
export class TicketDraftOffSchema extends Data.TaggedError("TICKET_DRAFT_OFF_SCHEMA")<{
  readonly path: string
  readonly detail: string
}> {}

/** `writeArtifact`'s own `PlatformError` on the rendered body's write, caught and named (`PrBodyDiffWriteFailed`'s precedent). */
export class TicketBodyUnwritable extends Data.TaggedError("TICKET_BODY_UNWRITABLE")<{
  readonly runRoot: string
  readonly detail: string
}> {}

/** `gh`'s own documented authentication-required exit, 4 (`gh help exit-codes`) — `comment-ticket`'s `CommentTrackerUnreachable` precedent. */
export class TicketTrackerUnreachable extends Data.TaggedError("TICKET_TRACKER_UNREACHABLE")<{
  readonly detail: string
}> {}

/** Any other non-zero `gh issue create` exit. Carries the rendered body's path, so a rejected filing is pasteable by hand. */
export class TicketFilingRejected extends Data.TaggedError("TICKET_FILING_REJECTED")<{
  readonly exitCode: number
  readonly detail: string
  readonly bodyPath: string
}> {}
