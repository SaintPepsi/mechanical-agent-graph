import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import {
  TicketCriteriaUnreadable,
  TicketCriterionDropped,
  TicketInputNotOneSentence,
  TicketRunRootMissing
} from "mag/graph-nodes/write-ticket/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/write-ticket/examples"
import { writeTicket } from "mag/graph-nodes/write-ticket/graph-node"
import { type ClaudeAgentService, type ClaudePrint, type ClaudeReply, claudeAgentLayer } from "mag/runtime/claude/service"
import { NullVerdict } from "mag/runtime/claude/errors"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { removeDir, testRunInfo } from "mag/test/node-fixture"
import type { Ticket } from "mag/skills/ticket/schema"

const INPUT = inputExamples[0]!

/** The structure the stub session answers with; the draft on disk is what the success names. */
const TICKET: Ticket = {
  title: "ticket-writer flow: What/Why/How in, house-style ticket filed",
  executiveSummary: "A ticket-writer graph turns three sentences into a filed house-style ticket.",
  type: "Story",
  component: ["plugins/mag/src/graphs/"],
  context: "Ticket writing today consumes a session's context.",
  acceptanceCriteria: [
    {
      title: "The writer's reply is the ticket's structure",
      given: "inputs What, Why, How",
      when: "write-ticket runs",
      then: ["its success value is schema-validated ticket structure"],
      source: "The writer's reply is the ticket's structure"
    }
  ],
  dependsOn: [],
  blocks: [],
  graphNodes: [{ marker: "+", name: "write-ticket" }]
}

/** Always answers with `verdict`, bypassing the transport's own schema decode — `write-pr-body`'s own `stubAgent` precedent. */
const stubAgent = (verdict: Ticket = TICKET) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      return Effect.succeed({ verdict: verdict as A, result: {}, sessions: ["write-ticket-session"], costUsd: 0.08, attempts: 1 } as ClaudeReply<A>)
    }
  }
  return { requests, service }
}

/** Runs the request's own `jsonSchema.decode` against a raw payload, the transport's real behaviour (`agent.ts`'s `resolve`) — proves that a reply that is prose instead of the schema shape never succeeds, against the actual decode, not a stub that skips it. */
const proseAgent = (): ClaudeAgentService => ({
  prompt: <A>(request: ClaudePrint<A>) => {
    if (request.jsonSchema === undefined) throw new Error("proseAgent: no jsonSchema on this request")
    return request.jsonSchema.decode("just a prose reply, not an object").pipe(
      Effect.map((verdict) => ({ verdict, result: {}, sessions: ["s"], costUsd: 0, attempts: 1 }) as ClaudeReply<A>),
      Effect.mapError(() => new NullVerdict({ reason: "decode-mismatch", attempts: 1, sessionId: "s", snippet: "prose" }))
    )
  }
})

const withRunRoot = async <T>(fn: (runRoot: string) => Promise<T>): Promise<T> => {
  const runRoot = mkdtempSync(join(tmpdir(), "write-ticket-node-"))
  try {
    return await fn(runRoot)
  } finally {
    await removeDir(runRoot)
  }
}

const runWith = <A, E>(
  effect: Effect.Effect<A, E, never>,
  agent: ClaudeAgentService,
  run: RunInfoService
) =>
  Effect.runPromise(
    Effect.result(effect.pipe(Effect.provide(claudeAgentLayer(agent)), Effect.provideService(RunInfo, run)))
  )

