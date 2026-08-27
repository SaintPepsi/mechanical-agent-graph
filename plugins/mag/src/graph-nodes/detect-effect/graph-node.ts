import { Effect, Schema } from "effect"
import { EffectManifestMalformed, EffectManifestUnreadable } from "mag/graph-nodes/detect-effect/errors"
import { make } from "mag/runtime/graph-node.definition"
import { candidates, declaring, readManifests } from "mag/runtime/manifest"
import { platform } from "mag/runtime/platform"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { EFFECT } from "mag/skills/design/envisioning"

/** The dependency name this probe looks for, in `dependencies` or `devDependencies` alike (`readManifests`' own union). */
const DEPENDENCY = "effect"

/**
 * A mechanical stack probe — no agent, no model session — same shape as `detect-svelte`, a
 * different dependency name: reads a manifest the ticket plausibly touches and answers whether it
 * declares `effect`. `text` is the ticket's own title+body, not the discover artifact (discover
 * runs in parallel with this probe, `design-graph/graph.ts`'s barrier). Runs at `RunInfo.workRoot`
 * (`workdir`), read from context rather than taken as a parameter.
 */
export const detectEffect = make({
  name: "detect-effect",
  description: "Probe whether a manifest the ticket touches declares effect, mechanically, with no agent.",
  input: Schema.Struct({ text: Schema.String }),
  success: Schema.Struct({
    stack: Schema.Literal(EFFECT),
    matched: Schema.Boolean,
    manifests: Schema.Array(Schema.String)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      const root = workdir(runInfo)
      const manifests = yield* readManifests(
        root,
        (failure) => new EffectManifestUnreadable(failure),
        (failure) => new EffectManifestMalformed(failure)
      )
      const matching = declaring(candidates(manifests, input.text), DEPENDENCY)
      return { stack: EFFECT, matched: matching.length > 0, manifests: matching.map((manifest) => manifest.path) }
    }).pipe(Effect.provide(platform))
})
