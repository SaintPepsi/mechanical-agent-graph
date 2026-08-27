import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { ticketWriter } from "mag/graphs/ticket-writer/graph"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { type RootEnv, RunRootEnv } from "mag/runtime/run-layers"
import { journalPathFor } from "mag/runtime/run-root"
import { RunId } from "mag/runtime/trace/layer"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"
import { removeDir } from "mag/test/node-fixture"

const RUN_ID = "20260825120000-fb1e"
const INPUT = {
  what: "Ticket writing costs a session its context.",
  why: "So filing a ticket does not spend the budget of the ticket it describes.",
  how: "Turn three sentences into a schema-validated ticket a mechanical node files."
}

const stubAgent = (): { readonly requests: Array<ClaudePrint<unknown>>; readonly service: ClaudeAgentService } => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      const verdict = {
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
      } as A
      return Effect.succeed({ verdict, result: {}, sessions: ["session-write-ticket"], costUsd: 0.08, attempts: 1 } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

/** `git rev-parse --show-toplevel` for `runScopedLayers`, then `gh issue create` for the filer — the two subprocess calls this graph's own pipeline makes. */
const shellFor = (repoRoot: string): ShellService => ({
  run: (argv): Effect.Effect<ShellResult> => {
    if (argv.includes("--show-toplevel")) return Effect.succeed({ exitCode: 0, stdout: `${repoRoot}\n`, stderr: "" })
    if (argv[0] === "gh" && argv[1] === "issue" && argv[2] === "create") {
      return Effect.succeed({ exitCode: 0, stdout: "https://github.com/example/mechanical-agent-graph/issues/301\n", stderr: "" })
    }
    return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
  }
})

const tempRoot = (): RootEnv => ({
  env: { CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "ticket-writer-root-")) },
  home: "/unused"
})

const withRepo = async <T>(fn: (repoRoot: string) => Promise<T>): Promise<T> => {
  const repoRoot = mkdtempSync(join(tmpdir(), "ticket-writer-repo-"))
  try {
    return await fn(repoRoot)
  } finally {
    await removeDir(repoRoot)
  }
}

const runTicketWriter = (repoRoot: string, root: RootEnv, agent: ClaudeAgentService) =>
  Effect.runPromise(
    ticketWriter.run(INPUT).pipe(
      Effect.provideService(RunRootEnv, root),
      Effect.provideService(RunId, RUN_ID),
      Effect.provide(shellLayer(shellFor(repoRoot))),
      Effect.provide(claudeAgentLayer(agent))
    )
  )

describe("ticket-writer", () => {
  test("hands the writer's ticketPath to the filer, sums sessions and cost, and returns the filed URL", () =>
    withRepo(async (repoRoot) => {
      const root = tempRoot()
      const agent = stubAgent()

      const success = await runTicketWriter(repoRoot, root, agent.service)

      expect(success.issueUrl).toBe("https://github.com/example/mechanical-agent-graph/issues/301")
      expect(success.title).toBe("ticket-writer flow: What/Why/How in, house-style ticket filed")
      expect(success.ticketPath.endsWith(".json")).toBe(true)
      expect(readFileSync(success.ticketPath, "utf8")).toContain(success.title)
      expect(success.bodyPath.endsWith(".md")).toBe(true)
      expect(readFileSync(success.bodyPath, "utf8")).toContain("## Executive Summary")
      expect(success.sessions).toEqual(["session-write-ticket"])
      expect(success.costUsd).toBe(0.08)
      // github-ticket-create dispatches no model of its own — the writer's one session is the whole list.
      expect(agent.requests).toHaveLength(1)
    }))

  test("one journal covers both nodes, stamped with this graph's own name", () =>
    withRepo(async (repoRoot) => {
      const root = tempRoot()
      const agent = stubAgent()

      await runTicketWriter(repoRoot, root, agent.service)

      const path = journalPathFor({ ...root, repoPath: repoRoot, ticket: "draft", runId: RUN_ID })
      const rows = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { readonly node: string; readonly graph: string; readonly event: string })
        .filter((row) => row.event === "end")

      const names = rows.map((row) => row.node)
      expect(names).toContain("write-ticket")
      expect(names).toContain("github-ticket-create")
      expect(rows.every((row) => row.graph === "ticket-writer")).toBe(true)
    }))
})
