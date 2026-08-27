import { readdirSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, type FileSystem } from "effect"
import {
  nodeBindings,
  readSource,
  renderMarkdown,
  renderMermaid,
  SOURCE_ROOTS,
  stepsIn,
  topologyOf,
  TopologySourceMissing,
  type Level,
  type Topology
} from "mag/topology"
import { DEFAULT_GRAPHS_ROOT, scan } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(platform)))

const BRANCH_IMPORT = 'import { branch } from "mag/graph-nodes/branch/graph-node"'

describe("scan — masked projection", () => {
  test("masked is the same length as source, offsets preserved", () => {
    const source = [
      "// a leading comment",
      'import { x } from "a/b/c"',
      "/* a block comment with a quote \" inside */",
      "const re = /[\"']/",
      "const s = `template ${1}`"
    ].join("\n")

    expect(scan(source).masked.length).toBe(source.length)
  })

  test("an unterminated string literal still keeps masked at source length", () => {
    expect(scan('const s = "unterminated').masked.length).toBe("const s = \"unterminated".length)
  })

  test("an unterminated regex literal still keeps masked at source length", () => {
    const source = "const half = 1\nconst re = /abc"
    expect(scan(source).masked.length).toBe(source.length)
  })
})

describe("nodeBindings", () => {
  test("a single-line named import of a sibling's graph-node maps binding to node name", () => {
    expect(nodeBindings(BRANCH_IMPORT).get("branch")).toBe("branch")
  })

  test("a multi-line import clause resolves the same way — masked carries no line structure to break on", () => {
    const source = ["import {", "  branch", '} from "mag/graph-nodes/branch/graph-node"'].join("\n")
    expect(nodeBindings(source).get("branch")).toBe("branch")
  })

  test("a sibling's errors import is not a node binding — only graph-node is", () => {
    const source = [
      BRANCH_IMPORT,
      'import { BranchCheckoutFailed } from "mag/graph-nodes/branch/errors"'
    ].join("\n")

    const bindings = nodeBindings(source)
    expect(bindings.get("branch")).toBe("branch")
    expect(bindings.has("BranchCheckoutFailed")).toBe(false)
  })

  test("an import of a non-node module names no binding", () => {
    const source = 'import { Shell } from "mag/runtime/shell"'
    expect(nodeBindings(source).size).toBe(0)
  })

  // Every import form below a plain named clause can silently drop its call site if mishandled;
  // each case below is a regression test for one such form.
  test("a renamed named import binds the alias, not the original name", () => {
    const bindings = nodeBindings('import { branch as b } from "mag/graph-nodes/branch/graph-node"')
    expect(bindings.get("b")).toBe("branch")
    expect(bindings.has("branch as b")).toBe(false)
    expect(bindings.has("branch")).toBe(false)
  })

  test("a default import binds the local identifier", () => {
    const bindings = nodeBindings('import branch from "mag/graph-nodes/branch/graph-node"')
    expect(bindings.get("branch")).toBe("branch")
  })

  test("a namespace import binds the local identifier", () => {
    const bindings = nodeBindings('import * as branch from "mag/graph-nodes/branch/graph-node"')
    expect(bindings.get("branch")).toBe("branch")
  })

  test("a mixed default-plus-named import binds the named clause, not just the default", () => {
    const bindings = nodeBindings('import def, { branch } from "mag/graph-nodes/branch/graph-node"')
    expect(bindings.get("branch")).toBe("branch")
  })

  test("an import clause matching none of the known node-import shapes errors loudly rather than dropping the edge", () => {
    expect(() => nodeBindings('import branch, * as ns from "mag/graph-nodes/branch/graph-node"')).toThrow()
  })

  test("an export-from re-export of a node module names no binding — it introduces no local identifier a call site could use", () => {
    const source = 'export { branch } from "mag/graph-nodes/branch/graph-node"'
    expect(nodeBindings(source).size).toBe(0)
  })
})

