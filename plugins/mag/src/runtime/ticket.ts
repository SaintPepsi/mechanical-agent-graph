/**
 * The framing every ticket-driven prompt opens with: the id and title, then the citation. A shared
 * seam by the runtime rule (a boundary no single node can own alone): six agent nodes open their
 * prompt this way, and the one sentence they share is the whole of what a session is told about
 * the ticket. Sessions reference, they never remember, so the prompt names `<runRoot>/ticket.md`
 * (`fetch-ticket`'s own artifact, written once) and never carries its text.
 */
export const ticketReference = (
  input: { readonly ticket: string; readonly title: string; readonly ticketPath: string }
): readonly string[] => [
  `Ticket ${input.ticket}: ${input.title}`,
  "",
  `Read the ticket at \`${input.ticketPath}\`.`
]
