import { Data, Effect, type Schema } from "effect"
import { graph } from "mag/runtime/graph"
import type { GraphNode } from "mag/runtime/graph-node.definition"
import { type GraphShape, SHAPE_SCHEMA, type ShapeEdge, type ShapeElement } from "mag/runtime/graph-shape"
import type { RunScope } from "mag/runtime/run-layers"
import { schemaFieldNames } from "mag/runtime/schema-fields"

/**
 * The rail-sketch's `Graph.construct` notation made real, so a graph's source reads the way its
 * rail-sketch draws it — `.fork`, `.join`, `.then`, `.when`, `.borrow`, `.replaceNode`,
 * `.removeWhen`, `.finalise` — instead of restating the same spine as a bare `Effect.gen`. The sketch
 * (`graphs/develop-graph/rail-sketch.md`) is the shape's source. No `.loop` (a loop lives inside
 * the composite node that owns it, `build-under-review`).
 *
 * A construct threads one growing context record through its stages. Each stage names a node, a
 * `wire` that picks the node's input off the context — the sketch's own edge labels
 * (`"ticket, title → ticket, title"`) as a function — and optionally a `keep` that renames what the
 * node's success merges back in (without it the success spreads in whole; pass `keep` when two
 * stages' fields would collide, e.g. every model node's `sessions`/`costUsd`). `.finalise` closes
 * the construct into an ordinary `graph()`: same `make`, same journal row, same conformance shape —
 * a construct is notation for a pipeline, never a second runtime.
 *
 * Borrowing must not mean editing (FR-9, `docs/requirements/graph-envisioning.md`). A stage
 * is data (`Step`) instead of an accumulated closure, so `.finalise` can fold a borrow's declared
 * bends (`Modifier`) into a fresh step list before deriving `run` from it — the borrowed graph's own
 * module never runs again, it is re-closed from the same steps it already published.
 */

type Wire<Ctx, I> = (ctx: Ctx) => I
/** One picker per field: what a stage renames its node's success into, and, because the keys are
 *  data, the list of fields that stage contributes to the context. */
type Keep<A, B extends object> = { readonly [K in keyof B]: (a: A) => B[K] }

/** The fields a decision declares, as a non-empty tuple of the context's own keys: a decision that
 *  reads nothing is not one the shape can draw an edge for. */
type Reads<Ctx> = readonly [keyof Ctx & string, ...Array<keyof Ctx & string>]

/** A decision as data: what it is called, what it reads, what it tests. `test` sees the declared
 *  fields and nothing else, so the list and the test cannot drift — there is only one list. */
type Decision<Ctx, R extends Reads<Ctx>> = {
  readonly name: string
  readonly reads: R
  readonly test: (fields: Pick<Ctx, R[number]>) => boolean
}

/** The step list's existential types: the list is heterogeneous, so its element types cannot be
 *  named per-Construct. The public `Construct<Seed, Ctx, E, R>` generics stay exact; these are
 *  confined to `Step`, the fold, and the modifier machinery below. */
type AnyNode = GraphNode<any, any, any, any>
type AnyWire = (ctx: any) => any
type AnyKeep = Record<string, (a: any) => any>
type AnyDecision = {
  readonly name: string
  readonly reads: readonly string[]
  readonly test: (ctx: any) => boolean
}
type AnyVia = (ctx: any) => Effect.Effect<any, any, any>

/** `removeWhen` / `replaceNode` as data, targeted by node value — the borrowing site's declared
 *  bend, carried to Finalise without touching the borrowed graph. */
export type Modifier =
  | { readonly kind: "removeWhen"; readonly target: AnyNode }
  | { readonly kind: "replaceNode"; readonly target: AnyNode; readonly replacement: AnyNode }

/** One construct stage as data. `.then`/`.borrow` share the `node` kind — a borrowed graph is
 *  already a node — and only a `node` step born of `.borrow`/`.borrowKeep` ever carries a
 *  non-empty `modifiers`, since only `Borrowed` exposes `.removeWhen`/`.replaceNode`. Exported so
 *  `construct.test.ts` can hand-build step lists for `applyModifiers`'s unit tests. */
