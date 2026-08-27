import { Result } from "effect"
import type { Concern } from "mag/skills/design/concern"
import { envisionEffect } from "mag/skills/design/envision-effect"
import { envisionGeneric } from "mag/skills/design/envision-generic"
import { envisionGraphCore } from "mag/skills/design/envision-graph-core"
import { envisionSvelte } from "mag/skills/design/envision-svelte"

/**
 * Which probe pairs with which envisioning module, and what a non-match gets. One home, read by
 * both the probe nodes (their own `stack` id, imported rather than restated — `detect-svelte`
 * imports `SVELTE`, not the string `"svelte"`) and by notation resolution.
 */

/** One stack: the id its probe reports, and the envisioning module that rides on it. */
export interface Stack {
  readonly id: string
  readonly concern: Concern<"any">
}

export const SVELTE = "svelte" as const
export const EFFECT = "effect" as const
export const GRAPH_CORE = "graph-core" as const
export const GENERIC = "generic" as const

export const STACKS: readonly Stack[] = [
  { id: SVELTE, concern: envisionSvelte },
  { id: EFFECT, concern: envisionEffect },
  { id: GRAPH_CORE, concern: envisionGraphCore }
]

/**
 * Every notation id the design lane knows, `STACKS`' three plus the generic fallback —
 * `resolve-notations`' own answer space and `envision-notation`'s closed dispatch set
 * (`UnknownNotation`) both read this one list, so neither can know an id the other doesn't.
 */
export const NOTATIONS: readonly string[] = [...STACKS.map((stack) => stack.id), GENERIC]

/**
 * Which notations a design run draws, in `STACKS` order, `[GENERIC]` when nothing matched (an
 * answer, not an error). An id no `STACKS` row carries is a caller mistake, not a silent drop —
 * checked before the empty-match fallback, so an unknown id can never resolve to generic by
 * accident. `resolve-notations` is the node that turns this `Result`'s left into `UnknownStackVerdict`.
 */
export const notationsFor = (matched: readonly string[]): Result.Result<readonly string[], string> => {
  const unknown = matched.find((id) => !STACKS.some((stack) => stack.id === id))
  if (unknown !== undefined) return Result.fail(unknown)

  const ids = STACKS.filter((stack) => matched.includes(stack.id)).map((stack) => stack.id)
  return Result.succeed(ids.length === 0 ? [GENERIC] : ids)
}

/**
 * One notation id to its concern module, the closed set `envision-notation` dispatches against
 * (`NOTATIONS`), including the generic row. Fails on a fifth id, naming what it knows;
 * `envision-notation` is the node that turns this `Result`'s left into `UnknownNotation`.
 */
export const concernForNotation = (notation: string): Result.Result<Concern<"any">, string> => {
  if (notation === GENERIC) return Result.succeed(envisionGeneric)
  const stack = STACKS.find((stack) => stack.id === notation)
  return stack === undefined ? Result.fail(notation) : Result.succeed(stack.concern)
}
