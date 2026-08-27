import { Effect, Schema } from "effect"
import { SvelteManifestMalformed, SvelteManifestUnreadable } from "mag/graph-nodes/detect-svelte/errors"
import { make } from "mag/runtime/graph-node.definition"
import { candidates, declaring, readManifests } from "mag/runtime/manifest"
import { platform } from "mag/runtime/platform"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { SVELTE } from "mag/skills/design/envisioning"

/** The dependency name this probe looks for, in `dependencies` or `devDependencies` alike (`readManifests`' own union). */
const DEPENDENCY = "svelte"

/**
 * A mechanical stack probe — no agent, no model session — reads the target checkout's own
 * manifests (nested ones included, mono-repos) through the shared reader and answers whether a
 * manifest the ticket plausibly touches declares `svelte`. `text` is the ticket's own title+body
 * (`design-graph`'s dispatch), not the discover artifact: discover runs in parallel with this probe
 * (`design-graph/graph.ts`'s barrier), so its output isn't available yet. Runs at
 * `RunInfo.workRoot` (`workdir`), the run's own tree, read from context rather than taken as a
 * parameter: the probe's target is a run-scoped capability, not node input.
 */
export const detectSvelte = make({
  name: "detect-svelte",
  description: "Probe whether a manifest the ticket touches declares svelte, mechanically, with no agent.",
  input: Schema.Struct({ text: Schema.String }),
  success: Schema.Struct({
    stack: Schema.Literal(SVELTE),
    matched: Schema.Boolean,
    manifests: Schema.Array(Schema.String)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      const root = workdir(runInfo)
      const manifests = yield* readManifests(
        root,
        (failure) => new SvelteManifestUnreadable(failure),
        (failure) => new SvelteManifestMalformed(failure)
      )
      const matching = declaring(candidates(manifests, input.text), DEPENDENCY)
      return { stack: SVELTE, matched: matching.length > 0, manifests: matching.map((manifest) => manifest.path) }
    }).pipe(Effect.provide(platform))
})
