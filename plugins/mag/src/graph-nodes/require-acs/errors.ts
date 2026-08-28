import { Data } from "effect"

/** The ticket file at `ticketPath` could not be read. A file is a trust boundary: it is read here, never assumed present. */
export class TicketUnreadable extends Data.TaggedError("REQUIRE_ACS_TICKET_UNREADABLE")<{
  readonly ticket: string
  readonly path: string
  readonly detail: string
}> {}

/**
 * The ticket's body carries no criterion line inside an acceptance-criteria section. Terminal:
 * nothing catches this tag, since a caller that could absorb it would be a caller that runs a ticket
 * without ACs. `message` is overridden rather than carried as a payload field so `formatFailure`
 * (`runtime/render.ts`) prints the maintainer's instruction at the terminal, while the payload
 * itself stays fields-only for the journal row.
 */
export class AcceptanceCriteriaMissing extends Data.TaggedError("REQUIRE_ACS_ACCEPTANCE_CRITERIA_MISSING")<{
  readonly ticket: string
  readonly title: string
  readonly headings: string
}> {
  override get message(): string {
    const carried = this.headings.length > 0
      ? `Headings the body carried: ${this.headings}.`
      : "The body carries no headings at all."
    return `${this.ticket} ("${this.title}") carries no acceptance criteria. ` +
      `Draft ACs with the maintainer first and land them in the tracker before this run is retried. ${carried}`
  }
}
