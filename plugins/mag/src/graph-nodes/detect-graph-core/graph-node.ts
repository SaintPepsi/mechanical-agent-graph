import { Effect, Schema } from "effect"
import { GraphCoreManifestMalformed, GraphCoreManifestUnreadable } from "mag/graph-nodes/detect-graph-core/errors"
import { make } from "mag/runtime/graph-node.definition"
import { readManifests } from "mag/runtime/manifest"
import { platform } from "mag/runtime/platform"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { GRAPH_CORE } from "mag/skills/design/envisioning"

/**
 * This repository's identity is a declared fact, not a
 * structural probe. Looking for `graph-node.definition.ts` on disk would also match a checkout that
 * vendored a copy of this pipeline, which is not the same claim as "this is the repository the
 * pipeline develops itself in" — the same reasoning `graphs/conflict-graph/graph.ts`'s `BASE_BRANCH`
 * states for a per-repo policy constant living in the thing that needs it.
 */
const REPOSITORY_NAME = "mechanical-agent-graph"

/**
 * A mechanical stack probe — no agent, no model session. Unlike `detect-svelte`/`detect-effect`
 * this isn't a dependency lookup: it asks whether the root manifest's own `name` is this
 * repository's, which is why it picks the manifest at `package.json` (the walk finds nested
 * manifests too, and only the root's name states identity) rather than `declaring`. Runs at
 * `RunInfo.workRoot` (`workdir`), read from context rather than taken as a parameter, which is
 * also why `input` is empty.
 *
 * `detect-svelte`/`detect-effect` carry a `text` input to scope which manifest a
 * dependency-declaration can match against (`runtime/manifest.ts`'s `candidates`), because a
 * second, unrelated manifest declaring the same dependency anywhere in the checkout would
 * otherwise match every ticket. This node isn't subject to that problem: it already looks at
 * exactly one manifest, the workspace root, by construction — no `text` to scope against, so its
 * input stays `{}`.
 */
export const detectGraphCore = make({
  name: "detect-graph-core",
  description: "Probe whether the target repo IS mechanical-agent-graph itself, mechanically, with no agent.",
  input: Schema.Struct({}),
  success: Schema.Struct({
    stack: Schema.Literal(GRAPH_CORE),
    matched: Schema.Boolean,
    manifests: Schema.Array(Schema.String)
  }),
  run: () =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      const root = workdir(runInfo)
      const manifests = yield* readManifests(
        root,
        (failure) => new GraphCoreManifestUnreadable(failure),
        (failure) => new GraphCoreManifestMalformed(failure)
      )
      const rootManifest = manifests.find((manifest) => manifest.path === "package.json")
      if (rootManifest !== undefined && rootManifest.name === REPOSITORY_NAME) {
        return { stack: GRAPH_CORE, matched: true, manifests: [rootManifest.path] }
      }
      return { stack: GRAPH_CORE, matched: false, manifests: [] }
    }).pipe(Effect.provide(platform))
})
