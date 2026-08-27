import { Cause, Exit, Predicate } from "effect"
import type { Outcome } from "mag/runtime/trace/event"

/**
 * The fallback tag a `fail`/`die` outcome carries when its
 * failure/defect has no (string) `_tag` of its own — the same word
 * `render.ts`'s `formatFailure` falls back to, so a human reading a
 * rendered failure line and a sink reading a trace event never see two
 * different spellings of "this had no tag."
 */
export const UNTAGGED_FAILURE = "UNKNOWN_ERROR"

/**
 * Read a failure/defect's tag by the same rule
 * `render.ts`'s `formatFailure` uses — an own `_tag`, only when it is a
 * string. Anything else (no `_tag`, a non-string `_tag`, a non-object
 * value) falls back to {@link UNTAGGED_FAILURE}.
 */
const tagOf = (error: unknown): string => {
  if (!Predicate.isObject(error)) return UNTAGGED_FAILURE
  const tag = error["_tag"]
  return Predicate.isString(tag) ? tag : UNTAGGED_FAILURE
}

/**
 * Projects an `Exit` onto the one outcome value a close event
 * records, plus a `tag` when the outcome is `fail` or `die`.
 *
 * Precedence, documented because a single `Cause` can carry more than one
 * reason at once (e.g. a parallel combinator interrupting a sibling fiber
 * after this one already failed): a typed **failure wins** over a defect,
 * which wins over an interruption — `interrupt` is only reported when the
 * cause carries neither a failure nor a defect. Die/interrupt discrimination
 * goes through `Cause.isDieReason`/`Cause.isInterruptReason` rather than a
 * hand-rolled walk of `_tag` strings.
 */
export const outcomeOf = (exit: Exit.Exit<unknown, unknown>): { readonly outcome: Outcome; readonly tag?: string } => {
  if (Exit.isSuccess(exit)) return { outcome: "ok" }

  const reasons = exit.cause.reasons

  const failReason = reasons.find(Cause.isFailReason)
  if (failReason !== undefined) return { outcome: "fail", tag: tagOf(failReason.error) }

  const dieReason = reasons.find(Cause.isDieReason)
  if (dieReason !== undefined) return { outcome: "die", tag: tagOf(dieReason.defect) }

  const interruptReason = reasons.find(Cause.isInterruptReason)
  if (interruptReason !== undefined) return { outcome: "interrupt" }

  // Defensive, not expected to run: `Cause.Reason` is closed to Fail | Die | Interrupt, and
  // `exit.cause.reasons` is non-empty whenever `Exit.isFailure(exit)` holds for a cause the
  // effect runtime actually produced. Having ruled out Fail and Die above, this keeps
  // `outcomeOf` total instead of partial for a cause the type system alone can't close off.
  return { outcome: "interrupt" }
}
