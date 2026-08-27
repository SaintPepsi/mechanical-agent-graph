import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { envisionEffect } from "mag/skills/design/envision-effect"
import { envisionGeneric } from "mag/skills/design/envision-generic"
import { envisionGraphCore } from "mag/skills/design/envision-graph-core"
import { envisionSvelte } from "mag/skills/design/envision-svelte"
import { EFFECT, GENERIC, GRAPH_CORE, NOTATIONS, SVELTE } from "mag/skills/design/envisioning"
import { BLIND_DRAW_RULE, compileEnvisionNotation, visionDestination } from "mag/skills/envision/notation"

/** Every notation's own rendered body, keyed the same way `NOTATIONS` orders them. */
const BODIES: Readonly<Record<string, string>> = {
  [SVELTE]: envisionSvelte.section!.body(null),
  [EFFECT]: envisionEffect.section!.body(null),
  [GRAPH_CORE]: envisionGraphCore.section!.body(null),
  [GENERIC]: envisionGeneric.section!.body(null)
}

const DESTINATION = "/repo/docs/graph/GH-288/vision-svelte.md"

describe("visionDestination", () => {
  test("one notation's relative destination, the artifact name this dispatch and the check both read", () => {
    expect(visionDestination("GH-288", "svelte")).toBe("docs/graph/GH-288/vision-svelte.md")
    expect(visionDestination("GH-1", "generic")).toBe("docs/graph/GH-1/vision-generic.md")
  })
})

describe("every notation's compiled prompt carries the blind-draw discipline, once, in identical words", () => {
  for (const notation of NOTATIONS) {
    test(`${notation}: BLIND_DRAW_RULE renders verbatim, and the prompt names exactly one destination`, () => {
      const result = compileEnvisionNotation({ notation, destination: DESTINATION })
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.prompt).toContain(BLIND_DRAW_RULE)
      expect(result.success.prompt.split(DESTINATION).length - 1).toBe(1)
    })
  }
})

/**
 * Provenance proof: `compileEnvisionNotation` composes one envisioning module per dispatch, so a
 * notation's prompt must carry that notation's body and no sibling's. `envision-graph-core`'s own
 * boundary rule (FR-11, `docs/requirements/graph-envisioning.md`) has no named constant in
 * `envision-graph-core.ts` to assert against, so this proves its provenance the same structural way
 * every other notation's is proved: its body renders and no sibling's does.
 */
describe("each notation's prompt carries that notation's module body and none of the other three's", () => {
  for (const notation of NOTATIONS) {
    test(`${notation}: carries its own body, and no other notation's`, () => {
      const result = compileEnvisionNotation({ notation, destination: DESTINATION })
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return

      expect(result.success.prompt).toContain(BODIES[notation]!)
      for (const other of NOTATIONS) {
        if (other === notation) continue
        expect(result.success.prompt).not.toContain(BODIES[other]!)
      }
    })
  }
})

describe("compileEnvisionNotation's module field", () => {
  test("names the concern id it composed, distinct from the notation id (svelte → envision-svelte)", () => {
    const result = compileEnvisionNotation({ notation: SVELTE, destination: DESTINATION })
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.module).toBe(envisionSvelte.id)
    expect(result.success.module).not.toBe(SVELTE)
  })

  test("generic resolves to envision-generic — the one id with no probe behind it", () => {
    const result = compileEnvisionNotation({ notation: GENERIC, destination: DESTINATION })
    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success.module).toBe(envisionGeneric.id)
  })
})

describe("an id no NOTATIONS entry carries fails, naming the id — before the node ever turns it into UnknownNotation", () => {
  test("fails with the notation itself", () => {
    const result = compileEnvisionNotation({ notation: "cobol", destination: DESTINATION })
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBe("cobol")
  })
})
