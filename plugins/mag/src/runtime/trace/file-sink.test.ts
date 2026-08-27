import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import type { CloseEvent, OpenEvent } from "./event"
import { TraceEventSchema } from "./event"
import { fileSinkLayer } from "./file-sink"
import { TraceSinks } from "./sink"
import type { TraceSink } from "./sink"

/** Builds `fileSinkLayer(path)` and extracts the one sink it registers, matching sink.test.ts's Context.get pattern. */
const sinkFor = (path: string): TraceSink => {
  const context = Effect.runSync(Effect.scoped(Layer.build(fileSinkLayer(path))))
  const sinks = Context.get(context, TraceSinks)
  const [sink] = [...sinks]
  return sink
}

const readLines = (path: string): Array<string> => readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0)

const openEvent: OpenEvent = {
  kind: "open",
  runId: "run-1",
  spanId: "span-a",
  parentSpanId: null,
  name: "node-a",
  startTimeNanos: "1000000000"
}

const closeEvent: CloseEvent = {
  kind: "close",
  runId: "run-1",
  spanId: "span-b",
  name: "node-b",
  endTimeNanos: "2000000000",
  durationNanos: "1000000000",
  outcome: "ok"
}

describe("fileSinkLayer", () => {
  test("writing two events appends two lines, each valid JSON decoding through TraceEventSchema", () => {
    const dir = mkdtempSync(join(tmpdir(), "file-sink-"))
    const path = join(dir, "trace.ndjson")

    try {
      const sink = sinkFor(path)
      sink(openEvent)
      sink(closeEvent)

      const lines = readLines(path)
      expect(lines.length).toBe(2)
      for (const line of lines) {
        expect(() => Schema.decodeUnknownSync(TraceEventSchema)(JSON.parse(line))).not.toThrow()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("lines appear in emission order", () => {
    const dir = mkdtempSync(join(tmpdir(), "file-sink-"))
    const path = join(dir, "trace.ndjson")

    try {
      const sink = sinkFor(path)
      sink(openEvent)
      sink(closeEvent)

      const lines = readLines(path)
      const first = Schema.decodeUnknownSync(TraceEventSchema)(JSON.parse(lines[0]))
      const second = Schema.decodeUnknownSync(TraceEventSchema)(JSON.parse(lines[1]))

      expect(first.spanId).toBe(openEvent.spanId)
      expect(second.spanId).toBe(closeEvent.spanId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the file is appended to, not truncated, across a fresh call sequence", () => {
    const dir = mkdtempSync(join(tmpdir(), "file-sink-"))
    const path = join(dir, "trace.ndjson")

    try {
      sinkFor(path)(openEvent)
      // A fresh call sequence: build the layer again, as a second CLI invocation would.
      sinkFor(path)(closeEvent)

      const lines = readLines(path)
      expect(lines.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A redacted field must reach the file as the literal "<redacted>", never the secret.
  test("a redacted field in an event's value writes '<redacted>', never the secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "file-sink-"))
    const path = join(dir, "trace.ndjson")

    try {
      const RedactingSchema = Schema.Struct({
        token: Schema.Redacted(Schema.String),
        user: Schema.String
      })
      const secret = "super-secret-token-value"
      const encodedValue = Schema.encodeSync(RedactingSchema)({ token: Redacted.make(secret), user: "alice" })

      const eventWithSecret: CloseEvent = { ...closeEvent, value: encodedValue }

      const sink = sinkFor(path)
      sink(eventWithSecret)

      const contents = readFileSync(path, "utf8")
      expect(contents.includes("<redacted>")).toBe(true)
      expect(contents.includes("alice")).toBe(true)
      expect(contents.includes(secret)).toBe(false)
      expect(existsSync(path)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
