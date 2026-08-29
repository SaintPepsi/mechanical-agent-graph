import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { envisionEffect } from "mag/skills/design/envision-effect"
import { envisionGeneric } from "mag/skills/design/envision-generic"
import { envisionGraphCore } from "mag/skills/design/envision-graph-core"
import { envisionSvelte } from "mag/skills/design/envision-svelte"
import {
  concernForNotation,
  EFFECT,
  GENERIC,
  GRAPH_CORE,
  NOTATIONS,
  notationsFor,
  STACKS,
  SVELTE
} from "mag/skills/design/envisioning"

/**
 * A probe's match id resolves to its stack's notation, no match resolves to `GENERIC` (an answer,
 * not an error), and an id no `STACKS` row carries is a caller mistake (`envision-shell` is the
 * node that turns that failure into a named error, not this module).
 */

describe("notationsFor selects the notation its matched stack owns", () => {
  test("no match resolves to [GENERIC], not an error", () => {
    const result = notationsFor([])
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toEqual([GENERIC])
  })

  test("one matched stack resolves to that stack's id alone", () => {
    const svelte = notationsFor([SVELTE])
    const effect = notationsFor([EFFECT])
    const graphCore = notationsFor([GRAPH_CORE])
    expect(Result.isSuccess(svelte)).toBe(true)
    expect(Result.isSuccess(effect)).toBe(true)
    expect(Result.isSuccess(graphCore)).toBe(true)
    if (!Result.isSuccess(svelte) || !Result.isSuccess(effect) || !Result.isSuccess(graphCore)) return
    expect(svelte.success).toEqual([SVELTE])
    expect(effect.success).toEqual([EFFECT])
    expect(graphCore.success).toEqual([GRAPH_CORE])
  })

  test("more than one matched stack resolves to every matched id, in STACKS order", () => {
    const result = notationsFor([GRAPH_CORE, SVELTE])
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toEqual([SVELTE, GRAPH_CORE])
  })

  test("an id no STACKS row carries fails named, rather than silently falling back to generic", () => {
    const result = notationsFor(["cobol"])
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBe("cobol")
  })

  test("STACKS carries exactly the three probe-backed ids, each once", () => {
    expect(STACKS.map((stack) => stack.id)).toEqual([SVELTE, EFFECT, GRAPH_CORE])
  })

  test("NOTATIONS carries STACKS' three ids plus GENERIC, in that order", () => {
    expect(NOTATIONS).toEqual([SVELTE, EFFECT, GRAPH_CORE, GENERIC])
  })
})

describe("concernForNotation resolves each of the four ids and fails on a fifth", () => {
  test("each STACKS id resolves to its own module", () => {
    expect(concernForNotation(SVELTE)).toEqual(Result.succeed(envisionSvelte))
    expect(concernForNotation(EFFECT)).toEqual(Result.succeed(envisionEffect))
    expect(concernForNotation(GRAPH_CORE)).toEqual(Result.succeed(envisionGraphCore))
  })

  test("GENERIC resolves to envisionGeneric — the one id with no probe behind it", () => {
    expect(concernForNotation(GENERIC)).toEqual(Result.succeed(envisionGeneric))
  })

  test("a fifth id fails named, carrying the id itself", () => {
    const result = concernForNotation("cobol")
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBe("cobol")
  })
})
