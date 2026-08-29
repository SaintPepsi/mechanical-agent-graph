import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { envisionEffect } from "mag/skills/design/envision-effect"
import { envisionGeneric } from "mag/skills/design/envision-generic"
import { envisionGraphCore } from "mag/skills/design/envision-graph-core"
import { envisionSvelte } from "mag/skills/design/envision-svelte"
import { EFFECT, GENERIC, GRAPH_CORE, NOTATIONS, SVELTE } from "mag/skills/design/envisioning"
import { BLIND_DRAW_RULE, compileEnvisionNotation, compileEnvisionShell, SHELL_SECTION } from "mag/skills/envision/notation"

/** Every notation's own rendered body, keyed the same way `NOTATIONS` orders them. */
const BODIES: Readonly<Record<string, string>> = {
  [SVELTE]: envisionSvelte.section!.body(null),
  [EFFECT]: envisionEffect.section!.body(null),
  [GRAPH_CORE]: envisionGraphCore.section!.body(null),
  [GENERIC]: envisionGeneric.section!.body(null)
}

const DESTINATION = "/repo/docs/graph/GH-288/design.md"

describe("compileEnvisionShell carries the blind-draw discipline once, every named notation's body, and one destination", () => {
  for (const notation of NOTATIONS) {
    test(`${notation}: BLIND_DRAW_RULE renders once, the prompt names the destination and the shell section once`, () => {
      const result = compileEnvisionShell({ notations: [notation], destination: DESTINATION })
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.prompt.split(BLIND_DRAW_RULE).length - 1).toBe(1)
      expect(result.success.prompt.split(DESTINATION).length - 1).toBe(1)
      expect(result.success.prompt).toContain(SHELL_SECTION)
    })
  }

  test("two notations render both bodies in the order given, the rule still once, the modules in the same order", () => {
    const result = compileEnvisionShell({ notations: [SVELTE, EFFECT], destination: DESTINATION })
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.prompt.split(BLIND_DRAW_RULE).length - 1).toBe(1)
    expect(result.success.prompt.indexOf(BODIES[SVELTE]!)).toBeLessThan(result.success.prompt.indexOf(BODIES[EFFECT]!))
    expect(result.success.modules).toEqual([envisionSvelte.id, envisionEffect.id])
  })

  test("an id no NOTATIONS entry carries fails, naming the id, before the node ever turns it into UnknownNotation", () => {
    const result = compileEnvisionShell({ notations: [SVELTE, "cobol"], destination: DESTINATION })
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBe("cobol")
  })
})

/**
 * Provenance proof: `compileEnvisionNotation` composes one envisioning module per notation, so a
 * notation's body must be that notation's and no sibling's. `envision-graph-core`'s own boundary
 * rule (FR-11, `docs/requirements/graph-envisioning.md`) has no named constant in
 * `envision-graph-core.ts` to assert against, so this proves its provenance the same structural way
 * every other notation's is proved: its body renders and no sibling's does.
 */
describe("each notation's body is that notation's module body and none of the other three's", () => {
  for (const notation of NOTATIONS) {
    test(`${notation}: carries its own body, and no other notation's`, () => {
      const result = compileEnvisionNotation(notation)
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return

      expect(result.success.body).toBe(BODIES[notation]!)
      for (const other of NOTATIONS) {
        if (other === notation) continue
        expect(result.success.body).not.toContain(BODIES[other]!)
      }
    })
  }
})

describe("compileEnvisionNotation's module field", () => {
  test("names the concern id it composed, distinct from the notation id (svelte → envision-svelte)", () => {
    const result = compileEnvisionNotation(SVELTE)
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.module).toBe(envisionSvelte.id)
    expect(result.success.module).not.toBe(SVELTE)
  })

  test("generic resolves to envision-generic, the one id with no probe behind it", () => {
    const result = compileEnvisionNotation(GENERIC)
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.module).toBe(envisionGeneric.id)
  })

  test("a fifth id fails named, carrying the id itself", () => {
    const result = compileEnvisionNotation("cobol")
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBe("cobol")
  })
})
