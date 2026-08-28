import { Data } from "effect"

/** The ticket file at `ticketPath` could not be read for the stack probes. `require-acs`'s `TicketUnreadable` shape: a file is a trust boundary, read here, never assumed present. */
export class DesignGraphTicketUnreadable extends Data.TaggedError("DESIGN_GRAPH_TICKET_UNREADABLE")<{
  readonly ticket: string
  readonly path: string
  readonly detail: string
}> {}
