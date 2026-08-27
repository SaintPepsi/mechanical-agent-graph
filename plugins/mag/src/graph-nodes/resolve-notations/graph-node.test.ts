import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { UnknownStackVerdict } from "mag/graph-nodes/resolve-notations/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/resolve-notations/examples"
import { resolveNotations } from "mag/graph-nodes/resolve-notations/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { EFFECT, GENERIC, GRAPH_CORE, SVELTE } from "mag/skills/design/envisioning"

const run = (verdicts: readonly { readonly stack: string; readonly matched: boolean }[]) =>
  Effect.runPromise(Effect.result(resolveNotations.run({ verdicts })))

describe("resolve-notations", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(resolveNotations.input)) throw new Error("resolveNotations.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(resolveNotations.input)(example)
    if (!isSchemaHandle(resolveNotations.success)) throw new Error("resolveNotations.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(resolveNotations.success)(example)
  })

  test("no matched verdict resolves to [generic], an answer, not an error", async () => {
    const result = await run([{ stack: SVELTE, matched: false }])
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.notations).toEqual([GENERIC])
  })

  test("one matched verdict resolves to that stack's notation alone", async () => {
    const result = await run([{ stack: SVELTE, matched: true }, { stack: EFFECT, matched: false }])
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.notations).toEqual([SVELTE])
  })

  test("more than one matched verdict resolves to every matched id, in STACKS order", async () => {
    const result = await run([{ stack: GRAPH_CORE, matched: true }, { stack: SVELTE, matched: true }])
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.notations).toEqual([SVELTE, GRAPH_CORE])
  })

  test("an id no STACKS row carries fails UnknownStackVerdict, naming the id and the known ids, before any dispatch", async () => {
    const result = await run([{ stack: "cobol", matched: true }])
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toStrictEqual(new UnknownStackVerdict({ id: "cobol", known: [SVELTE, EFFECT, GRAPH_CORE] }))
  })

  test("an empty verdict list resolves to [generic] — no verdicts, still an answer", async () => {
    const result = await run([])
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.notations).toEqual([GENERIC])
  })
})