describe("stepsIn", () => {
  test("a .run( inside a string literal is not a step", () => {
    const source = `${BRANCH_IMPORT}\nconst note = "call branch.run({}) later"\n`
    expect(stepsIn(source)).toEqual([])
  })

  test("a .run( inside a comment is not a step", () => {
    const source = `${BRANCH_IMPORT}\n// branch.run({})\n`
    expect(stepsIn(source)).toEqual([])
  })

  test("a call inside a for block is inLoop, at one brace deeper than top level", () => {
    const source = `${BRANCH_IMPORT}\nfor (let i = 0; i < 1; i++) {\n  branch.run({})\n}\n`
    expect(stepsIn(source)).toEqual([{ node: "branch", depth: 1, inLoop: true }])
  })

  test("a call inside a while block is inLoop", () => {
    const source = `${BRANCH_IMPORT}\nwhile (more()) {\n  branch.run({})\n}\n`
    expect(stepsIn(source)).toEqual([{ node: "branch", depth: 1, inLoop: true }])
  })

  test("a call nested one brace deeper than another carries the greater depth, and is not inLoop under a plain if", () => {
    const source = `${BRANCH_IMPORT}\nbranch.run({ a: 1 })\nif (ready) {\n  branch.run({ b: 2 })\n}\n`
    expect(stepsIn(source)).toEqual([
      { node: "branch", depth: 0, inLoop: false },
      { node: "branch", depth: 1, inLoop: false }
    ])
  })

  test("a call on a binding that is not a node import is absent — shell.run( is never a step", () => {
    const source = 'import { Shell } from "mag/runtime/shell"\nconst run = () => shell.run(["ls"])\n'
    expect(stepsIn(source)).toEqual([])
  })

  // The masked projection tracks template-substitution state so `${...}` re-enters code mode.
  // Each case below exercises that.
  const ALPHA_IMPORT = 'import { alpha } from "mag/graph-nodes/alpha/graph-node"'
  const BETA_IMPORT = 'import { beta } from "mag/graph-nodes/beta/graph-node"'

  test("an interpolated call is visible: `${alpha.run(1)}` is one alpha step, not a blanked template", () => {
    const source = `${ALPHA_IMPORT}\nconst s = \`\${alpha.run(1)}\`\n`
    expect(stepsIn(source)).toEqual([{ node: "alpha", depth: 0, inLoop: false }])
  })

  test("a nested template's text is not code: `${ \\`alpha.run(1) is text\\` }` mints no step", () => {
    const source = `${ALPHA_IMPORT}\nconst s = \`x \${ \`alpha.run(1) is text\` } y\`\n`
    expect(stepsIn(source)).toEqual([])
  })

  test("a nested template's own brace does not leak into the surrounding loop's depth: `${ \\`}\\` }` inside a for block", () => {
    const source =
      `${ALPHA_IMPORT}\n${BETA_IMPORT}\n` +
      "for (let i = 0; i < 1; i++) {\n  const s = `${ `}` }`\n  beta.run(1)\n}\nalpha.run(2)\n"
    expect(stepsIn(source)).toEqual([
      { node: "beta", depth: 1, inLoop: true },
      { node: "alpha", depth: 0, inLoop: false }
    ])
  })

  test("the mirror leak does not inflate depth either: `${ \\`{\\` }` at top level leaves a following call at depth 0", () => {
    const source = `${ALPHA_IMPORT}\nconst s = \`\${ \`{\` }\`\nalpha.run(1)\n`
    expect(stepsIn(source)).toEqual([{ node: "alpha", depth: 0, inLoop: false }])
  })

  test("a postfix ++ before / is division, not a phantom regex that swallows the loop's closing brace", () => {
    const source =
      `${ALPHA_IMPORT}\n${BETA_IMPORT}\n` +
      "for (const x of xs) { const n = i++ / 2; beta.run(1) }\nalpha.run(2)\n"
    expect(stepsIn(source)).toEqual([
      { node: "beta", depth: 1, inLoop: true },
      { node: "alpha", depth: 0, inLoop: false }
    ])
  })
})

