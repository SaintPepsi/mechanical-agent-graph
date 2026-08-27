import { Console, Data, Effect, FileSystem } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { DEFAULT_GRAPH_NODES_ROOT, DEFAULT_GRAPHS_ROOT, scan, SPECIFIER_PREFIX } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"

/**
 * Derives a graph or composite node's own topology from its source — never from running
 * it — and renders it as mermaid. The ruled shape: code
 * stays the execution, the picture is a read-only projection of it. Nothing here is Schema-decoded
 * and nothing here is a runtime input: this module is built in-process from files and rendered to
 * stdout in the same expression, the same reasoning `ps.ts` already carries for its own table.
 *
 * Wired as a `"raw"` registry entry, `ps`'s own precedent: every GraphNode's stdout
 * contract is one JSON line (`render.ts`'s `renderSuccess`), the wrong shape for a diagram a human
 * pastes into a document.
 */

/** One `<node>.run(` call site in a level's source, in source order. */
export interface Step {
  readonly node: string
  readonly depth: number
  readonly inLoop: boolean
}

/** One drawable file: a graph, or a composite node reached from one. */
export interface Level {
  readonly node: string
  readonly steps: readonly Step[]
}

export interface Topology {
  readonly root: string
  readonly levels: readonly Level[]
}

/** Data, not services: the two directories a name can resolve against. */
export interface SourceRoots {
  readonly graphs: string
  readonly graphNodes: string
}

/** `readSource` resolved to no file under either root — a typo, `ps` (no node file), or a graph whose filename has drifted from its `name` field. */
export class TopologySourceMissing extends Data.TaggedError("TOPOLOGY_SOURCE_MISSING")<{
  readonly name: string
  readonly looked: readonly string[]
}> {}

/** A name resolved to a real path, but the read itself failed (permissions, and the like). */
export class TopologySourceUnreadable extends Data.TaggedError("TOPOLOGY_SOURCE_UNREADABLE")<{
  readonly file: string
  readonly detail: string
}> {}

/** Where `graphs/` and `graph-nodes/` are, assembled from the two constants the runtime shape module already owns. */
export const SOURCE_ROOTS: SourceRoots = { graphs: DEFAULT_GRAPHS_ROOT, graphNodes: DEFAULT_GRAPH_NODES_ROOT }

/** A sibling's own `graph-node` module — never `errors`, never a private file — the same restriction `graph-node.shape.ts`'s `siblingPublicSurface` applies for a different reason. */
const NODE_SPECIFIER = /^mag\/graph-nodes\/([^/]+)\/graph-node$/

/**
 * An import clause's whole content, between `import`/`import type` and `from`. Each alternative is
 * its own bounded shape (an identifier, a `{...}` group whose class excludes braces, or a
 * combination) rather than one generic `[^]*?` wildcard capture — a wildcard has no way to tell "the
 * end of THIS clause" from "the end of the file", so on a source with more than one import statement
 * it grows past the nearest `from` and swallows every earlier import too (caught by `nodeBindings`
 * against the real tree: every module with 2+ node imports bound none of them). A bounded shape fails
 * to match at an earlier `import` keyword (nothing after its own clause reaches the tested string's
 * end) and the engine's plain left-to-right search retries at the next one, which is what makes this
 * land on the *nearest* import to the literal. `[^{}]*` (not `.`) still spans newlines for free,
 * for the same reason a `[^}]*` would: `masked` carries no line structure to break on.
 *
 * The final alternative, `[^\n{}]*`, is a deliberately bounded catch-all for a well-formed but
 * unrecognized single-line clause (`import branch, * as ns from "..."`, no house-style precedent) —
 * bounded to one line and brace-free so it still can't cross into an earlier import statement, the
 * same failure mode the first four alternatives are built to avoid. It exists so such a clause is
 * *captured* (and then fails every classifier below, and throws) rather than making the whole
 * `IMPORT_CLAUSE` match fail, which would be indistinguishable from "not an import declaration at
 * all" and silently drop the edge instead of erroring on it.
 */
