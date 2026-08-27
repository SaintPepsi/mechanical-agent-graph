import { describe, expect, test } from "bun:test"
import { Redacted, Schema } from "effect"
import { CloseEventSchema, OpenEventSchema, TraceEventSchema } from "./event"
import type { CloseEvent, OpenEvent } from "./event"

const openEvent: OpenEvent = {
  kind: "open",
  runId: "run-1",
  spanId: "span-1",
  parentSpanId: null,
  name: "example-node",
  startTimeNanos: "1000000000",
  input: { note: "hello" }
}

const closeEvent: CloseEvent = {
  kind: "close",
  runId: "run-1",
  spanId: "span-1",
  name: "example-node",
  endTimeNanos: "2000000000",
  durationNanos: "1000000000",
  outcome: "fail",
  tag: "BOOM",
  value: { message: "kaboom" }
}

describe("TraceEventSchema", () => {
  test("round-trips a fully-populated OpenEvent (decode ∘ encode = identity)", () => {
    const encoded = Schema.encodeSync(TraceEventSchema)(openEvent)
    const decoded = Schema.decodeUnknownSync(TraceEventSchema)(encoded)

    expect(decoded).toEqual(openEvent)
  })

  test("round-trips a fully-populated CloseEvent (decode ∘ encode = identity)", () => {
    const encoded = Schema.encodeSync(TraceEventSchema)(closeEvent)
    const decoded = Schema.decodeUnknownSync(TraceEventSchema)(encoded)

    expect(decoded).toEqual(closeEvent)
  })

  test("the union discriminates on kind — decoding a close-shaped record never yields an OpenEvent", () => {
    const encodedClose = Schema.encodeSync(CloseEventSchema)(closeEvent)

    const decoded = Schema.decodeUnknownSync(TraceEventSchema)(encodedClose)

    expect(decoded.kind).toBe("close")
    expect(TraceEventSchema.guards.close(decoded)).toBe(true)
    expect(TraceEventSchema.guards.open(decoded)).toBe(false)
    // An OpenEvent-only field must not have leaked onto the decoded value.
    expect(Object.hasOwn(decoded, "parentSpanId")).toBe(false)
  })

  test("decoding a record missing a required field fails, rather than producing a partial event", () => {
    const { startTimeNanos: _omit, ...incomplete } = Schema.encodeSync(OpenEventSchema)(openEvent)

    expect(() => Schema.decodeUnknownSync(TraceEventSchema)(incomplete)).toThrow()
  })

  // A redacted field must never surface its value through a sink
  // that JSON.stringifies an encoded event, while its non-redacted sibling survives intact —
  // a test that only checks the secret is gone would also pass against a schema that dropped
  // every field, so both assertions are required.
  test("a Schema.Redacted field never appears in JSON.stringify output; its sibling field does", () => {
    const RedactingSchema = Schema.Struct({
      token: Schema.Redacted(Schema.String),
      user: Schema.String
    })
    const secret = "super-secret-token-value"
    const value = { token: Redacted.make(secret), user: "alice" }

    const encoded = Schema.encodeSync(RedactingSchema)(value)
    const json = JSON.stringify(encoded)

    expect(json.includes("<redacted>")).toBe(true)
    expect(json.includes(secret)).toBe(false)
    expect(json.includes("alice")).toBe(true)
  })
})