export type Step =
  | {
    readonly kind: "node"
    readonly node: AnyNode
    readonly wire: AnyWire
    readonly keep?: AnyKeep
    readonly modifiers: readonly Modifier[]
  }
  | {
    readonly kind: "fork"
    readonly left: AnyNode
    readonly wireLeft: AnyWire
    readonly right: AnyNode
    readonly wireRight: AnyWire
  }
  | {
    readonly kind: "when"
    readonly decision: AnyDecision
    readonly node: AnyNode
    readonly wire: AnyWire
    readonly keep: AnyKeep
  }
  | { readonly kind: "via"; readonly name: string; readonly f: AnyVia; readonly keep: AnyKeep }

/** The one `node` step builder: every stage that runs a single node, and the unconditional step
 *  `removeWhen` rewrites a `when` into. */
const nodeStep = (node: AnyNode, wire: AnyWire, keep?: AnyKeep): Step =>
  ({ kind: "node", node, wire, keep, modifiers: [] })

/** A keep applied: a stage merges exactly the fields its keep names, each from its own picker. */
const applyKeep = (keep: AnyKeep, a: unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries(keep).map(([field, pick]) => [field, pick(a)]))

/** A finalised construct's published shape: its step list, and how to re-close a possibly-bent
 *  variant of it into a fresh `graph()` without restating any `.finalise` option. Held in a
 *  module-private table (below), never on the graph value itself. */
export type Blueprint = {
  readonly name: string
  readonly steps: readonly Step[]
  /** The heaviest per-site modifier tally anywhere in this graph's lineage: what a borrower of
   *  this node inherits before adding its own applications. */
  readonly applied: number
  readonly close: (steps: readonly Step[], applied: number) => AnyNode
}

/** Keyed by node identity, collected with it: gives the fold everything a published field would
 *  have, and gives the outside world nothing — the finalised graph stays exactly the value `make`
 *  returns (`runtime/graph.ts`'s `graph`, Hyrum's Law). A graph built as `graph({ pipeline })` has no
 *  entry: it publishes no steps and cannot be bent. */
const BLUEPRINTS = new WeakMap<AnyNode, Blueprint>()

/** Named ways a declared bend fails to mean one thing (FR-9, `docs/requirements/graph-envisioning.md`:
 *  never a silent no-op). Thrown, not
 *  returned: `.finalise` is pure and every construct is a top-level `const` (no Effect exists yet
 *  at declaration time to carry a typed failure) — the process dies at import, named, before any
 *  run starts (`topology.ts`'s `nodeBindings`, this repo's precedent for a construction-time
 *  throw). */
export class ModifierTargetMissing extends Data.TaggedError("MODIFIER_TARGET_MISSING")<{
  readonly graph: string
  readonly modifier: Modifier["kind"]
  readonly target: string
  readonly offered: readonly string[]
}> {}

export class ModifierTargetAmbiguous extends Data.TaggedError("MODIFIER_TARGET_AMBIGUOUS")<{
  readonly graph: string
  readonly modifier: Modifier["kind"]
  readonly target: string
  readonly matched: readonly string[]
}> {}

export class ModifierConflict extends Data.TaggedError("MODIFIER_CONFLICT")<{
  readonly graph: string
  readonly target: string
  readonly modifiers: readonly Modifier["kind"][]
}> {}

/** FR-12 (`docs/requirements/graph-envisioning.md`): a bend that means exactly what it says,
 *  too many times, not a way a declared bend fails to mean one thing, so it is named outside the
 *  `Modifier*` family for that reason. */
export class TooConvoluted extends Data.TaggedError("TOO_CONVOLUTED")<{
  readonly graph: string
  readonly site: string
  readonly applications: number
  readonly limit: number
}> {
  override get message(): string {
    return `${this.graph} at ${this.site} carries ${this.applications} modifier applications, ` +
      `past the limit of ${this.limit}: envision a new graph instead.`
  }
}

/** A declared read that resolves to nothing, below a stage whose contributed fields could not be
 *  enumerated: the type promised the field exists, so falling back to the entry would draw an edge
 *  that may be false. `opaque` names the stages that made the fallback unsafe. */
export class FieldHasNoProducer extends Data.TaggedError("FIELD_HAS_NO_PRODUCER")<{
  readonly container: string
  readonly decision: string
  readonly field: string
  readonly opaque: readonly string[]
}> {}

