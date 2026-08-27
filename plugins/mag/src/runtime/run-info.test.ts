import { describe, expect, test } from "bun:test"
import { recordPath, recordsDir, type RunInfoService } from "mag/runtime/run-info"

/** A home run's shape: `recordsRoot` follows `workRoot` (`run-layers.ts`'s same-repository case). */
const HOME_RUN: RunInfoService = {
  runId: "run-1",
  ticket: "GH-98",
  graph: "develop-graph",
  repoRoot: "/repo",
  sha: "abc123",
  pipelineSha: "def456",
  runRoot: "/repo/.claude/graph/run-1",
  workRoot: "/repo",
  recordsRoot: "/repo",
  records: "run-root"
}

/** A foreign run's shape under the default `records: "run-root"` policy: `recordsRoot` is a
 *  disposable OS temp directory, distinct from both `repoRoot` and `workRoot` — `run-layers.ts`'s
 *  own placement for this one case; under `records: "committed"` it would equal `workRoot` instead. */
const FOREIGN_RUN: RunInfoService = {
  ...HOME_RUN,
  repoRoot: "/target",
  workRoot: "/target",
  recordsRoot: "/tmp/records-9f2a"
}

describe("recordPath", () => {
  test("recordsRoot === '' returns the relative path unchanged, the workdir()/primaryDir() '' convention", () => {
    expect(recordPath({ ...HOME_RUN, recordsRoot: "" }, "docs/graph/GH-98/notes.md")).toBe("docs/graph/GH-98/notes.md")
  })

  test("a non-empty recordsRoot composes <recordsRoot>/<relative>", () => {
    expect(recordPath(HOME_RUN, "docs/graph/GH-98/notes.md")).toBe("/repo/docs/graph/GH-98/notes.md")
    expect(recordPath(FOREIGN_RUN, "docs/graph/GH-98/notes.md")).toBe("/tmp/records-9f2a/docs/graph/GH-98/notes.md")
  })
})

describe("recordsDir", () => {
  test("'' means inherit the process cwd, not a path — undefined, not ''", () => {
    expect(recordsDir({ ...HOME_RUN, recordsRoot: "" })).toBeUndefined()
  })

  test("a non-empty recordsRoot reads back as-is", () => {
    expect(recordsDir(FOREIGN_RUN)).toBe("/tmp/records-9f2a")
  })
})

// Compile-time pin on `RunInfoService.recordsRoot` (PRINCIPLES.md, "An exported
// `runtime/` type ships with a compile-time pin on what it promises"): the field never
// becomes a value any runtime test can observe once a node reads it through `recordPath`/`recordsDir`,
// so erasing it (or widening it to `string | undefined`) is invisible until `tsc` catches
// it here. A `bun run typecheck` failure on the lines below is the whole test; the `describe` below
// only keeps the fact visible in the suite (`construct.test.ts`'s `.finalise` pin is the precedent).
type Extends<A, B> = [A] extends [B] ? true : false
const _recordsRootIsString: Extends<RunInfoService["recordsRoot"], string> = true
const _recordsRootNotWidened: Extends<string, RunInfoService["recordsRoot"]> = true

describe("RunInfoService — recordsRoot stays a required string", () => {
  test("the pin is a typecheck fact; this test exists so the file names it", () => {
    expect(_recordsRootIsString).toBe(true)
    expect(_recordsRootNotWidened).toBe(true)
  })
})