const IMPORT_CLAUSE =
  /import\s+(?:type\s+)?(\*\s*as\s+[$\w]+|[$\w]+\s*,\s*\{[^{}]*\}|[$\w]+|\{[^{}]*\}|[^\n{}]*)\s*from\s*$/

const NAMESPACE_CLAUSE = /^\*\s*as\s+([$\w]+)$/
const NAMED_CLAUSE = /^\{([^]*)\}$/
const DEFAULT_AND_NAMED_CLAUSE = /^([$\w]+)\s*,\s*\{([^]*)\}$/
const DEFAULT_ONLY_CLAUSE = /^([$\w]+)$/

/** One `{ a, b as c }` named clause's entries, `nodeName` fixed for every entry — `b as c` binds the alias `c`, since that's the identifier the call site actually uses. */
const namedBindings = (body: string, nodeName: string): ReadonlyArray<readonly [string, string]> =>
  body
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parts = entry.split(/\s+as\s+/)
      const local = (parts[1] ?? parts[0]).trim()
      return [local, nodeName] as const
    })

/**
 * Local binding name -> node name, for imports of a sibling's
 * `graph-node` module only. `shell.run(` never appears here — `Shell` is a service import, not a
 * `graph-nodes/*\/graph-node` one — which is what keeps it out of `stepsIn`'s picture by
 * construction rather than by a name-based special case.
 *
 * Handles every import form, not just the named-clause one: renamed (`{ branch as b }`), default,
 * namespace (`* as branch`), and mixed (`def, { branch }`) must each resolve to a binding, or a
 * real call site vanishes from the picture with no error. All four are handled below. A specifier
 * that is clearly a node-module import (matches `NODE_SPECIFIER`) but whose clause matches none of
 * the four known shapes throws rather than dropping the edge (PRINCIPLES.md, "Unfit paths should
 * error") — a form this scanner doesn't recognise is a reason to look at the source, not to draw a
 * diagram missing an edge. A clause that isn't an `import ... from` declaration at all (an
 * `export { x } from "..."`, which introduces no local binding a call site could use) is not an
 * error: there is nothing to bind, by construction.
 */
export const nodeBindings = (source: string): ReadonlyMap<string, string> => {
  const { literals, masked } = scan(source)
  const bindings = new Map<string, string>()

  for (const literal of literals) {
    if (!SPECIFIER_PREFIX.test(literal.before)) continue
    const specifier = NODE_SPECIFIER.exec(literal.body)
    if (specifier === null) continue
    const nodeName = specifier[1]

    const clauseMatch = IMPORT_CLAUSE.exec(masked.slice(0, literal.start))
    if (clauseMatch === null) continue // not an `import ... from` declaration — nothing local to bind
    const clause = clauseMatch[1].trim()

    const namespaceMatch = NAMESPACE_CLAUSE.exec(clause)
    if (namespaceMatch !== null) {
      bindings.set(namespaceMatch[1], nodeName)
      continue
    }

    const namedMatch = NAMED_CLAUSE.exec(clause)
    if (namedMatch !== null) {
      for (const [local, name] of namedBindings(namedMatch[1], nodeName)) bindings.set(local, name)
      continue
    }

    const mixedMatch = DEFAULT_AND_NAMED_CLAUSE.exec(clause)
    if (mixedMatch !== null) {
      bindings.set(mixedMatch[1], nodeName)
      for (const [local, name] of namedBindings(mixedMatch[2], nodeName)) bindings.set(local, name)
      continue
    }

    const defaultMatch = DEFAULT_ONLY_CLAUSE.exec(clause)
    if (defaultMatch !== null) {
      bindings.set(defaultMatch[1], nodeName)
      continue
    }

    throw new Error(`nodeBindings: unrecognized import clause for a node module "${nodeName}": "${clause}"`)
  }

  return bindings
}

const IDENTIFIER_CHAR = /[$\w]/

/** The identifier immediately adjacent to `pos` (no whitespace skipped) — used both for `<binding>.run(` and for the keyword just before a brace. */
const identifierBefore = (text: string, pos: number): string => {
  let start = pos
  while (start > 0 && IDENTIFIER_CHAR.test(text[start - 1])) start--
  return text.slice(start, pos)
}

