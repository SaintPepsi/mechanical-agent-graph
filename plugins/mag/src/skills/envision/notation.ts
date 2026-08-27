import { Result } from "effect"
import { concernForNotation } from "mag/skills/design/envisioning"

export interface EnvisionNotationParams {
  readonly notation: string
  readonly destination: string
}

/**
 * The discipline every notation dispatch carries, stated once so it rides in identical words rather
 * than being repeated per module. Leaves what already exists to `discover`'s own recon: an
 * envisioning session is blind to the repo by construction, the same rule
 * `envision-mermaid`/`envision-rail-sketch`'s own doc splices already teach, made a named constant
 * here because this is the one place a design run's four notations all pass through.
 */
export const BLIND_DRAW_RULE =
  "Draw the ideal shape of the built thing, imagined as if from nothing. Reference no current file " +
  "path, annotate nothing as already existing, and leave what already exists to discover's own recon."

/** Single home for a notation's vision destination — `write-and-confirm.ts`'s `DESIGN_DESTINATION`
 * precedent: the prompt that names the path and the node that checks it both read this. */
export const visionDestination = (ticket: string, notation: string): string => `docs/graph/${ticket}/vision-${notation}.md`

/**
 * `envision-notation`'s whole prompt, `envision-mermaid`/`envision-rail-sketch`'s sibling — flat
 * params plus a pure renderer, no `Concern`, because nothing splices this into a multi-concern
 * variant. Resolves the notation through `concernForNotation`
 * (`skills/design/envisioning.ts`'s own map, the one home for the id-to-module fact) rather than a
 * second lookup authored here, and fails the same `Result` `concernForNotation` would: the node is
 * the one place that turns that failure into `UnknownNotation`. `module` rides alongside the
 * composed text so the node never has to resolve the notation a second time to learn what it
 * dispatched.
 */
export const compileEnvisionNotation = (params: EnvisionNotationParams): Result.Result<{ readonly prompt: string; readonly module: string }, string> => {
  const concern = concernForNotation(params.notation)
  if (Result.isFailure(concern)) return Result.fail(concern.failure)

  // Every notation `concernForNotation` can resolve carries a `section` — STACKS' three plus
  // `envisionGeneric` (`skills/design/envisioning.ts`'s closed set) — so this is a real invariant,
  // not a guess.
  const body = concern.success.section!.body(null)
  return Result.succeed({
    prompt: `${BLIND_DRAW_RULE}\n\n${body}Write the vision to \`${params.destination}\`.`,
    module: concern.success.id
  })
}