describe("renderMarkdown", () => {
  test("golden string: spine edges, subgraph repeat with its back-edge, a dotted branch edge, and the subroutine shape for a step with its own level", () => {
    const topology: Topology = {
      root: "demo-graph",
      levels: [
        {
          node: "demo-graph",
          steps: [
            { node: "alpha", depth: 1, inLoop: false },
            { node: "composite", depth: 1, inLoop: false }
          ]
        },
        {
          node: "composite",
          steps: [
            { node: "build", depth: 2, inLoop: true },
            { node: "dispute", depth: 3, inLoop: true },
            { node: "verify", depth: 2, inLoop: true }
          ]
        }
      ]
    }

    const expected = [
      "## demo-graph",
      "",
      "```mermaid",
      "flowchart TD",
      '  alpha["alpha"] --> composite[["composite"]]',
      "```",
      "",
      "## composite",
      "",
      "```mermaid",
      "flowchart TD",
      "  subgraph repeat_1[repeat]",
      '    build["build"] --> verify["verify"]',
      "    verify -.->|repeat| build",
      "  end",
      '  build -.->|branch| dispute["dispute"]',
      "```",
      ""
    ].join("\n")

    expect(renderMarkdown(topology)).toBe(expected)
  })

  test("the incoming boundary edge into a loop declares the loop head inside subgraph repeat, not outside it", () => {
    const level: Level = {
      node: "x",
      steps: [
        { node: "alpha", depth: 1, inLoop: false },
        { node: "build", depth: 1, inLoop: true },
        { node: "review", depth: 1, inLoop: true },
        { node: "omega", depth: 1, inLoop: false }
      ]
    }

    const expected = [
      "flowchart TD",
      "  subgraph repeat_1[repeat]",
      '    build["build"] --> review["review"]',
      "    review -.->|repeat| build",
      "  end",
      '  alpha["alpha"] --> build',
      '  review --> omega["omega"]',
      ""
    ].join("\n")

    expect(renderMermaid(level, new Set())).toBe(expected)
  })

  test("a level with zero steps that is the requested root still draws one box", () => {
    const topology: Topology = { root: "leaf", levels: [{ node: "leaf", steps: [] }] }
    expect(renderMarkdown(topology)).toBe(['## leaf', '', "```mermaid", "flowchart TD", '  leaf["leaf"]', "```", ""].join("\n"))
  })

  test("a leaf level reached only as another level's step gets no section of its own", () => {
    const topology: Topology = {
      root: "demo-graph",
      levels: [
        { node: "demo-graph", steps: [{ node: "alpha", depth: 1, inLoop: false }] },
        { node: "alpha", steps: [] }
      ]
    }
    expect(renderMarkdown(topology)).not.toContain("## alpha")
  })

  // A level with exactly one non-loop step has no internal edge, no boundary edge, and no branch
  // edge — nothing else calls `ref` on its only step, so this case needs an explicit box render.
  test("a level with exactly one non-loop step renders its node, not an empty flowchart", () => {
    const level: Level = { node: "solo-graph", steps: [{ node: "branch", depth: 1, inLoop: false }] }
    expect(renderMermaid(level, new Set())).toBe(['flowchart TD', '  branch["branch"]', ''].join("\n"))
  })

  // A step deeper than the spine that precedes every spine step is easy to silently drop —
  // `lastSpine === undefined` on the first iterations must not just `continue` past it.
  test("a deeper-than-spine step preceding all spine steps anchors to the following spine step instead of being dropped", () => {
    const level: Level = {
      node: "x",
      steps: [
        { node: "design", depth: 2, inLoop: false },
        { node: "branch", depth: 1, inLoop: false },
        { node: "build", depth: 1, inLoop: false }
      ]
    }
    const expected = [
      "flowchart TD",
      '  branch["branch"] --> build["build"]',
      '  branch -.->|branch| design["design"]',
      ""
    ].join("\n")
    expect(renderMermaid(level, new Set())).toBe(expected)
  })

  // A level with more than one loop run must not emit the literal subgraph id `repeat` twice —
  // mermaid ids must be unique per diagram. Exercised with this step shape: loop, loop, non-loop,
  // loop, loop.
  test("two loop runs in one level get distinct subgraph ids, repeat kept only as the display title", () => {
    const level: Level = {
      node: "x",
      steps: [
        { node: "a", depth: 1, inLoop: true },
        { node: "b", depth: 1, inLoop: true },
        { node: "mid", depth: 1, inLoop: false },
        { node: "c", depth: 1, inLoop: true },
        { node: "d", depth: 1, inLoop: true }
      ]
    }
    const rendered = renderMermaid(level, new Set())
    expect(rendered).toContain("subgraph repeat_1[repeat]")
    expect(rendered).toContain("subgraph repeat_2[repeat]")
    expect(rendered.match(/subgraph repeat_\d+\[repeat\]/g)).toHaveLength(2)
  })
})