const skipWhitespaceBack = (text: string, pos: number): number => {
  let at = pos
  while (at > 0 && /\s/.test(text[at - 1])) at--
  return at
}

/** The offset of the `(` matching the `)` at `closeParenPos`, tracking nesting depth backward. `-1` when unbalanced. */
const matchingOpenParen = (text: string, closeParenPos: number): number => {
  let depth = 0
  for (let at = closeParenPos; at >= 0; at--) {
    if (text[at] === ")") depth++
    else if (text[at] === "(") {
      depth--
      if (depth === 0) return at
    }
  }
  return -1
}

/**
 * Does the `{` at `bracePos` open a `for`/`while`/`do` block — the scan's
 * declared scope, nothing wider (no `Effect.repeat`, no `Effect.forEach`, no recursion). `for (...)
 * {`/`while (...) {` are read by walking back over the balanced `(...)` to the keyword before it;
 * `do {` has no parens, so the keyword sits directly before the brace.
 */
const isLoopHeader = (masked: string, bracePos: number): boolean => {
  const beforeBrace = skipWhitespaceBack(masked, bracePos)
  if (masked[beforeBrace - 1] === ")") {
    const openParen = matchingOpenParen(masked, beforeBrace - 1)
    if (openParen < 0) return false
    const word = identifierBefore(masked, skipWhitespaceBack(masked, openParen))
    return word === "for" || word === "while"
  }
  return identifierBefore(masked, beforeBrace) === "do"
}

const CALL_SUFFIX = ".run("

/**
 * Every `<binding>.run(` call site in source order, `binding` looked
 * up against `nodeBindings` so a non-node binding (`shell`, most commonly) is skipped by
 * construction rather than special-cased. `depth` is the brace nesting at the call site and
 * `inLoop` is true when any enclosing frame is a loop frame — both read off `scan`'s `masked`
 * projection, comments/strings/regex literals blanked out so neither can hide or fake a brace.
 */
export const stepsIn = (source: string): readonly Step[] => {
  const { masked } = scan(source)
  const bindings = nodeBindings(source)
  const steps: Step[] = []
  const loopStack: boolean[] = []

  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === "{") {
      loopStack.push(isLoopHeader(masked, i))
      continue
    }
    if (ch === "}") {
      loopStack.pop()
      continue
    }
    if (ch === "." && masked.startsWith(CALL_SUFFIX, i)) {
      const node = bindings.get(identifierBefore(masked, i))
      if (node !== undefined) {
        steps.push({ node, depth: loopStack.length, inLoop: loopStack.includes(true) })
      }
    }
  }

  return steps
}

/**
 * `fs.exists`'s own failure reads as "not there" — the caller only ever needs a yes/no to pick
 * between the two candidate paths. `FileSystem` is yielded from `R` inside this Effect rather than
 * threaded through a parameter (PRINCIPLES.md, "Services ride the R channel").
 */
const existsOrFalse = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)))
  })

/**
 * A name to the text that defines it — `graphs/<name>/graph.ts` first, else
 * `graph-nodes/<name>/graph-node.ts`, else `TopologySourceMissing` — a name that resolves to
 * nothing dies named rather than rendering an empty diagram (unfit paths should error). The one
 * I/O in the feature: `FileSystem` rides `R`, `roots` is data.
 */
export const readSource = Effect.fn("readSource")(function* (roots: SourceRoots, name: string) {
  const fs = yield* FileSystem.FileSystem
  const graphPath = `${roots.graphs}/${name}/graph.ts`
  const nodePath = `${roots.graphNodes}/${name}/graph-node.ts`

  const path = (yield* existsOrFalse(graphPath))
    ? graphPath
    : (yield* existsOrFalse(nodePath))
    ? nodePath
    : undefined

  if (path === undefined) {
    return yield* Effect.fail(new TopologySourceMissing({ name, looked: [graphPath, nodePath] }))
  }

  return yield* fs.readFileString(path).pipe(
    Effect.catch((error) => Effect.fail(new TopologySourceUnreadable({ file: path, detail: String(error) })))
  )
})