describe("write-ticket", () => {
  test("the fixtures decode against write-ticket's own schemas", () => {
    if (!isSchemaHandle(writeTicket.input)) throw new Error("writeTicket.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(writeTicket.input)(example)
    if (!isSchemaHandle(writeTicket.success)) throw new Error("writeTicket.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(writeTicket.success)(example)
  })

  // Two sentences and none at all leave the same thing behind, nothing one Gherkin field can hold.
  test.each([
    ["why", "The API times out. Also the DB crashes."],
    ["what", ""]
  ] as const)("a %s that is not one sentence fails TicketInputNotOneSentence before any dispatch, naming the field", (field, value) =>
    withRunRoot(async (runRoot) => {
      const agent = stubAgent()
      const result = await runWith(
        writeTicket.run({ ...INPUT, [field]: value }),
        agent.service,
        testRunInfo({ runRoot })
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TicketInputNotOneSentence)
      expect((result.failure as TicketInputNotOneSentence).field).toBe(field)
      expect(agent.requests).toHaveLength(0)
    }))

  test("an empty runRoot is a wiring bug, not a data problem — TicketRunRootMissing before any dispatch", async () => {
    const agent = stubAgent()
    const result = await runWith(writeTicket.run(INPUT), agent.service, testRunInfo({ runRoot: "" }))

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(TicketRunRootMissing)
    expect(agent.requests).toHaveLength(0)
  })

  // Both halves of `readCriteria`'s gate: the file has to be there, and it has to hold a criterion.
  // `undefined` contents means the file is never written, so the path names nothing.
  test.each([
    ["a missing criteriaPath", undefined],
    ["a criteria file with only blank lines", "\n\n   \n"]
  ] as const)("%s fails TicketCriteriaUnreadable before any dispatch", (_case, contents) =>
    withRunRoot(async (runRoot) => {
      const agent = stubAgent()
      const criteriaPath = join(runRoot, "criteria.txt")
      if (contents !== undefined) writeFileSync(criteriaPath, contents)
      const result = await runWith(
        writeTicket.run({ ...INPUT, criteriaPath }),
        agent.service,
        testRunInfo({ runRoot })
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TicketCriteriaUnreadable)
      expect(agent.requests).toHaveLength(0)
    }))

  test("a stubbed verdict returns the structure, and the draft lands in the run root as JSON", () =>
    withRunRoot(async (runRoot) => {
      const agent = stubAgent()
      const result = await runWith(writeTicket.run(INPUT), agent.service, testRunInfo({ runRoot }))

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.ticketPath).toBe(`${runRoot}/ticket-1.json`)
      expect(JSON.parse(readFileSync(result.success.ticketPath, "utf8"))).toStrictEqual(TICKET)
      expect(result.success.sessions).toStrictEqual(["write-ticket-session"])
      expect(result.success.costUsd).toBe(0.08)
    }))

  test("a stub that drops a provided criterion fails TICKET_CRITERION_DROPPED, and the draft it names is already on disk", () =>
    withRunRoot(async (runRoot) => {
      const criteriaPath = join(runRoot, "criteria.txt")
      writeFileSync(criteriaPath, "A first criterion.\nA second criterion.\n")

      // The stub's reply only echoes the first — the writer dropped the second.
      const verdict: Ticket = {
        ...TICKET,
        acceptanceCriteria: [{ ...TICKET.acceptanceCriteria[0]!, source: "A first criterion." }]
      }
      const agent = stubAgent(verdict)
      const result = await runWith(
        writeTicket.run({ ...INPUT, criteriaPath }),
        agent.service,
        testRunInfo({ runRoot })
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(TicketCriterionDropped)
      const failure = result.failure as TicketCriterionDropped
      expect(failure.missing).toEqual(["A second criterion."])
      expect(readFileSync(failure.ticketPath, "utf8").length).toBeGreaterThan(0)
    }))

  test("a reply that is prose instead of the schema shape never succeeds — the tool-call layer's own decode rejects it", () =>
    withRunRoot(async (runRoot) => {
      const result = await runWith(writeTicket.run(INPUT), proseAgent(), testRunInfo({ runRoot }))

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      expect(result.failure).toBeInstanceOf(NullVerdict)
    }))

  test("agent and model reach the dispatch verbatim when present, absent when not", () =>
    withRunRoot(async (runRoot) => {
      const run = testRunInfo({ runRoot })
      const bare = stubAgent()
      await runWith(writeTicket.run(INPUT), bare.service, run)
      expect(bare.requests[0]!.agent).toBeUndefined()
      expect(bare.requests[0]!.model).toBeUndefined()

      // inputExamples[1]'s criteriaPath is illustrative (a decode-only fixture), not a file that
      // exists on this machine — a real one is needed to reach dispatch.
      const criteriaPath = join(runRoot, "criteria.txt")
      writeFileSync(criteriaPath, "A first criterion.\n")
      const assigned = stubAgent()
      await runWith(writeTicket.run({ ...inputExamples[1]!, criteriaPath }), assigned.service, run)
      expect(assigned.requests[0]!.agent).toBe("effect-expert")
      expect(assigned.requests[0]!.model).toBe("sonnet")
    }))

  test("the compiled standard and the three inputs reach the prompt, and a provided criterion's sentence is named for the writer to echo", () =>
    withRunRoot(async (runRoot) => {
      const criteriaPath = join(runRoot, "criteria.txt")
      writeFileSync(criteriaPath, "A first criterion.\n")
      const agent = stubAgent()
      await runWith(writeTicket.run({ ...INPUT, criteriaPath }), agent.service, testRunInfo({ runRoot }))

      const prompt = agent.requests[0]!.prompt
      expect(prompt).toContain(`What: ${INPUT.what}`)
      expect(prompt).toContain(`Why: ${INPUT.why}`)
      expect(prompt).toContain(`How: ${INPUT.how}`)
      expect(prompt).toContain("A first criterion.")
      expect(prompt).toContain("Write the ticket's structure under this standard.")
    }))
})
