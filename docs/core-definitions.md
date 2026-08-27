# Core definitions

The graph workflow is built on Effect's native model: a GraphNode is
`Effect<Success, ErrorCodes, Requirements>`.

## GraphNode

One definition covering both GraphNodes and requirements (same shape). A GraphNode is a
Schema-typed function returning an Effect. There is no script/agent distinction — what a GraphNode
needs (a shell, an agent) is just its requirements.

- **description**
- **input** — a Schema for what it needs.
- **success** — a Schema for what it produces.
- **error codes** — the Effect error channel: one `Data.TaggedError` class per code, exported next
  to the GraphNode. Every GraphNode declares at least one. Routing (`onFail`, retries) keys off the tag via
  `catchTag`.
- **notes**

A **requirement** is a GraphNode whose success output shapes the graph: it provides context or
services other GraphNodes require. Example: scan the repo for Storybook; on success, downstream GraphNodes
learn components need stories; on `NO_STORYBOOK`, the storybook GraphNodes never load.

## Artifact references are the default output

An agent-bearing GraphNode whose output is document-shaped (prose a human or a later node reads —
a design, a build summary, a set of review findings) writes it to the run directory
(`RunInfo.runRoot`) and returns the path, not the text.
The run directory is the run's append-only record: a document written there once is immutable
history everything else points at, instead of being duplicated into the journal row
(`journaled.ts`'s `encodeBestEffort`) and riding a downstream prompt's argv, where an oversized
prompt dies at `execve`.

Scalar facts — a branch name, a commit count, a cost — stay inline in the success payload; only
document-shaped prose gets the artifact treatment. The node computes its own artifact path and
verifies the file mechanically (exists, non-empty) before returning or failing; a graph that
splices one node's artifact into a later node's prompt passes the reference and instructs the
downstream agent to read the file, never inlining the document. `design` established the
shape; every other agent-bearing GraphNode that produces document-shaped output follows it.

## Just-in-Time GraphNode

Loaded on demand; not guaranteed to run for every codebase or workflow. Composed of GraphNodes.
In Effect terms it's Layer composition: layers build lazily and are memoized, so a GraphNode whose
required service is never provided never enters the graph.

Definition: [`graph-node.definition.ts`](../plugins/mag/src/runtime/graph-node.definition.ts). Worked example:
[`detect-svelte`](../plugins/mag/src/graph-nodes/detect-svelte/graph-node.ts) — a requirement built through `make`,
mechanical (no agent), reading the target's manifests and failing when nothing declares Svelte.