/** Two decisions at one address in one container. Carried as `decision`, never as `name`:
 *  `Data.TaggedError` assigns every payload key as an own property, so a member called `name` would
 *  shadow the tag and print the decision's own name where `DECISION_NAME_COLLIDES` belongs. */
export class DecisionNameCollides extends Data.TaggedError("DECISION_NAME_COLLIDES")<{
  readonly container: string
  readonly decision: string
}> {}

/** Every node slot a modifier of this kind could have meant: `removeWhen`'s candidates are guarded
 *  nodes only, `replaceNode`'s are every node any step runs. `describe` is what
 *  `ModifierTargetAmbiguous.matched` reports: the occurrence's position, not a repeat of the name
 *  the site already typed. A fork naming one target on both sides yields two entries, which is
 *  exactly the ambiguity `applyModifier` must catch. */
type Occurrence = { readonly index: number; readonly node: AnyNode; readonly describe: string }

const occurrences = (steps: readonly Step[], kind: Modifier["kind"]): readonly Occurrence[] =>
  steps.flatMap((step, index): readonly Occurrence[] => {
    switch (step.kind) {
      case "when":
        return [{ index, node: step.node, describe: `when[${index}]` }]
      case "node":
        return kind === "removeWhen" ? [] : [{ index, node: step.node, describe: `node[${index}]` }]
      case "fork":
        return kind === "removeWhen" ? [] : [
          { index, node: step.left, describe: `fork[${index}].left` },
          { index, node: step.right, describe: `fork[${index}].right` }
        ]
      case "via":
        return []
    }
  })

/** Past this many applications at one borrowing site, `.finalise` refuses rather than build a
 *  graph bent past recognition (FR-12, `docs/requirements/graph-envisioning.md`). */
const APPLICATION_LIMIT = 3

/** One site's tally: its own applications plus what the node it runs already carried in from being
 *  borrowed itself. Only a `node` step ever carries modifiers of its own; a `when` or `fork` step
 *  contributes only what its node already carried. */
const tallyAt = (step: Step, node: AnyNode): number =>
  (step.kind === "node" ? step.modifiers.length : 0) + (BLUEPRINTS.get(node)?.applied ?? 0)

/** The heaviest site's tally, what a finalised graph hands its next borrower: counts belong to
 *  sites and do not pool, so two independent sites at the limit each must both build. Sites are
 *  derived rather than counted, from `occurrences(steps, "replaceNode")`, the same "every node
 *  slot any step runs" enumeration `ModifierTargetAmbiguous` already reports, so a fork side or a
 *  guarded node is tallied exactly where a modifier could reach it. The first site past the limit,
 *  in step order, refuses and names itself; a second offender changes nothing about the
 *  instruction, so it goes unreported. */
const tallyApplications = (graphName: string, steps: readonly Step[]): number =>
  occurrences(steps, "replaceNode").reduce((heaviest, { describe, index, node }) => {
    const applications = tallyAt(steps[index], node)
    if (applications > APPLICATION_LIMIT) {
      throw new TooConvoluted({ graph: graphName, site: describe, applications, limit: APPLICATION_LIMIT })
    }
    return Math.max(heaviest, applications)
  }, 0)

/** `removeWhen` keeps the matched `when` step's wire and keep, dropping the whole decision — its
 *  name and declared reads included: the guarded node now runs unconditionally. */
const rewrite = (step: Step, modifier: Modifier): Step => {
  if (modifier.kind === "removeWhen") {
    if (step.kind !== "when") throw new Error("rewrite: removeWhen matched a non-when step")
    return nodeStep(step.node, step.wire, step.keep)
  }
  switch (step.kind) {
    case "node":
    case "when":
      return { ...step, node: modifier.replacement }
    case "fork":
      return {
        ...step,
        left: step.left === modifier.target ? modifier.replacement : step.left,
        right: step.right === modifier.target ? modifier.replacement : step.right
      }
    case "via":
      throw new Error("rewrite: replaceNode matched a via step")
  }
}

/** Resolves one modifier against a step list and returns the rewritten list. The only pure fold
 *  Finalise's borrow resolution runs: not exactly one match is the failure, not the absence
 *  of a rewrite (`PRINCIPLES.md`, "Unfit paths should error"). */
