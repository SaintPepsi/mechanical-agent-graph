import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { AcceptanceCriteriaMissing } from "mag/graph-nodes/require-acs/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/require-acs/examples"
import { requireAcs } from "mag/graph-nodes/require-acs/graph-node"
import { recognizeAcceptanceCriteria } from "mag/graph-nodes/require-acs/recognizer"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"

const failure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const result = Effect.runSync(Effect.result(effect))
  if (!Result.isFailure(result)) throw new Error("expected a failure")
  return result.failure
}

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
    test("an AC-less body fails with the exact error value, naming the ticket, title and headings carried", () => {
      const error = failure(requireAcs.run({
        ticket: "GH-98",
        title: "Fix the parser",
        body: "## Summary\n\nNo ACs here.\n"
      }))
      expect(error).toBeInstanceOf(AcceptanceCriteriaMissing)
      expect(error).toStrictEqual(new AcceptanceCriteriaMissing({ ticket: "GH-98", title: "Fix the parser", headings: "Summary" }))
      expect(error.message).toContain("GH-98")
      expect(error.message).toContain("maintainer")
    })

    // `Effect.runSync` typechecks only against a `never` requirement, so it also proves the node is
    // pure: no `Shell`, no agent, nothing that could draft the criteria it is refusing over.
    test("a body with criteria succeeds with the count", () => {
      const value = Effect.runSync(requireAcs.run({
        ticket: "GH-98",
        title: "Fix the parser",
        body: "## Acceptance Criteria\n\n**AC.01 - First**\n\n**AC.02 - Second**\n"
      }))
      expect(value).toStrictEqual({ ticket: "GH-98", criteria: 2 })
    })
  })
})