/**
 * A breadth-first walk from `root`, one `Level` per composite reached. `seen` both
 * terminates the walk and de-duplicates a node reachable from more than one path. No node ever
 * runs: `readSource` is a text read, never an `import()` — "without running any node" holds in the
 * strongest available sense.
 */
export const topologyOf = Effect.fn("topologyOf")(function* (roots: SourceRoots, root: string) {
  const levels: Level[] = []
  const seen = new Set<string>()
  const pending = [root]

  for (let at = 0; at < pending.length; at += 1) {
    const node = pending[at]
    if (seen.has(node)) continue
    seen.add(node)

    const source = yield* readSource(roots, node)
    const level: Level = { node, steps: stepsIn(source) }
    levels.push(level)
    pending.push(...level.steps.map((step) => step.node))
  }

  return { root, levels } satisfies Topology
})

const slug = (name: string): string => name.replace(/\W/g, "_")

/** A node reachable from `topology.root` that is itself a composite reads its own level, one node per graph level, rather than being drawn open. */
const compositeNames = (topology: Topology): ReadonlySet<string> =>
  new Set(topology.levels.filter((level) => level.steps.length > 0).map((level) => level.node))

const boxFor = (name: string, composites: ReadonlySet<string>): string => {
  const id = slug(name)
  return composites.has(name) ? `${id}[["${name}"]]` : `${id}["${name}"]`
}

/**
 * Renders a level's steps to one `flowchart TD` body. The spine is the level's
 * steps at their minimum depth; consecutive spine steps join with a solid arrow. A maximal run of
 * loop-marked spine steps is wrapped in `subgraph repeat_<n>[repeat]` — a per-run-unique mermaid id
 * (`repeat_1`, `repeat_2`, ...) with `repeat` kept only as the bracketed display title, since a level
 * with more than one loop run would otherwise emit the literal id `repeat` twice and mermaid ids
 * must be unique per diagram — closed by a dotted back-edge from its last
 * member to its first. Mermaid places a node in whichever subgraph it is *first* mentioned in, so
 * every member of a loop run is declared (its internal edges, then the `repeat` back-edge) before the
 * incoming boundary edge from the previous run is emitted — the boundary edge is pushed last, after
 * `end`, so it only ever references already-declared ids and never pulls a run's first node out of
 * its own box. A step deeper than the spine (a dispute call nested inside
 * `build-under-review`, for instance) draws a dotted `branch` edge from the nearest preceding spine step, or, when
 * no spine step precedes it (it is the level's very first step), from the nearest *following* spine
 * step instead — a level always has at least one spine step by construction (the minimum depth is
 * observed somewhere), so a step can be anchored on one side or the other but never fails to find
 * one; a level with exactly one non-loop step, with nothing to connect it to either side, still gets
 * its own bare box line. Every node id is declared with its bracketed label on first mention only;
 * later references reuse the bare id, mermaid's own rule for "the same node again."
 */