const applyModifier = (graphName: string, steps: readonly Step[], modifier: Modifier): readonly Step[] => {
  const candidates = occurrences(steps, modifier.kind)
  const matches = candidates.filter((candidate) => candidate.node === modifier.target)

  if (matches.length === 0) {
    throw new ModifierTargetMissing({
      graph: graphName,
      modifier: modifier.kind,
      target: modifier.target.name,
      offered: candidates.map((candidate) => candidate.node.name)
    })
  }
  if (matches.length > 1) {
    throw new ModifierTargetAmbiguous({
      graph: graphName,
      modifier: modifier.kind,
      target: modifier.target.name,
      matched: matches.map((match) => match.describe)
    })
  }

  const [{ index }] = matches
  return steps.map((step, i) => (i === index ? rewrite(step, modifier) : step))
}

/** Two modifiers at one site naming one target settle by declaration order, and order is the one
 *  thing a declaration site does not mean to express — so it is a conflict, not a resolution. */
const checkConflicts = (graphName: string, modifiers: readonly Modifier[]): void => {
  for (let i = 0; i < modifiers.length; i++) {
    for (let j = i + 1; j < modifiers.length; j++) {
      if (modifiers[i].target === modifiers[j].target) {
        throw new ModifierConflict({
          graph: graphName,
          target: modifiers[i].target.name,
          modifiers: [modifiers[i].kind, modifiers[j].kind]
        })
      }
    }
  }
}

/** Pure: no journal, no shell, no run. Exported for that reason: `construct.test.ts` drives it over
 *  hand-built step lists instead of only through a finalised graph. */
export const applyModifiers = (blueprint: Blueprint, modifiers: readonly Modifier[]): readonly Step[] => {
  checkConflicts(blueprint.name, modifiers)
  return modifiers.reduce((steps, modifier) => applyModifier(blueprint.name, steps, modifier), blueprint.steps)
}

/** The re-closed node registers a blueprint of its own, so a bent graph can itself be borrowed and
 *  bent. A borrow step's own modifiers never reach into an *inner* borrow: resolution reads only
 *  the immediate blueprint's steps. */
const resolveBorrows = (steps: readonly Step[]): readonly Step[] =>
  steps.map((step) => {
    if (step.kind !== "node" || step.modifiers.length === 0) return step
    const blueprint = BLUEPRINTS.get(step.node)
    if (blueprint === undefined) {
      const modifier = step.modifiers[0]
      throw new ModifierTargetMissing({
        graph: step.node.name,
        modifier: modifier.kind,
        target: modifier.target.name,
        offered: []
      })
    }
    const bent = blueprint.close(applyModifiers(blueprint, step.modifiers), tallyAt(step, step.node))
    return { ...step, node: bent, modifiers: [] }
  })

/** The single source of every stage's semantics, and the only place a `Step` is ever run: a bent
 *  step list executes by exactly the rules its unbent original did. */
const foldSteps = (steps: readonly Step[]) => (seed: unknown): Effect.Effect<any, any, any> =>
  steps.reduce<Effect.Effect<any, any, any>>((acc, step) => {
    switch (step.kind) {
      case "node":
        return acc.pipe(
          Effect.flatMap((flowed) =>
            step.node.run(step.wire(flowed)).pipe(
              Effect.map((a) => ({ ...flowed, ...(step.keep ? applyKeep(step.keep, a) : a) }))
            )
          )
        )
      case "fork":
        return acc.pipe(
          Effect.flatMap((flowed) =>
            Effect.all([step.left.run(step.wireLeft(flowed)), step.right.run(step.wireRight(flowed))], {
              concurrency: "unbounded"
            }).pipe(Effect.map(([a, b]) => ({ ...flowed, ...a, ...b })))
          )
        )
      case "when":
        return acc.pipe(
          Effect.flatMap((flowed) =>
            step.decision.test(flowed)
              ? step.node.run(step.wire(flowed)).pipe(Effect.map((a) => ({ ...flowed, ...applyKeep(step.keep, a) })))
              : // The skipped branch adds none of `keep`'s fields, matching `.when`'s `Partial<B>` result.
                Effect.succeed(flowed)
          )
        )
      case "via":
        return acc.pipe(
          Effect.flatMap((flowed) =>
            step.f(flowed).pipe(Effect.map((a) => ({ ...flowed, ...applyKeep(step.keep, a) })))
          )
        )
    }
  }, Effect.succeed(seed))

