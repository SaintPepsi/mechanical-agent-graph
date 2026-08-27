import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, FileSystem, Layer, Path, Result, Schema } from "effect"
import {
  GraphSourceMissing,
  ShippedVisionMissing,
  StageFailed,
  VisionNotWithheld
} from "mag/graph-nodes/stage-shipped-graph/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/stage-shipped-graph/examples"
import { stageShippedGraph } from "mag/graph-nodes/stage-shipped-graph/graph-node"
import { stageGraph } from "mag/graph-nodes/stage-shipped-graph/stage"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { platform } from "mag/runtime/platform"
import { removeDir } from "mag/test/node-fixture"
import { VisionUnreadable } from "mag/runtime/vision-shape"

/**
 * `stageGraph` itself is exercised here, never `stageShippedGraph.run`: the node hardwires the live
 * `DEFAULT_GRAPHS_ROOT`/`DEFAULT_SRC_ROOT` (`create-graph-folder/graph-node.test.ts`'s own precedent
 * for its sibling root). No run-root branch to prove separately: this node has none, reading no
 * `RunInfo` field in its own body.
 */
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(Effect.result(effect.pipe(Effect.provide(platform))))

const MERMAID = ['```mermaid', "graph TD", '  A["load · Mechanical<br/>job"]', "```", ""].join("\n")

/** A fixture tree shaped like the real one: `<root>/src/graphs/<name>/{graph.ts,vision.md}`, so
 * `graphsRoot = <root>/src/graphs` and `srcRoot = <root>/src` mirror `DEFAULT_GRAPHS_ROOT`'s own
 * relationship to `DEFAULT_SRC_ROOT` (`graph-node.shape.ts`). No `runRoot`: `codeRoot` is minted from
 * the OS's own temp directory now (`stage.ts`), never a fixture-local path. */
const withFixture = async (
  fn: (paths: { readonly root: string; readonly srcRoot: string; readonly graphsRoot: string }) => Promise<void>
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "stage-shipped-graph-"))
  try {
    const srcRoot = join(root, "src")
    const graphsRoot = join(srcRoot, "graphs")
    mkdirSync(graphsRoot, { recursive: true })

    const target = join(graphsRoot, "design-graph")
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "graph.ts"), "export const designGraph = {}\n")
    writeFileSync(join(target, "vision.md"), MERMAID)

    // A second graph, proving the strip withholds every vision, not just the reviewed one's.
    const sibling = join(graphsRoot, "envision")
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, "graph.ts"), "export const envision = {}\n")
    writeFileSync(join(sibling, "vision.md"), MERMAID)
    writeFileSync(join(sibling, "rail-sketch.md"), "// a rail-sketch\n")

    await fn({ root, srcRoot, graphsRoot })
  } finally {
    await removeDir(root)
  }
}

describe("stageShippedGraph", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(stageShippedGraph.input)) throw new Error("stageShippedGraph.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(stageShippedGraph.input)(example)
    if (!isSchemaHandle(stageShippedGraph.success)) throw new Error("stageShippedGraph.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(stageShippedGraph.success)(example)
  })
})

