import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { BrainstormPromptOversized } from "mag/graph-nodes/assemble-brainstorm-prompt/errors"
import { assembleBrainstormPrompt } from "mag/graph-nodes/assemble-brainstorm-prompt/graph-node"
import { inputExamples, successExamples } from "mag/graph-nodes/assemble-brainstorm-prompt/examples"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import type { CitationRoot } from "mag/skills/design/concern"
import { COMPOSED_PROMPT_BUDGET, composeDesignPrompt, promptBytes } from "mag/skills/design/compose"
import { reconciliation } from "mag/skills/design/reconciliation"
import { BRAINSTORM_DESIGN } from "mag/skills/design/variants"

const runAssemble = () => Effect.runPromise(Effect.result(assembleBrainstormPrompt.run({})))

describe("assemble-brainstorm-prompt", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(assembleBrainstormPrompt.input)) throw new Error("assembleBrainstormPrompt.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(assembleBrainstormPrompt.input)(example)
    if (!isSchemaHandle(assembleBrainstormPrompt.success)) throw new Error("assembleBrainstormPrompt.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(assembleBrainstormPrompt.success)(example)
  })

  test("the returned prompt is the one measured, and is BRAINSTORM_DESIGN's own composition", async () => {
    const result = await runAssemble()
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.prompt).toBe(composeDesignPrompt(BRAINSTORM_DESIGN))
    expect(result.success.bytes).toBe(promptBytes(result.success.prompt))
  })

  /**
   * Disconfirming test: `BRAINSTORM_DESIGN` is a fixed variant (no verdicts to grow it), so proving
   * the bound genuinely fires means handing the real, shipped node a genuinely oversized
   * composition rather than a lowered budget — done by swapping `reconciliation`'s own rendered body for the one dispatch this
   * test controls, restored in `finally` regardless of outcome.
   */
  test("disconfirming: a genuinely oversized prompt fails BrainstormPromptOversized, no prompt returned", async () => {
    const original = reconciliation.section!.body
    const mutable = reconciliation as { section: { body: (root: CitationRoot) => string } }
    mutable.section.body = () => "x".repeat(COMPOSED_PROMPT_BUDGET + 1)
    try {
      const result = await runAssemble()
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(BrainstormPromptOversized)
      const failure = result.failure as BrainstormPromptOversized
      expect(failure.budget).toBe(COMPOSED_PROMPT_BUDGET)
      expect(failure.bytes).toBeGreaterThan(COMPOSED_PROMPT_BUDGET)
    } finally {
      mutable.section.body = original
    }
  })
})