/** A node that might itself be a borrowed construct, projected as a leaf `node` element or — when
 *  `BLUEPRINTS` has it — as a nested `group` recursing into that construct's own steps. Shared by the
 *  plain node arm, by a fork's two branches and by `shapeOf`'s own root: `publish-tail` borrows
 *  `write-body` inside its own `.fork`, so a fork branch can carry a blueprint exactly as a
 *  `.then`/`.borrow` step can — the shape lists every stage of every construct develop-graph
 *  borrows, with no exception carved out for the branch of a fork. A `null`
 *  `containerId` is the root's case: nothing encloses it. */
const projectNode = (
  containerId: string | null,
  id: string,
  node: AnyNode
): { readonly elements: readonly ShapeElement[]; readonly edges: readonly ShapeEdge[] } => {
  const blueprint = BLUEPRINTS.get(node)
  if (blueprint === undefined) {
    return { elements: [{ kind: "node", id, label: node.name, parent: containerId }], edges: [] }
  }
  const child = projectSteps(id, blueprint.steps)
  return {
    elements: [{ kind: "group", id, label: blueprint.name, parent: containerId }, ...child.elements],
    edges: child.edges
  }
}

/** The shape's sibling to `foldSteps`: same union, same exhaustive switch, but wires elements and
 *  edges instead of an Effect, and never runs a node. `containerId` is the enclosing box's id, so
 *  every element minted at one level of this fold shares one `parent` — a fork's branches and a
 *  `when`'s guarded node are siblings in the container, not children of the fork/decision they hang
 *  off. A borrowed construct recurses with the group's own id as the next `containerId`, which is
 *  what nests it and what mints every id already at the right path with no rewrite pass.
 *  Total: `Step` is closed and switched exhaustively, so an unhandled kind is a typecheck failure,
 *  not a runtime one. Exported for its own unit tests, the same reason `applyModifiers` is exported. */
export const projectSteps = (
  containerId: string,
  steps: readonly Step[]
): { readonly elements: readonly ShapeElement[]; readonly edges: readonly ShapeEdge[] } => {
  const elements: ShapeElement[] = []
  const edges: ShapeEdge[] = []
  let previous: string | undefined

  /** One slot per field, overwritten as the walk descends: a field produced twice belongs to the
   *  nearest producer above the decision, the one whose value actually reached it. */
  const producers = new Map<string, string>()
  /** Stages whose contributed fields could not be enumerated. While this is empty, "not produced
   *  above" is evidence of "seeded", because a context field has exactly two origins and every stage
   *  kind declares or derives its own; once it is not, the walk refuses rather than draw an edge from
   *  the entry that may be a lie. */
  const opaque: string[] = []
  /** Decision names already seen in this container: a name is an address, so a repeat is a target
   *  a later lifecycle change could not resolve unambiguously. */
  const named = new Set<string>()

  const contribute = (fields: readonly string[] | undefined, from: string): void => {
    if (fields === undefined) {
      opaque.push(from)
      return
    }
    for (const field of fields) producers.set(field, from)
  }

  /** Called before the step records its own contributions, so a decision only ever resolves against
   *  stages above it. */
  const resolveReads = (decision: AnyDecision, to: string): void => {
    if (named.has(decision.name)) {
      throw new DecisionNameCollides({ container: containerId, decision: decision.name })
    }
    named.add(decision.name)

    for (const field of new Set(decision.reads)) {
      const from = producers.get(field)
      if (from === undefined && opaque.length > 0) {
        throw new FieldHasNoProducer({ container: containerId, decision: decision.name, field, opaque })
      }
      edges.push({ kind: "data", from: from ?? containerId, to, field })
    }
  }

  steps.forEach((step, index) => {
    const at = `${containerId}/${index}`
    let primary: string

    switch (step.kind) {
      case "node": {
        primary = BLUEPRINTS.has(step.node) ? `${at}:group:${step.node.name}` : `${at}:node:${step.node.name}`
        const projected = projectNode(containerId, primary, step.node)
        elements.push(...projected.elements)
        edges.push(...projected.edges)
        contribute(step.keep ? Object.keys(step.keep) : schemaFieldNames(step.node.success.ast), primary)
        break
      }
      case "via":
        primary = `${at}:node:${step.name}`
        elements.push({ kind: "node", id: primary, label: step.name, parent: containerId })
        contribute(Object.keys(step.keep), primary)
        break
      case "fork": {
        primary = `${at}:fork`
        const leftId = `${at}:left:${step.left.name}`
        const rightId = `${at}:right:${step.right.name}`
        const left = projectNode(containerId, leftId, step.left)
        const right = projectNode(containerId, rightId, step.right)
        elements.push({ kind: "fork", id: primary, label: "fork", parent: containerId }, ...left.elements, ...right.elements)
        edges.push(
          { kind: "branch", from: primary, to: leftId, label: "left" },
          { kind: "branch", from: primary, to: rightId, label: "right" },
          ...left.edges,
          ...right.edges
        )
        contribute(schemaFieldNames(step.left.success.ast), leftId)
        contribute(schemaFieldNames(step.right.success.ast), rightId)
        break
      }
      case "when": {
        primary = `${at}:decision:${step.decision.name}`
        const guardedId = `${at}:node:${step.node.name}`
        elements.push(
          { kind: "decision", id: primary, label: step.decision.name, parent: containerId },
          { kind: "node", id: guardedId, label: step.node.name, parent: containerId }
        )
        edges.push({ kind: "branch", from: primary, to: guardedId, label: "true" })
        resolveReads(step.decision, primary)
        // A `when` records the guarded node's id: the node is what produced the field.
        contribute(Object.keys(step.keep), guardedId)
        break
      }
    }

    if (previous !== undefined) edges.push({ kind: "sequence", from: previous, to: primary })
    previous = primary
  })

  return { elements, edges }
}