describe("stageGraph", () => {
  test("the staged copy carries the graph's source and no vision.md or rail-sketch.md anywhere", () =>
    withFixture(async ({ srcRoot, graphsRoot }) => {
      const result = await run(stageGraph({ graphsRoot, srcRoot, name: "design-graph" }))
      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return

      const { codeRoot, graphRoot, visionPath } = result.success
      try {
        // Not `<runRoot>/code-only`: an OS temp directory, outside both `~/.claude/**` (the
        // sensitive-file guard's blocked zone) and the fixture tree.
        expect(codeRoot.startsWith(tmpdir())).toBe(true)
        expect(codeRoot.startsWith(srcRoot)).toBe(false)
        expect(graphRoot).toBe(join(codeRoot, "graphs", "design-graph"))
        // `visionPath` is the ORIGINAL, unstaged vision — the staged one was just deleted, and
        // `compare-vision` reads the shipped document, never the withheld copy.
        expect(visionPath).toBe(join(graphsRoot, "design-graph", "vision.md"))

        expect(readdirSync(join(codeRoot, "graphs", "design-graph"))).toContain("graph.ts")

        const withheld = readdirSync(codeRoot, { recursive: true }).map(String)
        expect(withheld.some((entry) => entry.endsWith("vision.md"))).toBe(false)
        expect(withheld.some((entry) => entry.endsWith("rail-sketch.md"))).toBe(false)
      } finally {
        await removeDir(codeRoot)
      }
    }))

  test("a name with no graph.ts fails GraphSourceMissing, naming the path it looked at", () =>
    withFixture(async ({ srcRoot, graphsRoot }) => {
      const result = await run(stageGraph({ graphsRoot, srcRoot, name: "no-such-graph" }))
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(GraphSourceMissing)
      const failure = result.failure as GraphSourceMissing
      expect(failure.name).toBe("no-such-graph")
      expect(failure.looked).toBe(join(graphsRoot, "no-such-graph", "graph.ts"))
    }))

  test("a graph shipped without a co-located vision is an error, not a skip", () =>
    withFixture(async ({ srcRoot, graphsRoot }) => {
      const bare = join(graphsRoot, "bare-graph")
      mkdirSync(bare, { recursive: true })
      writeFileSync(join(bare, "graph.ts"), "export const bareGraph = {}\n")

      const result = await run(stageGraph({ graphsRoot, srcRoot, name: "bare-graph" }))
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(ShippedVisionMissing)
      const failure = result.failure as ShippedVisionMissing
      expect(failure.name).toBe("bare-graph")
      expect(failure.searchedIn).toBe(bare)
    }))

  test("a vision with no fenced mermaid fails the shared VisionUnreadable before any copy", () =>
    withFixture(async ({ srcRoot, graphsRoot }) => {
      const unreadable = join(graphsRoot, "unreadable-graph")
      mkdirSync(unreadable, { recursive: true })
      writeFileSync(join(unreadable, "graph.ts"), "export const unreadableGraph = {}\n")
      writeFileSync(join(unreadable, "vision.md"), "# Just prose, no diagram.\n")

      const result = await run(stageGraph({ graphsRoot, srcRoot, name: "unreadable-graph" }))
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VisionUnreadable)
      // The gate (`readShapeAt`) sits before `fs.makeTempDirectory` in `stage.ts`, so nothing was
      // minted: there is no fixture-local or run-local place left to assert emptiness against, and
      // the failure type standing alone is what proves this fires before the expensive step.
    }))

  test("a source the copy cannot read fails StageFailed, naming both paths", () =>
    withFixture(async ({ srcRoot, graphsRoot }) => {
      const missingSrcRoot = join(srcRoot, "does-not-exist")
      const result = await run(stageGraph({ graphsRoot, srcRoot: missingSrcRoot, name: "design-graph" }))
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(StageFailed)
      const failure = result.failure as StageFailed
      expect(failure.from).toBe(missingSrcRoot)
      expect(failure.detail.length).toBeGreaterThan(0)
      // `codeRoot` was still minted (temp-directory creation doesn't depend on `srcRoot`); clean it up.
      if (failure.to !== "") await removeDir(failure.to)
    }))

  test("the reviewed graph's vision surviving the strip is VisionNotWithheld, the mechanical backstop", () =>
    withFixture(async ({ srcRoot, graphsRoot }) => {
      // `isWithheldDoc` (`stage.ts`) trusts `fs.readDirectory(recursive)` to report every withheld
      // path. This proves the backstop that check names as its own reason for existing: a
      // `FileSystem` that reports every real entry except the reviewed graph's own vision file,
      // simulating that assumption breaking without touching `isWithheldDoc` itself (it stays
      // correct; the enumeration it trusts is what's made to lie). Built from `platform` — the only
      // way to reach a real `FileSystem` instance without importing `@effect/platform-node` directly,
      // which only `runtime/platform.ts` and `runtime/run-cli.ts` may do.
      const hiddenRelative = join("graphs", "design-graph", "vision.md")
      const blindToOwnVision = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
          ...fs,
          readDirectory: (path: string, options?: { readonly recursive?: boolean }) =>
            Effect.map(fs.readDirectory(path, options), (entries) => entries.filter((entry) => entry !== hiddenRelative))
        }))
      ).pipe(Layer.provideMerge(platform))

      const result = await Effect.runPromise(
        Effect.result(stageGraph({ graphsRoot, srcRoot, name: "design-graph" }).pipe(Effect.provide(blindToOwnVision)))
      )
      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(VisionNotWithheld)
      const failure = result.failure as VisionNotWithheld
      expect(failure.stagedVisionPath.endsWith(hiddenRelative)).toBe(true)
      // Everything else still got stripped: the sibling's rail-sketch.md wasn't hidden from the fake
      // listing, so only the one path this test hid survived.
      const codeRoot = dirname(dirname(dirname(failure.stagedVisionPath)))
      const remaining = readdirSync(codeRoot, { recursive: true }).map(String)
      expect(remaining.filter((entry) => entry.endsWith("vision.md") || entry.endsWith("rail-sketch.md"))).toStrictEqual([
        hiddenRelative
      ])
      await removeDir(codeRoot)
    }))
})
