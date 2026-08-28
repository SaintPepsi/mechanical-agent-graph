import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { AcceptanceCriteriaMissing, TicketUnreadable } from "mag/graph-nodes/require-acs/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/require-acs/examples"
import { requireAcs } from "mag/graph-nodes/require-acs/graph-node"
import { recognizeAcceptanceCriteria } from "mag/graph-nodes/require-acs/recognizer"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { withRunRoot } from "mag/test/node-fixture"

const failure = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const result = await Effect.runPromise(Effect.result(effect))
  if (!Result.isFailure(result)) throw new Error("expected a failure")
  return result.failure
}

/** Stands in for `fetch-ticket`'s own write: the node reads the ticket from disk, never from its input. */
const withTicket = <T>(body: string, fn: (ticketPath: string) => Promise<T>): Promise<T> =>
  withRunRoot("require-acs", (runRoot) => {
    const ticketPath = join(runRoot, "ticket.md")
    writeFileSync(ticketPath, body)
    return fn(ticketPath)
  })

describe("require-acs", () => {
  test("the fixtures decode against require-acs's own schemas", () => {
    if (!isSchemaHandle(requireAcs.input)) throw new Error("input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(requireAcs.input)(example)
    if (!isSchemaHandle(requireAcs.success)) throw new Error("success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(requireAcs.success)(example)
  })

  describe("recognizeAcceptanceCriteria", () => {
    test("the house format — bold AC.NN headers under a heading with trailing text — counts each one, not the GIVEN/WHEN/THEN prose beneath them", () => {
      const body = [
        "## Executive Summary",
        "",
        "Some text.",
        "",
        "## Acceptance criteria (drafted by ingest)",
        "",
        "**AC.01 - First**",
        "",
        "**GIVEN** a thing",
        "",
        "**AC.02 - Second**",
        "",
        "**WHEN** something happens"
      ].join("\n")
      const result = recognizeAcceptanceCriteria(body)
      expect(result.criteria).toStrictEqual(["**AC.01 - First**", "**AC.02 - Second**"])
    })

    test("a plain checklist under the heading counts, the leniency for lines that don't name AC<n>", () => {
      const body = "## Acceptance Criteria\n\n- ships the CLI flag\n- documents the default\n"
      expect(recognizeAcceptanceCriteria(body).criteria).toHaveLength(2)
    })

    test("a lone `none` bullet counts zero, the carve-out for a section that says there are none", () => {
      const body = "## Acceptance Criteria\n\n- none\n"
      expect(recognizeAcceptanceCriteria(body).criteria).toHaveLength(0)
    })

    test("no acceptance-criteria heading at all counts zero, and the headings inventory reports what the body did carry", () => {
      const body = "## Summary\n\nNo ACs here.\n"
      const result = recognizeAcceptanceCriteria(body)
      expect(result.criteria).toHaveLength(0)
      expect(result.headings).toStrictEqual(["Summary"])
    })

    test("a ### sub-heading inside the section does not end it; the next ## does", () => {
      const body = [
        "## Acceptance Criteria",
        "",
        "### Notes",
        "",
        "- keep me: still inside the section",
        "",
        "## Something Else",
        "",
        "- drop me: outside the section now"
      ].join("\n")
      expect(recognizeAcceptanceCriteria(body).criteria).toStrictEqual(["- keep me: still inside the section"])
    })

    test("a blockquoted heading (a rendered maintainer comment) does not anchor a section", () => {
      const body = "> ## Acceptance Criteria\n\n> - AC1: quoted, should not count\n"
      expect(recognizeAcceptanceCriteria(body).criteria).toHaveLength(0)
    })
  })

  describe("the node", () => {
    test("an AC-less ticket file fails with the exact error value, naming the ticket, title and headings carried", () =>
      withTicket("## Summary\n\nNo ACs here.\n", async (ticketPath) => {
        const error = await failure(requireAcs.run({ ticket: "GH-98", title: "Fix the parser", ticketPath }))
        expect(error).toBeInstanceOf(AcceptanceCriteriaMissing)
        expect(error).toStrictEqual(new AcceptanceCriteriaMissing({ ticket: "GH-98", title: "Fix the parser", headings: "Summary" }))
        expect(error.message).toContain("GH-98")
        expect(error.message).toContain("maintainer")
      }))

    // `Effect.runPromise` typechecks only against a `never` requirement, so it also proves the node
    // reaches nothing but the file: no `Shell`, no agent, nothing that could draft the criteria it is refusing over.
    test("a ticket file with criteria succeeds with the count", () =>
      withTicket("## Acceptance Criteria\n\n**AC.01 - First**\n\n**AC.02 - Second**\n", async (ticketPath) => {
        const value = await Effect.runPromise(requireAcs.run({ ticket: "GH-98", title: "Fix the parser", ticketPath }))
        expect(value).toStrictEqual({ ticket: "GH-98", criteria: 2 })
      }))

    test("a missing ticket file is TicketUnreadable, naming the path", async () => {
      const error = await failure(requireAcs.run({ ticket: "GH-98", title: "Fix the parser", ticketPath: "/nowhere/ticket.md" }))
      expect(error).toBeInstanceOf(TicketUnreadable)
      expect((error as TicketUnreadable).path).toBe("/nowhere/ticket.md")
    })
  })
})
