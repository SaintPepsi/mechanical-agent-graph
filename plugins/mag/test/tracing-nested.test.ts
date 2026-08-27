// "The inner node run names the outer node run" — a nested `execute()` call, inside a
// node's own `run`, must produce two node runs whose spans nest: the inner open event's
// `parentSpanId` equals the outer open event's `spanId`.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { foldTrace } from "mag/runtime"
import { readEvents, runHarness } from "./run-harness"

const harnessPath = join(import.meta.dir, "harness-cli-nested.ts")

/** Spawns `harness-cli-nested.ts` with `GRAPH_TRACE_FILE` pointed at `path`. */
const runNested = (path: string, ...argv: readonly string[]) =>
  runHarness(harnessPath, { GRAPH_TRACE_FILE: path })(...argv)

describe("nestedNodeFixture — the inner node run names the outer node run", () => {
  test("both node runs open and close exactly once, and the inner names the outer as its parent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-tracing-nested-"))
    const path = join(dir, "trace.ndjson")

    try {
      const { exitCode } = await runNested(path, "nested-outer", "--label", "hello")
      expect(exitCode).toBe(0)

      const events = readEvents(path)

      const outerOpens = events.filter((event) => event.kind === "open" && event.name === "nested-outer")
      const outerCloses = events.filter((event) => event.kind === "close" && event.name === "nested-outer")
      const innerOpens = events.filter((event) => event.kind === "open" && event.name === "nested-inner")
      const innerCloses = events.filter((event) => event.kind === "close" && event.name === "nested-inner")

      // Both node runs are well-formed: exactly one open and one close event, each.
      expect(outerOpens.length).toBe(1)
      expect(outerCloses.length).toBe(1)
      expect(innerOpens.length).toBe(1)
      expect(innerCloses.length).toBe(1)

      const outerOpen = outerOpens[0]!
      const outerClose = outerCloses[0]!
      const innerOpen = innerOpens[0]!
      const innerClose = innerCloses[0]!

      // Each pair shares one span identifier.
      expect(outerClose.spanId).toBe(outerOpen.spanId)
      expect(innerClose.spanId).toBe(innerOpen.spanId)

      // The core claim: the inner open event's parentSpanId names the outer's spanId.
      expect(innerOpen.kind).toBe("open")
      if (innerOpen.kind === "open") {
        expect(innerOpen.parentSpanId).toBe(outerOpen.spanId)
      }

      // The outer is itself a root (no parent of its own).
      expect(outerOpen.kind).toBe("open")
      if (outerOpen.kind === "open") {
        expect(outerOpen.parentSpanId).toBeNull()
      }

      // Both close with outcome "ok" (no failure anywhere in this fixture).
      expect(outerClose.kind).toBe("close")
      expect(innerClose.kind).toBe("close")
      if (outerClose.kind === "close") expect(outerClose.outcome).toBe("ok")
      if (innerClose.kind === "close") expect(innerClose.outcome).toBe("ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("foldTrace reports the nesting as a two-level tree: one root, one child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-tracing-nested-fold-"))
    const path = join(dir, "trace.ndjson")

    try {
      await runNested(path, "nested-outer", "--label", "world")

      const events = readEvents(path)
      const report = foldTrace(events)

      const outerSpanId = events.find((event) => event.kind === "open" && event.name === "nested-outer")?.spanId
      const innerSpanId = events.find((event) => event.kind === "open" && event.name === "nested-inner")?.spanId
      expect(typeof outerSpanId).toBe("string")
      expect(typeof innerSpanId).toBe("string")

      // No dangling open-without-close: the fold agrees both node runs finished.
      expect(report.open).toEqual([])
      expect(report.closed.length).toBe(2)

      // The tree is exactly one root (the outer) with exactly one child (the inner) — a two-level
      // nesting, not a flat list of two roots and not a deeper chain.
      expect(report.roots).toEqual([
        {
          spanId: outerSpanId as string,
          children: [
            { spanId: innerSpanId as string, children: [] }
          ]
        }
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Asserted mechanically: neither the outer nor the inner fixture node is a
  // `mag/graph-nodes/` import — the inner is an inline object literal inside `nestedNodeFixture`.
  // Mirrors `tracing-conformance.test.ts`'s house idiom: read the real source text and grep it,
  // zero model judgment involved.
  test("node-fixture.ts imports nothing from mag/graph-nodes/ — no node imports another node", async () => {
    const source = await Bun.file(join(import.meta.dir, "node-fixture.ts")).text()
    // An actual import/require specifier, not a doc-comment mention of the directory name (this
    // file's own header comments explain the rule using that same path in prose).
    const importsAGraphNode = /(?:from\s+|require\()\s*["'`]mag\/graph-nodes\//.test(source)
    expect(importsAGraphNode).toBe(false)
  })
})