export const renderMermaid = (level: Level, composites: ReadonlySet<string>): string => {
  const steps = level.steps
  if (steps.length === 0) {
    return `flowchart TD\n  ${boxFor(level.node, composites)}\n`
  }

  const declared = new Set<string>()
  const ref = (name: string): string => {
    if (declared.has(name)) return slug(name)
    declared.add(name)
    return boxFor(name, composites)
  }

  const minDepth = Math.min(...steps.map((step) => step.depth))
  const spineIdx: number[] = []
  steps.forEach((step, i) => {
    if (step.depth === minDepth) spineIdx.push(i)
  })

  interface Run {
    readonly inLoop: boolean
    readonly idx: number[]
  }
  const runs: Run[] = []
  for (const i of spineIdx) {
    const inLoop = steps[i].inLoop
    const current = runs[runs.length - 1]
    if (current !== undefined && current.inLoop === inLoop) current.idx.push(i)
    else runs.push({ inLoop, idx: [i] })
  }

  const lines: string[] = []
  let prevIdx: number | undefined
  let repeatCount = 0
  for (const run of runs) {
    if (run.inLoop) {
      repeatCount += 1
      lines.push(`  subgraph repeat_${repeatCount}[repeat]`)
    }
    const indent = run.inLoop ? "    " : "  "
    for (let k = 0; k < run.idx.length - 1; k++) {
      lines.push(`${indent}${ref(steps[run.idx[k]].node)} --> ${ref(steps[run.idx[k + 1]].node)}`)
    }
    if (run.inLoop) {
      const first = steps[run.idx[0]].node
      const last = steps[run.idx[run.idx.length - 1]].node
      lines.push(`${indent}${ref(last)} -.->|repeat| ${ref(first)}`)
      lines.push("  end")
    }
    // Emitted last, after the run's own nodes are declared (and `end` closes the subgraph, if any):
    // the boundary edge only ever references already-declared ids, so it can never be the first
    // mention that decides a node's box.
    if (prevIdx !== undefined) {
      lines.push(`  ${ref(steps[prevIdx].node)} --> ${ref(steps[run.idx[0]].node)}`)
    }
    prevIdx = run.idx[run.idx.length - 1]
  }

  // A level with exactly one non-loop step has one run of one member: no internal edge (nothing to
  // pair it with), no repeat back-edge (not a loop), and no boundary edge (no previous run). Nothing
  // above ever calls `ref` on it, so it is declared here instead of vanishing from the diagram.
  if (lines.length === 0) {
    lines.push(`  ${ref(steps[spineIdx[0]].node)}`)
  }

  const spineSet = new Set(spineIdx)
  let lastSpine: number | undefined
  for (let i = 0; i < steps.length; i++) {
    if (spineSet.has(i)) {
      lastSpine = i
      continue
    }
    // Anchor backward to the nearest preceding spine step; if none precedes (this step is deeper
    // than the spine from the level's very first step onward), anchor forward to the nearest
    // following one instead — `spineIdx` is never empty for a non-empty level, so one of the two
    // always exists — anchoring backward only would silently drop a leading deeper step with no
    // error and no edge.
    const anchor = lastSpine ?? spineIdx.find((idx) => idx > i)
    if (anchor === undefined) {
      throw new Error(`renderMermaid: step "${steps[i].node}" at index ${i} has no spine step to anchor to`)
    }
    lines.push(`  ${ref(steps[anchor].node)} -.->|branch| ${ref(steps[i].node)}`)
  }

  return `flowchart TD\n${lines.join("\n")}\n`
}

/**
 * One `## <name>` section per level that is either the requested root or a
 * composite (has steps of its own) — a leaf reached only as another level's step (`resolve-base`,
 * `push-branch`, and the like) draws as a plain box where it's referenced and gets no section of
 * its own. Requesting a leaf directly still renders something: the `level.node === topology.root`
 * half of the filter treats a zero-step level as a leaf, not a failure.
 */
export const renderMarkdown = (topology: Topology): string => {
  const composites = compositeNames(topology)
  const sections = topology.levels.filter((level) => level.steps.length > 0 || level.node === topology.root)
  return sections
    .map((level) => `## ${level.node}\n\n\`\`\`mermaid\n${renderMermaid(level, composites)}\`\`\`\n`)
    .join("\n")
}

/**
 * `mag topology`: a graph or composite node's shape, drawn from its own source, no node run.
 * A `"raw"` registry entry, `ps`'s own precedent — this output is for a human pasting a
 * diagram into a document, not a caller parsing a result.
 */
export const topologyCommand = Command.make(
  "topology",
  { graph: Flag.string("graph").pipe(Flag.withDescription("Graph or composite node to draw.")) },
  ({ graph }) =>
    topologyOf(SOURCE_ROOTS, graph).pipe(
      Effect.map(renderMarkdown),
      Effect.flatMap(Console.log),
      Effect.provide(platform)
    )
).pipe(
  Command.withDescription("Render a graph or composite node's topology as mermaid, derived from its source.")
)
