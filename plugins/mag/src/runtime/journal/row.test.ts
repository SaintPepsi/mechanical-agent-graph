import { describe, expect, test } from "bun:test"
import { Cause, Data, Exit, Option, Schema } from "effect"
import { JOURNAL_SCHEMA, JournalRowSchema, ranEndRow, replayedEndRow, startRow } from "mag/runtime/journal/row"
import type { RunInfoService } from "mag/runtime/run-info"
import { UNTAGGED_FAILURE } from "mag/runtime/trace/outcome"

const RUN: RunInfoService = {
  runId: "20260818123000",
  ticket: "GH-120",
  graph: "branch-name",
  repoRoot: "/home/dev/repo",
  workRoot: "/home/dev/repo",
  recordsRoot: "/home/dev/repo",
  records: "run-root",
  sha: "0123456789abcdef0123456789abcdef01234567",
  pipelineSha: "fedcba9876543210fedcba9876543210fedcba9",
  runRoot: "/home/dev/.claude/graph/repo-1a2b3c4d/GH-120/20260818123000"
}

const BASE = {
  run: RUN,
  node: "fetch-ticket",
  attempt: 1,
  input: Option.some({ ticket: "GH-120" })
}

const START_AT = "2026-08-18T12:30:00.000Z"
const END_AT = "2026-08-18T12:30:01.500Z"

class Boom extends Data.TaggedError("BOOM")<{ readonly detail: string }> {}

describe("startRow", () => {
  test("records the run-scoped stamp, the node's attempt, and one timestamp", () => {
    const row = startRow({ ...BASE, timestamp: START_AT })

    expect(row).toStrictEqual({
      schema: JOURNAL_SCHEMA,
      runId: RUN.runId,
      ticket: RUN.ticket,
      graph: RUN.graph,
      repoRoot: RUN.repoRoot,
      sha: RUN.sha,
      pipelineSha: RUN.pipelineSha,
      node: "fetch-ticket",
      attempt: 1,
      event: "start",
      timestamp: START_AT,
      input: { ticket: "GH-120" }
    })
  })

  test("an unencodable input leaves the field off rather than writing a placeholder", () => {
    const row = startRow({ ...BASE, input: Option.none(), timestamp: START_AT })

    expect(Object.hasOwn(row, "input")).toBe(false)
  })

  test("carries no outcome — a start entry cannot yet say how the node ended", () => {
    const row = startRow({ ...BASE, timestamp: START_AT })

    expect(Object.hasOwn(row, "outcome")).toBe(false)
    expect(Object.hasOwn(row, "replayed")).toBe(false)
  })
})

describe("ranEndRow", () => {
  test("a successful run records the stamp, one timestamp, and the success", () => {
    const row = ranEndRow({ ...BASE, timestamp: END_AT, exit: Exit.succeed("x"), success: Option.some({ title: "t" }) })

    expect(row).toStrictEqual({
      schema: JOURNAL_SCHEMA,
      runId: RUN.runId,
      ticket: RUN.ticket,
      graph: RUN.graph,
      repoRoot: RUN.repoRoot,
      sha: RUN.sha,
      pipelineSha: RUN.pipelineSha,
      node: "fetch-ticket",
      attempt: 1,
      event: "end",
      timestamp: END_AT,
      input: { ticket: "GH-120" },
      replayed: false,
      outcome: "ok",
      success: { title: "t" }
    })
  })

  test("no duration field, and no startedAt/endedAt — a reader pairs this against its start entry", () => {
    const row = ranEndRow({ ...BASE, timestamp: END_AT, exit: Exit.succeed("x"), success: Option.some(1) })

    expect(Object.hasOwn(row, "ms")).toBe(false)
    expect(Object.hasOwn(row, "startedAt")).toBe(false)
    expect(Object.hasOwn(row, "endedAt")).toBe(false)
  })

  test("a typed failure records outcome fail and the error's tag", () => {
    const row = ranEndRow({ ...BASE, timestamp: END_AT, exit: Exit.fail(new Boom({ detail: "d" })), success: Option.none() })

    expect(row.outcome).toBe("fail")
    expect(row.tag).toBe("BOOM")
    expect(Object.hasOwn(row, "success")).toBe(false)
  })

  test("a defect records outcome die, falling back to the untagged spelling", () => {
    const row = ranEndRow({ ...BASE, timestamp: END_AT, exit: Exit.die("raw"), success: Option.none() })

    expect(row.outcome).toBe("die")
    expect(row.tag).toBe(UNTAGGED_FAILURE)
  })

  test("an interruption records outcome interrupt and no tag", () => {
    const row = ranEndRow({
      ...BASE,
      timestamp: END_AT,
      exit: Exit.failCause(Cause.interrupt()),
      success: Option.none()
    })

    expect(row.outcome).toBe("interrupt")
    expect(Object.hasOwn(row, "tag")).toBe(false)
  })

  test("an unencodable input leaves the field off rather than writing a placeholder", () => {
    const row = ranEndRow({ ...BASE, input: Option.none(), timestamp: END_AT, exit: Exit.succeed("x"), success: Option.some(1) })

    expect(Object.hasOwn(row, "input")).toBe(false)
  })

  test("a success that would not encode leaves the field off, which re-runs the node next time", () => {
    const row = ranEndRow({ ...BASE, timestamp: END_AT, exit: Exit.succeed("x"), success: Option.none() })

    expect(row.outcome).toBe("ok")
    expect(Object.hasOwn(row, "success")).toBe(false)
  })
})