/** The one door onto a finalised construct's shape: a plain, versioned, serialisable projection of
 *  its stages, obtainable with no run. Reads the blueprint table beside `.finalise`'s return rather
 *  than widening that return, so the constraint that the finalised value stays exactly `make`'s own
 *  holds by construction. `undefined` for a node with no blueprint: a `graph({ pipeline })`
 *  graph publishes no steps and declares no inner shape to project. The root is projected by the
 *  same arm that projects every other borrowed construct, so a graph's own group and a nested one
 *  cannot drift apart. */
const shapeOf = (node: AnyNode): GraphShape | undefined => {
  const blueprint = BLUEPRINTS.get(node)
  if (blueprint === undefined) return undefined
  return { schema: SHAPE_SCHEMA, root: blueprint.name, ...projectNode(null, blueprint.name, node) }
}

/** Appends a modifier to the step list's last entry, which is always the borrow step `.removeWhen`/
 *  `.replaceNode` just followed — `Borrowed` is only ever produced right after `.borrow`/
 *  `.borrowKeep`, and every other construct method returns plain `Construct`, so the type system is
 *  what keeps "which borrow does this bend" answered by position. */
const withModifier = (steps: readonly Step[], modifier: Modifier): readonly Step[] => {
  const last = steps[steps.length - 1]
  if (last === undefined || last.kind !== "node") {
    throw new Error("withModifier: no borrow step to attach a modifier to")
  }
  return [...steps.slice(0, -1), { ...last, modifiers: [...last.modifiers, modifier] }]
}

interface FinaliseOptions<Seed extends object, Ctx extends object, SI, SA> {
  readonly description: string
  readonly input: Schema.Schema<SI>
  readonly success: Schema.Schema<SA>
  readonly scope: (input: SI) => RunScope
  readonly seed: (input: SI) => Seed
  readonly out: (ctx: Ctx) => SA
}

/** `close` recurses into this same function, so a re-closed (bent) variant is blueprinted exactly
 *  like a freshly finalised one and restates none of `options`. */
