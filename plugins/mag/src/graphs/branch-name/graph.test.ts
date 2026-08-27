import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { branchName } from "mag/graphs/branch-name/graph"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"

// The issue fixture's author must match MAINTAINER to pass fetch-ticket's authorship gate.
const MAINTAINER = "SaintPepsi"

const ok = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" })

const okIssue = (title: string, body: string): ShellResult =>
  ok(JSON.stringify({ title, body, author: { login: MAINTAINER }, comments: [] }))

const stubShell = (issueReply: ShellResult): ShellService => ({
  run: (argv) => {
    if (argv[1] === "issue") return Effect.succeed(issueReply)
    throw new Error(`stubShell: unexpected argv: ${argv.join(" ")}`)
  }
})

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, issueReply: ShellResult) =>
  Effect.runSync(Effect.result(effect.pipe(Effect.provide(shellLayer(stubShell(issueReply))))))

describe("branch-name (graph)", () => {
  test("wears the GraphNode shape, so the registry can run it with no graph runner", () => {
    expect(isSchemaHandle(branchName.input)).toBe(true)
    expect(isSchemaHandle(branchName.success)).toBe(true)
    expect(branchName.name).toBe("branch-name")
  })

  test("pipes a ticket id through both nodes into a branch name", () => {
    const result = runWith(branchName.run({ ticket: "GH-98" }), okIssue("Fix the NUL-byte crash", "## Summary"))
    if (!Result.isSuccess(result)) throw new Error("expected a success")
    expect(result.success).toStrictEqual({
      ticket: "GH-98",
      title: "Fix the NUL-byte crash",
      branch: "feat/GH-98-fix-the-nul-byte-crash"
    })
  })

  test("its success decodes against its own schema", () => {
    const result = runWith(branchName.run({ ticket: "GH-98" }), okIssue("A title", "body"))
    if (!Result.isSuccess(result)) throw new Error("expected a success")
    if (!isSchemaHandle(branchName.success)) throw new Error("success is not a Schema")
    Schema.decodeUnknownSync(branchName.success)(result.success)
  })

  test("drops the body, because nothing downstream of this graph consumes it yet", () => {
    const result = runWith(branchName.run({ ticket: "GH-98" }), okIssue("A title", "the body"))
    if (!Result.isSuccess(result)) throw new Error("expected a success")
    expect(Object.keys(result.success).sort()).toStrictEqual(["branch", "ticket", "title"])
  })

  test("every branch is feat/ until a node produces labels — the gap is real, not hidden", () => {
    // fetch-ticket's success shape carries title and body only, so `branchType` never sees "bug"
    // here even though the ticket is one. This test exists so closing that gap has to change a test.
    const result = runWith(branchName.run({ ticket: "GH-98" }), okIssue("Fix a bug", "body"))
    if (!Result.isSuccess(result)) throw new Error("expected a success")
    expect(result.success.branch.startsWith("feat/")).toBe(true)
  })

  test("a failure in the first node surfaces untouched, not wrapped by the graph", () => {
    // fetch-ticket's one gh call; any argv, one reply.
    const alwaysFails: ShellService = { run: () => Effect.succeed({ exitCode: 3, stdout: "", stderr: "no gh" }) }
    const result = Effect.runSync(Effect.result(branchName.run({ ticket: "GH-98" }).pipe(Effect.provide(shellLayer(alwaysFails)))))
    if (!Result.isFailure(result)) throw new Error("expected a failure")
    expect((result.failure as { _tag: string })._tag).toBe("FETCH_TICKET_TRACKER_FAILED")
  })
})
