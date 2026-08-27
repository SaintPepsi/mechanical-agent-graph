import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import {
  TicketDraftMissing,
  TicketDraftOffSchema,
  TicketFilingRejected,
  TicketTrackerUnreachable
} from "mag/graph-nodes/github-ticket-create/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/github-ticket-create/examples"
import { githubTicketCreate } from "mag/graph-nodes/github-ticket-create/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo } from "mag/runtime/run-info"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { testRunInfo } from "mag/test/node-fixture"
import type { Ticket } from "mag/skills/ticket/schema"

const TICKET: Ticket = {
  title: "ticket-writer flow: What/Why/How in, house-style ticket filed",
  executiveSummary: "A ticket-writer graph turns three sentences into a filed house-style ticket.",
  type: "Story",
  component: ["plugins/mag/src/graphs/"],
  context: "Ticket writing today consumes a session's context.",
  acceptanceCriteria: [
    { title: "The writer's reply is the ticket's structure", given: "inputs What, Why, How", when: "write-ticket runs", then: ["it returns the structure"] }
  ],
  dependsOn: [],
  blocks: [],
  graphNodes: []
}

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

const ok = (stdout = ""): ShellResult => ({ exitCode: 0, stdout, stderr: "" })

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, shell: ShellService, runRoot: string) =>
  Effect.runPromise(
    Effect.result(effect.pipe(Effect.provide(shellLayer(shell)), Effect.provideService(RunInfo, testRunInfo({ runRoot }))))
  )

const withDraft = async <T>(fn: (runRoot: string, ticketPath: string) => Promise<T>): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), "github-ticket-create-node-"))
  const ticketPath = join(runRoot, "ticket-1.json")
  writeFileSync(ticketPath, JSON.stringify(TICKET, null, 2))
  return fn(runRoot, ticketPath)
}

describe("github-ticket-create", () => {
  test("the fixtures decode against github-ticket-create's own schemas", () => {
    if (!isSchemaHandle(githubTicketCreate.input)) throw new Error("githubTicketCreate.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(githubTicketCreate.input)(example)
    if (!isSchemaHandle(githubTicketCreate.success)) throw new Error("githubTicketCreate.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(githubTicketCreate.success)(example)
  })

  test("a missing ticketPath fails TicketDraftMissing before any spawn", () =>
    withDraft(async (runRoot) => {
      const { calls, service } = stubShell(ok())
      const result = await runWith(
        githubTicketCreate.run({ ticketPath: join(runRoot, "missing.json") }),
        service,
        runRoot
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TicketDraftMissing)
      expect(calls).toHaveLength(0)
    }))

  // `fromJsonString` carries the parse, so unparseable and off-schema arrive on the same rail:
  // both are decoded rather than assumed, and neither reaches a spawn.
  test.each([
    ["a file that is not a Ticket", JSON.stringify({ hello: "world" })],
    ["prose, not even JSON", "not json at all"]
  ])("%s fails TicketDraftOffSchema before any spawn", (_case, contents) =>
    withDraft(async (runRoot) => {
      const badPath = join(runRoot, "bad.json")
      writeFileSync(badPath, contents)
      const { calls, service } = stubShell(ok())

      const result = await runWith(githubTicketCreate.run({ ticketPath: badPath }), service, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TicketDraftOffSchema)
      expect(calls).toHaveLength(0)
    }))

  test("a valid draft renders the body to disk, files with gh issue create --title/--body-file, and returns the trimmed URL", () =>
    withDraft(async (runRoot, ticketPath) => {
      const { calls, service } = stubShell(ok("https://github.com/example/mechanical-agent-graph/issues/301\n"))

      const result = await runWith(githubTicketCreate.run({ ticketPath }), service, runRoot)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.issueUrl).toBe("https://github.com/example/mechanical-agent-graph/issues/301")
      expect(result.success.title).toBe(TICKET.title)
      expect(result.success.bodyPath).toBe(`${runRoot}/ticket-body-1.md`)

      const body = readFileSync(result.success.bodyPath, "utf8")
      expect(body.startsWith("## Executive Summary")).toBe(true)

      expect(calls).toStrictEqual([["gh", "issue", "create", "--title", TICKET.title, "--body-file", result.success.bodyPath]])
    }))

  test("no ClaudeAgent is imported by this module — 'dispatches no model session' as a static fact", async () => {
    const source = await Bun.file(new URL("./graph-node.ts", import.meta.url)).text()
    expect(source).not.toContain("ClaudeAgent")
  })

  test("exit 4 (gh's own authentication-required code) maps to TicketTrackerUnreachable, and the rendered body still lands on disk", () =>
    withDraft(async (runRoot, ticketPath) => {
      const { service } = stubShell({ exitCode: 4, stdout: "", stderr: "gh: authentication required" })

      const result = await runWith(githubTicketCreate.run({ ticketPath }), service, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TicketTrackerUnreachable)
      expect(readFileSync(`${runRoot}/ticket-body-1.md`, "utf8").length).toBeGreaterThan(0)
    }))

  test("any other non-zero exit is TicketFilingRejected, carrying the body path so it is pasteable by hand", () =>
    withDraft(async (runRoot, ticketPath) => {
      const { service } = stubShell({ exitCode: 1, stdout: "", stderr: "gh: not authenticated" })

      const result = await runWith(githubTicketCreate.run({ ticketPath }), service, runRoot)

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TicketFilingRejected)
      const failure = result.failure as TicketFilingRejected
      expect(failure.exitCode).toBe(1)
      expect(failure.bodyPath).toBe(`${runRoot}/ticket-body-1.md`)
      expect(readFileSync(failure.bodyPath, "utf8").length).toBeGreaterThan(0)
    }))
})
