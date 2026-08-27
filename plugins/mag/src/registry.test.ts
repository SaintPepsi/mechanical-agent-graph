import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { psCommand } from "mag/ps"
import { registry } from "mag/registry"
import { buildCli } from "mag/runtime/build-cli"
import type { UnsupportedInputSchema } from "mag/runtime/errors"
import { deriveFlagSpecs } from "mag/runtime/schema-flags"
import type { CommandNode, Registry } from "mag/runtime/types"
import { fixtureNode } from "mag/test/fixtures/command-node"

/**
 * The drift rule: a group description names the group's noun, never its children, so no group's
 * `description` may contain the `name` of any command beneath it.
 */

/** Every command `name` nested anywhere under this list of entries, at any depth. */
const descendantCommandNames = (entries: Registry): readonly string[] =>
  entries.flatMap((entry) => {
    if (entry.kind === "command") return [entry.node.name]
    // A "raw" entry (`ps`) is a leaf like "command", just not a GraphNode — its own Command
    // carries its name the same way a GraphNode does.
    if (entry.kind === "raw") return [entry.command.name]
    return descendantCommandNames(entry.children)
  })

/**
 * A whole-word, case-insensitive match — not substring containment. A short command name like
 * `run` or `check` is otherwise a substring of ordinary words (`running`, `checked`) that appear
 * in a legitimate group description, tripping the drift rule with no drift present.
 */
const nameAppearsIn = (description: string, name: string): boolean =>
  new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(description)

/** One violation string per group whose `description` contains a descendant command's `name`. */
const findDriftViolations = (entries: Registry): readonly string[] =>
  entries.flatMap((entry): readonly string[] => {
    if (entry.kind === "command" || entry.kind === "raw") return []

    const ownViolations = descendantCommandNames(entry.children)
      .filter((name) => nameAppearsIn(entry.description, name))
      .map((name) => `group "${entry.group}" description names descendant command "${name}"`)

    return [...ownViolations, ...findDriftViolations(entry.children)]
  })

describe("registry — group-description drift rule", () => {
  test("the real shipped registry has no drift: no group description names a descendant command", () => {
    expect(findDriftViolations(registry)).toEqual([])
  })

  test("the rule actually catches drift: a deliberately-bad fixture registry fails it", () => {
    const echoNode: CommandNode = fixtureNode("echo", Schema.Struct({}))

    const badRegistry: Registry = [
      {
        kind: "group",
        group: "utility",
        description: "Group of utility commands; runs the echo command under the hood.",
        children: [{ kind: "command", node: echoNode }]
      }
    ]

    const violations = findDriftViolations(badRegistry)

    expect(violations).toEqual([`group "utility" description names descendant command "echo"`])
  })

  test("drift is caught at any depth, not just a group's direct children", () => {
    const pingNode: CommandNode = fixtureNode("ping", Schema.Struct({}))

    const badNestedRegistry: Registry = [
      {
        kind: "group",
        group: "outer",
        description: "Commands that eventually let you ping something.",
        children: [
          {
            kind: "group",
            group: "inner",
            description: "Inner group commands.",
            children: [{ kind: "command", node: pingNode }]
          }
        ]
      }
    ]

    expect(findDriftViolations(badNestedRegistry)).toEqual([
      `group "outer" description names descendant command "ping"`
    ])
  })

  test("a command name that is only a substring of a larger word is not drift", () => {
    const runNode: CommandNode = fixtureNode("run", Schema.Struct({}))

    const registryWithCoincidentalSubstring: Registry = [
      {
        kind: "group",
        group: "graph",
        description: "Commands for running node checks against the graph.",
        children: [{ kind: "command", node: runNode }]
      }
    ]

    expect(findDriftViolations(registryWithCoincidentalSubstring)).toEqual([])
  })
})

/**
 * A registered command's input schema is the CLI surface it derives. `deriveFlagSpecs`
 * accepts a flat struct of string/number/boolean; anything else fails the whole CLI build with
 * UNSUPPORTED_INPUT_SCHEMA (registry.ts's `format-branch-name` paragraph is this rule written in
 * prose).
 */
const findDerivationViolations = (entries: Registry): readonly string[] =>
  entries.flatMap((entry): readonly string[] => {
    // A raw entry already IS a Command; it has no input schema to derive.
    if (entry.kind === "raw") return []
    if (entry.kind === "group") return findDerivationViolations(entry.children)

    const derived = deriveFlagSpecs(entry.node)
    return Result.isFailure(derived) ? [describeUnsupported(derived.failure)] : []
  })