const closeSteps = <Seed extends object, Ctx extends object, E, R, SI, SA>(
  name: string,
  options: FinaliseOptions<Seed, Ctx, SI, SA>,
  steps: readonly Step[],
  applied: number
): ReturnType<typeof graph<SI, SA, E, R>> => {
  const node = graph({
    name,
    description: options.description,
    input: options.input,
    success: options.success,
    scope: options.scope,
    pipeline: (input: SI) => foldSteps(steps)(options.seed(input)).pipe(Effect.map(options.out))
  })
  BLUEPRINTS.set(node, {
    name,
    steps,
    applied,
    close: (newSteps, newApplied) => closeSteps(name, options, newSteps, newApplied)
  })
  return node
}

interface Construct<Seed extends object, Ctx extends object, E, R> {
  /** One node after another: the sketch's `.then`. The node's success spreads into the context. */
  readonly then: <I, A extends object, E2, R2>(
    node: GraphNode<I, A, E2, R2>,
    wire: Wire<Ctx, I>
  ) => Construct<Seed, Ctx & A, E | E2, R | R2>
  /** `.then` with a rename: only `keep`'s fields merge, so colliding success fields stay tellable apart. */
  readonly thenKeep: <I, A, B extends object, E2, R2>(
    node: GraphNode<I, A, E2, R2>,
    wire: Wire<Ctx, I>,
    keep: Keep<A, B>
  ) => Construct<Seed, Ctx & B, E | E2, R | R2>
  /** Two independent nodes side by side: the sketch's `.fork`. Both successes merge; `.join` is the next stage. */
  readonly fork: <IA, A extends object, EA, RA, IB, B extends object, EB, RB>(
    left: GraphNode<IA, A, EA, RA>,
    wireLeft: Wire<Ctx, IA>,
    right: GraphNode<IB, B, EB, RB>,
    wireRight: Wire<Ctx, IB>
  ) => Construct<Seed, Ctx & A & B, E | EA | EB, R | RA | RB>
  /** The stage after a fork — `.then` under the sketch's own name for that position. */
  readonly join: <I, A extends object, E2, R2>(
    node: GraphNode<I, A, E2, R2>,
    wire: Wire<Ctx, I>
  ) => Construct<Seed, Ctx & A, E | E2, R | R2>
  /** A borrowed graph is already a node, so `.borrow` IS `.then` — kept as its own name so a
   *  construct reads like its sketch, where borrowing a whole graph and running a node are different
   *  marks. Returns `Borrowed`: only a value just borrowed can carry a declared bend. */
  readonly borrow: <I, A extends object, E2, R2>(
    node: GraphNode<I, A, E2, R2>,
    wire: Wire<Ctx, I>
  ) => Borrowed<Seed, Ctx & A, E | E2, R | R2>
  /** `.borrow` with a rename, the composite-node case where `sessions`/`costUsd` always collide. */
  readonly borrowKeep: <I, A, B extends object, E2, R2>(
    node: GraphNode<I, A, E2, R2>,
    wire: Wire<Ctx, I>,
    keep: Keep<A, B>
  ) => Borrowed<Seed, Ctx & B, E | E2, R | R2>
  /** The sketch's `.when`: a named decision over the context fields it declares, guarding a node that
   *  runs only when the test holds; skipped, the context flows on unchanged, so `keep`'s fields
   *  arrive `Partial` downstream. The declared reads are what the shape draws a data edge for, one
   *  per field, from the stage that produced it. */
  readonly when: <const F extends Reads<Ctx>, I, A, B extends object, E2, R2>(
    decision: Decision<Ctx, F>,
    node: GraphNode<I, A, E2, R2>,
    wire: Wire<Ctx, I>,
    keep: Keep<A, B>
  ) => Construct<Seed, Ctx & Partial<B>, E | E2, R | R2>
  /** A total helper between nodes — the compose-pr-body case, ruled a `runtime/` helper rather than a
   *  node: a node needs a tagged error, and `prBody` has no failure mode to name. `name` is the
   *  stage's own declared handle: with no node behind it, a `.via` stage would otherwise have none to
   *  draw in the shape, and `keep` is how it declares the fields it contributes, since no schema can
   *  answer for a plain Effect's success. */
  readonly via: <A, B extends object, E2, R2>(
    name: string,
    f: (ctx: Ctx) => Effect.Effect<A, E2, R2>,
    keep: Keep<A, B>
  ) => Construct<Seed, Ctx & B, E | E2, R | R2>
  /** Close the construct into an ordinary `graph()`: schemas, scope, the success picked off the final
   *  context. `seed` turns the graph's input into the first context — resolve per-repo policy here.
   *  Also registers this construct's step list as a blueprint, so a bend declared against it
   *  by a future borrower has something to fold. */
  readonly finalise: <SI, SA>(options: FinaliseOptions<Seed, Ctx, SI, SA>) => ReturnType<typeof graph<SI, SA, E, R>>
}

