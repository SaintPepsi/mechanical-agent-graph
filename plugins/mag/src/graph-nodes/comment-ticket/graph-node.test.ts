import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { CommentBodyMissing, CommentFailed, CommentTrackerUnreachable } from "mag/graph-nodes/comment-ticket/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/comment-ticket/examples"
import { commentTicket } from "mag/graph-nodes/comment-ticket/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"

const stubShell = (reply: ShellResult) => {
  const calls: string[][] = []
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, service: ShellService) =>
  Effect.runPromise(Effect.result(effect.pipe(Effect.provide(shellLayer(service)))))

const ok = (stdout = ""): ShellResult => ({ exitCode: 0, stdout, stderr: "" })

describe("comment-ticket", () => {
  test("the fixtures decode against comment-ticket's own schemas", () => {
    if (!isSchemaHandle(commentTicket.input)) throw new Error("commentTicket.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(commentTicket.input)(example)
    if (!isSchemaHandle(commentTicket.success)) throw new Error("commentTicket.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(commentTicket.success)(example)
  })

  test("a missing report file fails before any spawn", async () => {
    const { calls, service } = stubShell(ok())
    const result = await runWith(
      commentTicket.run({ ticket: "GH-213", path: join(mkdtempSync(join(tmpdir(), "comment-ticket-")), "missing.md") }),
      service
    )
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(CommentBodyMissing)
    expect(calls).toHaveLength(0)
  })

  test("a present file posts with gh issue comment, the body by --body-file reference, never as argv text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comment-ticket-"))
    const path = join(dir, "review-patterns-1.md")
    writeFileSync(path, "Analysed through 2026-08-20T21:16:11.402Z\n")
    const { calls, service } = stubShell(ok())

    const result = await runWith(commentTicket.run({ ticket: "GH-213", path }), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ ticket: "GH-213" })
    expect(calls).toStrictEqual([["gh", "issue", "comment", "213", "--body-file", path]])
    expect(calls.every((call) => call[0] !== "sh")).toBe(true)
  })

  test("exit 4 (gh's own authentication-required code) maps to COMMENT_TRACKER_UNREACHABLE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comment-ticket-"))
    const path = join(dir, "review-patterns-1.md")
    writeFileSync(path, "x")
    const { service } = stubShell({ exitCode: 4, stdout: "", stderr: "gh: authentication required" })

    const result = await runWith(commentTicket.run({ ticket: "GH-213", path }), service)
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(CommentTrackerUnreachable)
  })

  test("any other non-zero exit is COMMENT_FAILED, carrying the code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comment-ticket-"))
    const path = join(dir, "review-patterns-1.md")
    writeFileSync(path, "x")
    const { service } = stubShell({ exitCode: 1, stdout: "", stderr: "gh: not authenticated" })

    const result = await runWith(commentTicket.run({ ticket: "GH-213", path }), service)
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(CommentFailed)
    expect((result.failure as CommentFailed).exitCode).toBe(1)
  })

  test("a ticket id with no trailing number is COMMENT_FAILED (exitCode 0), and gh never runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "comment-ticket-"))
    const path = join(dir, "review-patterns-1.md")
    writeFileSync(path, "x")
    const { calls, service } = stubShell(ok())

    const result = await runWith(commentTicket.run({ ticket: "nope", path }), service)
    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(CommentFailed)
    expect((result.failure as CommentFailed).exitCode).toBe(0)
    expect(calls).toHaveLength(0)
  })
})
