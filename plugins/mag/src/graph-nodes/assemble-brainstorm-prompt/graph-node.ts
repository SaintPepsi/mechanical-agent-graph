import { Effect, Schema } from "effect"
import { BrainstormPromptOversized } from "mag/graph-nodes/assemble-brainstorm-prompt/errors"
import { make } from "mag/runtime/graph-node.definition"
import { composeDesignPrompt, COMPOSED_PROMPT_BUDGET, promptBytes } from "mag/skills/design/compose"
import { BRAINSTORM_DESIGN } from "mag/skills/design/variants"

/**
 * Composes `brainstorm`'s own dispatch prompt. `brainstorm` always gets the same variant, since
 * the shell is already drawn by `envision-shell`, the same session's blind first pass, so this
 * node doesn't resolve any probe's verdicts into a splice; it composes `BRAINSTORM_DESIGN` and
 * nothing else.
 * That is what makes the input `{}` and lets the node run standalone: `mag
 * assemble-brainstorm-prompt` prints the composed prompt and its size, letting a maintainer read
 * what a design session is actually told without spending a session to find out.
 */
export const assembleBrainstormPrompt = make({
  name: "assemble-brainstorm-prompt",
  description: "Compose the brainstorm prompt and enforce the composed prompt's byte budget before any session spends.",
  input: Schema.Struct({}),
  success: Schema.Struct({
    prompt: Schema.String,
    bytes: Schema.Number
  }),
  run: () =>
    Effect.gen(function* () {
      const prompt = composeDesignPrompt(BRAINSTORM_DESIGN)
      const bytes = promptBytes(prompt)

      if (bytes > COMPOSED_PROMPT_BUDGET) {
        return yield* Effect.fail(new BrainstormPromptOversized({ bytes, budget: COMPOSED_PROMPT_BUDGET }))
      }

      return { prompt, bytes }
    })
})
