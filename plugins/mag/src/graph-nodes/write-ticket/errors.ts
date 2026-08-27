import { Data } from "effect"

/** One of `what`/`why`/`how` is empty or carries more than one sentence. Fails before anything is spawned. */
export class TicketInputNotOneSentence extends Data.TaggedError("TICKET_INPUT_NOT_ONE_SENTENCE")<{
  readonly field: "what" | "why" | "how"
  readonly value: string
}> {}

/** `criteriaPath` was given and the file is missing, or holds no criterion once blank lines are dropped. */
export class TicketCriteriaUnreadable extends Data.TaggedError("TICKET_CRITERIA_UNREADABLE")<{
  readonly path: string
  readonly detail: string
}> {}

/** A provided criterion is carried by nothing in the writer's array — names the missing ones and the draft path already written, so a human can inspect or fix it by hand. */
export class TicketCriterionDropped extends Data.TaggedError("TICKET_CRITERION_DROPPED")<{
  readonly missing: readonly string[]
  readonly ticketPath: string
}> {}

/** `writeArtifact`'s own `PlatformError` on the draft write, caught and named (`PrBodyDiffWriteFailed`'s precedent). */
export class TicketDraftUnwritable extends Data.TaggedError("TICKET_DRAFT_UNWRITABLE")<{
  readonly runRoot: string
  readonly detail: string
}> {}

/** A live run needs a run directory to keep the draft in (`write-pr-body`'s `PrBodyRunRootMissing` precedent). */
export class TicketRunRootMissing extends Data.TaggedError("TICKET_RUN_ROOT_MISSING")<{}> {}
