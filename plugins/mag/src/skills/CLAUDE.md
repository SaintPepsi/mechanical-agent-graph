# `plugins/mag/src/skills/` — compiled-skill pattern

- A compiled skill's definition is TypeScript data (front-matter, citation roots, checklist steps,
  a pure `renderInstalled`-style renderer) and it lives here, in this directory, not beside any
  one consuming node. The only markdown a definition reads is a maintainer-authored envisioning
  doc under `plugins/mag/docs/envision/`, imported whole as text (`with { type: "text" }`) and
  spliced past its title line by `envisionDocBody` (`skills/design/concern.ts`). Nothing parses a
  `.md` file for structure, because a markdown file's structure is not a stable contract.
- **One concern, one module**: a compiled skill's prompt is not one wall
  of prose. Each concern of the prompt — the thing you'd point to if asked "where does this skill say
  X" — is its own file under `skills/<skill>/<concern>.ts`, exporting one `Concern` (`skills/design/concern.ts`).
  A variant is an ordered list of concern references (`skills/design/variants.ts`), composed by one
  pure renderer (`skills/design/compose.ts`). Adding a concern is a module plus a line in a list, never
  an edit to another concern's prose or to the composer's `if` statements — the composer has none that
  know a concern's name. A variant pinned to an installed document's own shape (`INSTALLED_DESIGN`,
  `skills/design/variants.ts`) is still just an ordered concern list, rendered through the same
  composer, never a second copy of their prose.
- **A new stack's envisioning module is coached, not invented**: a session
  that needs a concern for a stack with none does not write its discipline from what it just met. It
  is coached out of the maintainer with `plugins/mag/skills/envision/` (`/mag:envision`), which
  lands `plugins/mag/docs/envision/<slug>.envision.md` in the maintainer's own words. That doc is then
  source material for a hand-written module ticket, which cites it and states the problem the module
  solves with its evidence.
  `plugins/mag/docs/envision/svelte-ui-components.envision.md` is the worked example.
- `mag/skills/*` is a sanctioned `import-surface` seam (`ALLOW_RULES` in
  `mag/runtime/graph-node.shape.ts`), the same treatment as `mag/runtime` — an audited shared
  namespace a node is allowed to reach into, rather than a copy of the definition it has to own.
- A consuming node imports the definition from here and compiles its own variant inside its own
  runtime: at dispatch, inside the node's `run` Effect, not at module load. The compiled text goes
  straight into the agent's prompt. Agents are never told to go locate a skill file.
- At most one variant is ever materialized to disk: the installed skill under
  `plugins/mag/skills/<name>/SKILL.md`, written by the `compile-skill` GraphNode
  (`graph-nodes/compile-skill/`, `mag compile-skill`) and drift-gated (a test fails the suite if a
  fresh compile disagrees byte-for-byte with what's on disk). Every other variant (a graph node's
  own) renders on demand, in memory, and never touches disk.
- What stays here: the definition modules themselves, and `installed.ts`, the manifest stating
  where installed skills live (`SKILLS_ROOT`), which variants are materialized (`INSTALLED_SKILLS`),
  and how a row becomes a destination (`installedPath`) — pure data and composition, no I/O.
  `compile-skill` is the only thing that writes bytes to disk: new pipeline behaviour is a GraphNode
  first — a loose script is not a sanctioned home for it.
