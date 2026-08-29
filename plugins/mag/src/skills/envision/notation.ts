import { Result } from "effect"
import { concernForNotation } from "mag/skills/design/envisioning"

export interface EnvisionShellParams {
  readonly notations: readonly string[]
  readonly destination: string
}

/**
 * The discipline every shell dispatch carries, stated once so it rides in identical words rather
 * than being repeated per module. Leaves what already exists to `discover`'s own recon: the shell
 * pass is blind to the repo by construction, the same rule `envision-mermaid`/`envision-rail-sketch`'s
 * own doc splices already teach, made a named constant here because this is the one place a
 * design run's notations all pass through.
 */
export const BLIND_DRAW_RULE =
  "Draw the ideal shape of the built thing, imagined as if from nothing. Reference no current file " +
  "path, annotate nothing as already existing, and leave what already exists to discover's own recon."

/** The one section the shell pass writes: `seams-ownership.ts`'s own template heading, the slot the design pass later completes around. */
export const SHELL_SECTION = "## Envisioned Shell"

/**
 * One notation's envisioning body, resolved through `concernForNotation`
 * (`skills/design/envisioning.ts`'s own map, the one home for the id-to-module fact) rather than a
 * second lookup authored here, and failing the same `Result` `concernForNotation` would: the node
 * is the one place that turns that failure into `UnknownNotation`. `module` rides alongside so the
 * node never has to resolve the notation a second time to learn what it dispatched.
 */
export const compileEnvisionNotation = (notation: string): Result.Result<{ readonly body: string; readonly module: string }, string> => {
  const concern = concernForNotation(notation)
  if (Result.isFailure(concern)) return Result.fail(concern.failure)

  // Every notation `concernForNotation` can resolve carries a `section`: STACKS' three plus
  // `envisionGeneric` (`skills/design/envisioning.ts`'s closed set), so this is a real invariant,
  // not a guess.
  return Result.succeed({ body: concern.success.section!.body(null), module: concern.success.id })
}

/**
 * `envision-shell`'s whole prompt, `envision-mermaid`/`envision-rail-sketch`'s sibling: flat
 * params plus a pure renderer, no `Concern`, because nothing splices this into a multi-concern
 * variant. The blind rule once, then every matched notation's body in the order given, then the
 * one write: the design doc with its shell section alone, which the design pass completes in
 * place. Fails on the first notation no module answers to.
 */
export const compileEnvisionShell = (params: EnvisionShellParams): Result.Result<{ readonly prompt: string; readonly modules: readonly string[] }, string> => {
  const bodies: string[] = []
  const modules: string[] = []
  for (const notation of params.notations) {
    const compiled = compileEnvisionNotation(notation)
    if (Result.isFailure(compiled)) return Result.fail(compiled.failure)
    bodies.push(compiled.success.body)
    modules.push(compiled.success.module)
  }
  return Result.succeed({
    prompt: `${BLIND_DRAW_RULE}\n\n${bodies.join("")}Write the design doc to \`${params.destination}\` with one section, \`${SHELL_SECTION}\`: the shell drawn above, one per notation named. The rest of the design is a later pass of this session.`,
    modules
  })
}
