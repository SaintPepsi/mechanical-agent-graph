import { Data } from "effect"

/**
 * The ticket id held nothing a git ref can carry once non-alphanumerics were normalised away. A
 * tagged error, rather than a `null` return, says the same thing in the channel the caller already
 * has to handle.
 */
export class MissingTicketId extends Data.TaggedError("FORMAT_BRANCH_NAME_MISSING_TICKET_ID")<{
  readonly ticket: string
}> {}
