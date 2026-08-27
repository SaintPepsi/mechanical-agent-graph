import { Data, Effect, FileSystem, Result } from "effect"

/**
 * The one grammar over a mermaid vision, applied to both the shipped drawing and a blind
 * derivation's own drawing: the same reader on both sides,
 * so the diff is arithmetic and not opinion. A pure grammar, not a service:
 * nothing about parsing a document needs
 * to be swapped per run.
 */

/** A drawing lifted to its three element kinds — nodes, edges, conditions — each keyed by the name it was written under. */
export interface Shape {
  readonly nodes: readonly string[]
  readonly edges: readonly string[]
  readonly conditions: readonly string[]
}

/** The document holds no railway this grammar can lift: no fenced mermaid, or a fence with no boxes. */
export class VisionUnreadable extends Data.TaggedError("VISION_UNREADABLE")<{
  readonly path: string
  readonly excerpt: string
}> {}

const MERMAID_FENCE = /```mermaid\n([\s\S]*?)```/

/** A quoted node's classification: a step contributes to `Shape.nodes`, a death is an edge endpoint only, a boundary box is excluded from both. */
type NodeKind = "step" | "death" | "boundary"
interface NodeInfo {
  readonly kind: NodeKind
  /** The step's name, or the death's error name — the key an edge endpoint resolves to. Unused for a boundary box. */
  readonly key: string
}

/**
 * `plugins/mag/docs/envision/graph-mermaid-notation.md`'s three bracket shapes, matched
 * independently rather than as one alternation: a subroutine box (`[[ ]]`) and a terminal (`[/ /]`)
 * never satisfy the plain box's own single-bracket pattern (the second bracket character fails the
 * plain pattern's own close), so the three cannot double-match the same box.
 */
const SUBROUTINE_BOX = /([A-Za-z_][A-Za-z0-9_]*)\[\[\s*"([^"]*)"\s*\]\]/g
const TERMINAL_BOX = /([A-Za-z_][A-Za-z0-9_]*)\[\/\s*"([^"]*)"\s*\/\]/g
const PLAIN_BOX = /([A-Za-z_][A-Za-z0-9_]*)\[\s*"([^"]*)"\s*\]/g
const BOX_PATTERNS = [SUBROUTINE_BOX, TERMINAL_BOX, PLAIN_BOX]

/** `A -- "label" --> B` (the green run) or `A -. "label" .-> B` (a departure) — the notation's own two edge forms. */
const EDGE = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:--|-\.)\s*"([^"]*)"\s*(?:-->|\.->)\s*([A-Za-z_][A-Za-z0-9_]*)/g

const DIE_PREFIX = "die: "
const TYPE_MARKER = " · "

/**
 * `graph-mermaid-notation.md`'s three box rules: a death's label opens with `die: `, its key the
 * error name up to `<br/>`; a step's label carries a ` · ` type marker, its key the head before it;
 * anything else (a boundary box: `IN`, `OUT`) carries neither and is excluded by every rule that
 * reads `NodeInfo.key`.
 */
const classify = (label: string): NodeInfo => {
  if (label.startsWith(DIE_PREFIX)) {
    const key = label.slice(DIE_PREFIX.length).split("<br/>")[0]!.trim()
    return { kind: "death", key }
  }
  const markerAt = label.indexOf(TYPE_MARKER)
  if (markerAt !== -1) {
    return { kind: "step", key: label.slice(0, markerAt).trim() }
  }
  return { kind: "boundary", key: label.trim() }
}

const isSubgraphLine = (line: string): boolean => /^\s*subgraph\b/.test(line)

const uniq = (values: readonly string[]): readonly string[] => [...new Set(values)]

/** `=`, `<`, `>`, `≠`, `!=`, `<=`, `>=`: the notation's "field and the value that fires it" always carries one. */
const OPERATOR = /[=<>≠]/

