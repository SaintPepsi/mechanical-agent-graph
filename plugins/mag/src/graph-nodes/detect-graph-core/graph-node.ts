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
 * The ticket's own declaration that it touches GraphNodes (`PRINCIPLES.md`, "Tickets that touch
 * GraphNodes name them up top"): a `GraphNodes:` line carrying at least one backticked name. A
 * line with none names no node, and the probe does not match on it.
 */
const namesGraphNodes = (text: string): boolean => /^GraphNodes:.*`[^`\n]+`/m.test(text)

/**
 * A mechanical stack probe, no agent, no model session. Unlike `detect-svelte`/`detect-effect`
 * this isn't a dependency lookup: it asks whether the root manifest's own `name` is this
 * repository's, which is why it picks the manifest at `package.json` (the walk finds nested
 * manifests too, and only the root's name states identity) rather than `declaring`. Runs at
 * `RunInfo.workRoot` (`workdir`), read from context rather than taken as a parameter.
 *
 * `text` is the ticket's own title+body, `detect-svelte`'s field, but it scopes the ticket rather
 * than the manifest: a match needs this repository AND a `GraphNodes:` line naming at least one
 * node. A ticket in this repository that names none is not a GraphNode ticket, and the graph-core
 * envisioning notation it would select drew nothing useful on the two trial runs that had no
 * GraphNode to draw, so the repository's identity alone is not a match.
 */
export const detectGraphCore = make({
  name: "detect-graph-core",
  description: "Probe whether the target repo IS mechanical-agent-graph and the ticket names a GraphNode, mechanically, with no agent.",
  input: Schema.Struct({ text: Schema.String }),
  success: Schema.Struct({
    stack: Schema.Literal(GRAPH_CORE),
    matched: Schema.Boolean,
    manifests: Schema.Array(Schema.String)
  }),
  run: (input) =>
    Effect.gen(function* () {
      if (!namesGraphNodes(input.text)) return { stack: GRAPH_CORE, matched: false, manifests: [] }
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