describe("replayedEndRow", () => {
  test("a replayed node's end entry is marked as replayed and stamped", () => {
    const row = replayedEndRow({ ...BASE, attempt: 2, timestamp: END_AT, success: { title: "t" } })

    expect(row.replayed).toBe(true)
    expect(row.outcome).toBe("ok")
    expect(row.attempt).toBe(2)
    expect(row.success).toStrictEqual({ title: "t" })
    expect(row.timestamp).toBe(END_AT)
  })
})

describe("JournalRowSchema", () => {
  test("every row builder's output round-trips through the schema", () => {
    const rows = [
      startRow({ ...BASE, timestamp: START_AT }),
      ranEndRow({ ...BASE, timestamp: END_AT, exit: Exit.succeed("x"), success: Option.some({ title: "t" }) }),
      ranEndRow({ ...BASE, timestamp: END_AT, exit: Exit.fail(new Boom({ detail: "d" })), success: Option.none() }),
      ranEndRow({ ...BASE, input: Option.none(), timestamp: END_AT, exit: Exit.die("raw"), success: Option.none() }),
      replayedEndRow({ ...BASE, timestamp: END_AT, success: { title: "t" } })
    ]

    for (const row of rows) {
      const wire = JSON.parse(JSON.stringify(Schema.encodeSync(JournalRowSchema)(row))) as unknown
      expect(Schema.decodeUnknownSync(JournalRowSchema)(wire)).toStrictEqual(row)
    }
  })

  test("a row from an unknown schema version is rejected", () => {
    const row = { ...ranEndRow({ ...BASE, timestamp: END_AT, exit: Exit.succeed("x"), success: Option.some(1) }), schema: "graph/journal@4" }

    expect(() => Schema.decodeUnknownSync(JournalRowSchema)(row)).toThrow()
  })

  test("a row missing pipelineSha (the pre-bump @2 shape) is rejected", () => {
    const row = ranEndRow({ ...BASE, timestamp: END_AT, exit: Exit.succeed("x"), success: Option.some(1) }) as Record<string, unknown>
    const { pipelineSha: _pipelineSha, ...withoutPipelineSha } = row

    expect(() => Schema.decodeUnknownSync(JournalRowSchema)(withoutPipelineSha)).toThrow()
  })

  test("a fractional attempt is rejected", () => {
    const row = { ...startRow({ ...BASE, timestamp: START_AT }), attempt: 1.5 }

    expect(() => Schema.decodeUnknownSync(JournalRowSchema)(row)).toThrow()
  })

  test("an event outside start/end is rejected", () => {
    const row = { ...startRow({ ...BASE, timestamp: START_AT }), event: "middle" }

    expect(() => Schema.decodeUnknownSync(JournalRowSchema)(row)).toThrow()
  })
})