/** `Construct` plus the two modifiers FR-9 (`docs/requirements/graph-envisioning.md`) adds
 *  (`removeWhen`/`replaceNode`). Declaring a bend is pure and
 *  cannot fail — it only records data against the borrow step it follows — so a half-declared borrow
 *  is impossible; every failure mode lives in `.finalise`, the one beat holding the borrowed graph
 *  and the modifiers at once. */
interface Borrowed<Seed extends object, Ctx extends object, E, R> extends Construct<Seed, Ctx, E, R> {
  /** Strips the borrowed subgraph's `when` decision at this borrowing site: the finalised graph
   *  runs the guarded node unconditionally. Targets the guarded node itself: a decision now has a
   *  handle of its own, its name, but targeting stays by node because decision names are what a
   *  later lifecycle change will target, not this one. */
  readonly removeWhen: <I, A, E2, R2>(target: GraphNode<I, A, E2, R2>) => Borrowed<Seed, Ctx, E, R>
  /** Swaps a node inside the borrowed subgraph for a replacement at this borrowing site. `NoInfer`
   *  pins every parameter to the target's, so the replacement must accept what the target accepted,
   *  produce what it produced, need what it needed, and raise no tag the target could not — a
   *  widened replacement is a compile error here, not a graph that fails downstream of the swap. */
  readonly replaceNode: <I, A extends object, E2, R2>(
    target: GraphNode<I, A, E2, R2>,
    replacement: NoInfer<GraphNode<I, A, E2, R2>>
  ) => Borrowed<Seed, Ctx, E, R>
}

const makeConstruct = <Seed extends object, Ctx extends object, E, R>(
  name: string,
  steps: readonly Step[]
): Construct<Seed, Ctx, E, R> => ({
  then: (node, wire) => makeConstruct(name, [...steps, nodeStep(node, wire)]),
  thenKeep: (node, wire, keep) => makeConstruct(name, [...steps, nodeStep(node, wire, keep)]),
  fork: (left, wireLeft, right, wireRight) =>
    makeConstruct(name, [...steps, { kind: "fork", left, wireLeft, right, wireRight }]),
  join: (node, wire) => makeConstruct(name, [...steps, nodeStep(node, wire)]),
  borrow: (node, wire) => makeBorrowed(name, [...steps, nodeStep(node, wire)]),
  borrowKeep: (node, wire, keep) => makeBorrowed(name, [...steps, nodeStep(node, wire, keep)]),
  when: (decision, node, wire, keep) =>
    makeConstruct(name, [...steps, { kind: "when", decision, node, wire, keep }]),
  via: (stageName, f, keep) => makeConstruct(name, [...steps, { kind: "via", name: stageName, f, keep }]),
  finalise: (options) => {
    // Tallied on the unresolved steps: resolveBorrows zeroes `modifiers`, so this is the only
    // place the tally is readable.
    const applied = tallyApplications(name, steps)
    return closeSteps(name, options, resolveBorrows(steps), applied)
  }
})

const makeBorrowed = <Seed extends object, Ctx extends object, E, R>(
  name: string,
  steps: readonly Step[]
): Borrowed<Seed, Ctx, E, R> => ({
  ...makeConstruct<Seed, Ctx, E, R>(name, steps),
  removeWhen: (target) => makeBorrowed(name, withModifier(steps, { kind: "removeWhen", target })),
  replaceNode: (target, replacement) =>
    makeBorrowed(name, withModifier(steps, { kind: "replaceNode", target, replacement }))
})

export const Graph = {
  /** Open a construct. `Seed` is the first context, the one `.finalise`'s `seed` must produce. */
  construct: <Seed extends object>(name: string): Construct<Seed, Seed, never, never> =>
    makeConstruct(name, []),
  shapeOf
}