describe("readSource", () => {
  test("an unknown name fails named, listing both candidate paths", async () => {
    const exit = await Effect.runPromiseExit(readSource(SOURCE_ROOTS, "not-a-real-node").pipe(Effect.provide(platform)))
    expect(Exit.isFailure(exit)).toBe(true)
    const reasons = Exit.isFailure(exit) ? exit.cause.reasons : []
    const failed = reasons.find((reason) => Cause.isFailReason(reason))
    expect(failed !== undefined && Cause.isFailReason(failed) && failed.error instanceof TopologySourceMissing).toBe(
      true
    )
  })
})

describe("topologyOf — against the real tree", () => {
  test("a rail-DSL host reads as an empty level: the `.run(` scan cannot see `.borrow`/`.then`", async () => {
    // develop-graph is written in the Graph.construct rail DSL; nothing in its source is a
    // `<node>.run(` call site, so its level exists and carries no steps. This pins the limitation
    // rather than hiding it — a construct becomes drawable elsewhere, not here.
    const topology = await run(topologyOf(SOURCE_ROOTS, "develop-graph"))
    const top = topology.levels.find((level) => level.node === "develop-graph")
    expect(top).toBeDefined()
    expect(top!.steps).toEqual([])
  })

  test("build-under-review as its own root: its three steps all inLoop, its inner nodes are steps, not levels", async () => {
    const topology = await run(topologyOf(SOURCE_ROOTS, "build-under-review"))
    const inner = topology.levels.find((level) => level.node === "build-under-review")
    expect(inner).toBeDefined()

    const stepNames = inner!.steps.map((step) => step.node)
    expect(stepNames).toContain("build")
    expect(stepNames).toContain("verification")
    expect(stepNames).toContain("review-diff")
    expect(inner!.steps.every((step) => step.inLoop)).toBe(true)
  })

  test("publish resolves through the graph-nodes root — a composite is a valid root — and yields push-branch then create-pr", async () => {
    const topology = await run(topologyOf(SOURCE_ROOTS, "publish"))
    const top = topology.levels.find((level) => level.node === "publish")
    expect(top!.steps.map((step) => step.node)).toEqual(["push-branch", "create-pr"])
  })

  test("every name in graphs/ resolves — pins the filename-matches-name convention the resolver depends on", async () => {
    // `graphs/` is a directory-per-graph tree, never `.ts` files directly under its root, so a
    // `.ts`-suffix filter would match nothing and this loop would never run. Filtering for
    // directories is what actually exercises the folder-name-equals-graph-name convention
    // `topologyOf`'s resolver depends on.
    const names = readdirSync(DEFAULT_GRAPHS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    for (const name of names) {
      const topology = await run(topologyOf(SOURCE_ROOTS, name))
      expect(topology.root).toBe(name)
    }
  })
})