const describeUnsupported = (failure: UnsupportedInputSchema): string =>
  `node "${failure.node}" input field "${failure.field}" is not CLI-derivable (${failure.type})`

describe("registry — CLI-derivation rule", () => {
  test("the real shipped registry derives: every registered node becomes a command", () => {
    expect(findDerivationViolations(registry)).toEqual([])
  })

  test("the rule bites: an array-input fixture node fails it, naming node and field", () => {
    const labelledNode: CommandNode = fixtureNode(
      "labelled",
      Schema.Struct({ labels: Schema.Array(Schema.String) })
    )

    const badRegistry: Registry = [{ kind: "command", node: labelledNode }]

    expect(findDerivationViolations(badRegistry)).toEqual([
      `node "labelled" input field "labels" is not CLI-derivable (Arrays)`
    ])
  })

  test("the rule bites: a nested-struct fixture node fails it, naming node and field", () => {
    const nestedNode: CommandNode = fixtureNode(
      "nested",
      Schema.Struct({ nested: Schema.Struct({ x: Schema.String }) })
    )

    const badRegistry: Registry = [{ kind: "command", node: nestedNode }]

    expect(findDerivationViolations(badRegistry)).toEqual([
      `node "nested" input field "nested" is not CLI-derivable (Objects)`
    ])
  })

  test("a bad node nested inside a group is caught, not just a top-level one", () => {
    const labelledNode: CommandNode = fixtureNode(
      "labelled",
      Schema.Struct({ labels: Schema.Array(Schema.String) })
    )

    const badNestedRegistry: Registry = [
      {
        kind: "group",
        group: "outer",
        description: "Outer group commands.",
        children: [{ kind: "command", node: labelledNode }]
      }
    ]

    expect(findDerivationViolations(badNestedRegistry)).toEqual([
      `node "labelled" input field "labels" is not CLI-derivable (Arrays)`
    ])
  })

  test("a raw entry is skipped: ps has no input schema to derive", () => {
    const rawOnlyRegistry: Registry = [{ kind: "raw", command: psCommand }]

    expect(findDerivationViolations(rawOnlyRegistry)).toEqual([])
  })

  test("every offending node is reported, not just the first", () => {
    const firstBad: CommandNode = fixtureNode("first-bad", Schema.Struct({ labels: Schema.Array(Schema.String) }))
    const secondBad: CommandNode = fixtureNode(
      "second-bad",
      Schema.Struct({ nested: Schema.Struct({ x: Schema.String }) })
    )

    const badRegistry: Registry = [
      { kind: "command", node: firstBad },
      { kind: "command", node: secondBad }
    ]

    expect(findDerivationViolations(badRegistry)).toEqual([
      `node "first-bad" input field "labels" is not CLI-derivable (Arrays)`,
      `node "second-bad" input field "nested" is not CLI-derivable (Objects)`
    ])
  })
})

describe("registry — folds into a real CLI", () => {
  test("buildCli(registry) succeeds: the registry folds into a real @effect/cli command tree", async () => {
    const exit = await Effect.runPromiseExit(buildCli(registry))

    expect(exit._tag).toBe("Success")
  })

  test("the pipeline's nodes are registered, so the built help lists them", () => {
    const names = descendantCommandNames(registry)
    for (const name of ["branch", "build", "verification", "review-diff", "develop-graph"]) {
      expect(names).toContain(name)
    }
  })

  test("publish is registered, so the built help lists it", () => {
    expect(descendantCommandNames(registry)).toContain("publish")
  })

  test("worktree-add and worktree-remove are registered, so the built help lists them", () => {
    const names = descendantCommandNames(registry)
    expect(names).toContain("worktree-add")
    expect(names).toContain("worktree-remove")
  })

  test("ps is registered (a \"raw\" entry, not a GraphNode), so the built help lists it", () => {
    expect(descendantCommandNames(registry)).toContain("ps")
  })

  test("design-graph, envision-notation and assemble-brainstorm-prompt are registered, so the built help lists them", () => {
    const names = descendantCommandNames(registry)
    for (const name of ["design-graph", "envision-notation", "assemble-brainstorm-prompt"]) {
      expect(names).toContain(name)
    }
  })

  test("write-ticket, github-ticket-create and ticket-writer are registered, so the built help lists them", () => {
    const names = descendantCommandNames(registry)
    for (const name of ["write-ticket", "github-ticket-create", "ticket-writer"]) {
      expect(names).toContain(name)
    }
  })
})