/**
 * The firing clause of a conditional edge, or `undefined` for an edge that has none. The clause is the label
 * text before its first `:` or `→`, whichever comes first, or the whole label when neither appears
 * (`verdict = rejected` on a death edge, the notation doc's own example). A clause that opens with
 * `(` is a gate annotation (`(gate: pushed) → pushed`), one that opens with `fails` is a death's
 * error list (`fails: PushDirty | PushEmpty`), and a clause cut at `→` with no operator is the
 * left side of a plain mapping (`path → (gate: …)`, `base? → base`); none of those fire anything.
 * Only a clause cut at `:` may read as prose (`clean stage: treeSha → headSha`): the colon is the
 * notation's explicit "clause, then mapping" separator, so prose before it is the author's clause.
 */
const firingClause = (label: string): string | undefined => {
  const colonAt = label.indexOf(":")
  const arrowAt = label.indexOf("→")
  const cuts = [colonAt, arrowAt].filter((at) => at !== -1)
  const cutAt = cuts.length === 0 ? label.length : Math.min(...cuts)
  const clause = label.slice(0, cutAt).replace(/\s+/g, " ").trim()
  if (clause === "" || clause.startsWith("(") || clause.startsWith("fails")) return undefined
  if (cutAt === colonAt) return clause
  return OPERATOR.test(clause) ? clause : undefined
}

/**
 * Lifts a `Shape` from one mermaid vision's text. `path` never drives
 * the parse; it rides only onto {@link VisionUnreadable} so a caller comparing two documents can
 * say which one failed.
 */
export const readShape = (path: string, text: string): Result.Result<Shape, VisionUnreadable> => {
  const fence = MERMAID_FENCE.exec(text)
  if (fence === null) {
    return Result.fail(new VisionUnreadable({ path, excerpt: text.slice(0, 200) }))
  }
  const lines = fence[1]!.split("\n")

  // Pass 1: every box, on its own line or inline as an edge's target (`DEADV[/"die: ..."/]`
  // appears only where the edge that reaches it is drawn) — a
  // `subgraph Prepare["prepare"]` region title carries the same bracket-plus-quote shape and is
  // excluded by the line filter alone, never by its bracket style.
  const nodesById = new Map<string, NodeInfo>()
  for (const line of lines) {
    if (isSubgraphLine(line)) continue
    for (const pattern of BOX_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(line)) !== null) {
        nodesById.set(match[1]!, classify(match[2]!))
      }
    }
  }

  if (nodesById.size === 0) {
    return Result.fail(new VisionUnreadable({ path, excerpt: text.slice(0, 200) }))
  }

  const nodes = [...nodesById.values()].filter((info) => info.kind === "step").map((info) => info.key)

  // Pass 2: every edge whose both ends resolve to a step or a death; one touching a boundary box,
  // or an id no box declared, is dropped rather than guessed at.
  const edges: string[] = []
  const conditions: string[] = []
  for (const line of lines) {
    if (isSubgraphLine(line)) continue
    EDGE.lastIndex = 0
    const match = EDGE.exec(line)
    if (match === null) continue
    const from = nodesById.get(match[1]!)
    const to = nodesById.get(match[3]!)
    if (from === undefined || to === undefined) continue
    if (from.kind === "boundary" || to.kind === "boundary") continue

    edges.push(`${from.key} -> ${to.key}`)

    const clause = firingClause(match[2]!)
    if (clause !== undefined) conditions.push(`${from.key} -> ${to.key} when ${clause}`)
  }

  return Result.succeed({ nodes: uniq(nodes), edges: uniq(edges), conditions: uniq(conditions) })
}

/**
 * {@link readShape} at a path: the Effect-side trust boundary both `stage-shipped-graph` and
 * `compare-vision` cross. A read failure folds into the same {@link VisionUnreadable} the grammar
 * itself returns, so one error covers "this path holds no railway a reader can lift" however it
 * failed. Lives beside the grammar rather than in either node: a node may import a sibling's
 * `graph-node`/`errors` but never a private helper like this one (`graph-node.shape.ts`'s
 * `ALLOW_RULES`), which promotes the helper here (`PRINCIPLES.md`, "it never copies it").
 */
export const readShapeAt = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs
      .readFileString(path)
      .pipe(Effect.catch((error) => Effect.fail(new VisionUnreadable({ path, excerpt: String(error) }))))
    return yield* Effect.fromResult(readShape(path, text))
  })
