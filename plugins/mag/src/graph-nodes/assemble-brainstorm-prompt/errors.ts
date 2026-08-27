import { Data } from "effect"

/**
 * `promptBytes(composed) > COMPOSED_PROMPT_BUDGET` — enforced before any session spends,
 * never by truncation. No `modules` field: `BRAINSTORM_DESIGN` is a fixed variant, so there is no
 * per-run composition to name.
 */
export class BrainstormPromptOversized extends Data.TaggedError("BRAINSTORM_PROMPT_OVERSIZED")<{
  readonly bytes: number
  readonly budget: number
}> {}
