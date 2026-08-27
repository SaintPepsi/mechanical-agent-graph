import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { MissingTicketId } from "mag/graph-nodes/format-branch-name/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/format-branch-name/examples"
import { branchType, formatBranchName, normaliseTicketId, slugify } from "mag/graph-nodes/format-branch-name/format"
import { formatBranchNameNode } from "mag/graph-nodes/format-branch-name/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"

const succeed = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect)
const failure = <A, E>(effect: Effect.Effect<A, E>): E => {
  const result = Effect.runSync(Effect.result(effect))
  if (!Result.isFailure(result)) throw new Error("expected a failure")
  return result.failure
}

describe("format-branch-name", () => {
  test("the fixtures decode against format-branch-name's own schemas", () => {
    if (!isSchemaHandle(formatBranchNameNode.input)) throw new Error("input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(formatBranchNameNode.input)(example)
    if (!isSchemaHandle(formatBranchNameNode.success)) throw new Error("success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(formatBranchNameNode.success)(example)
  })

  describe("slugify", () => {
    test("lowercases and collapses every run of non-alphanumerics to one dash", () => {
      expect(slugify("Add   sitting//location!!")).toBe("add-sitting-location")
    })

    test("trims leading and trailing dashes rather than emitting them", () => {
      expect(slugify("  --Hello--  ")).toBe("hello")
    })

    test("truncates at the last word boundary inside the limit, never mid-word", () => {
      // The slug is 54 chars against a 48-char limit, so the cut lands inside "different" and
      // retreats to the dash before it.
      expect(slugify("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii different", 48))
        .toBe("aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh-iiii")
    })

    test("falls back to a hard cut when there is no boundary to retreat to", () => {
      expect(slugify("a".repeat(60), 48)).toBe("a".repeat(48))
    })

    test("every character git forbids in a ref is unrepresentable by construction", () => {
      expect(slugify("a~b^c:d?e*f[g\\h i")).toBe("a-b-c-d-e-f-g-h-i")
    })
  })

  describe("branchType", () => {
    test("maps each label vocabulary onto the convention's type slot", () => {
      expect(branchType(["bug"])).toBe("bugfix")
      expect(branchType(["Regression"])).toBe("bugfix")
      expect(branchType(["documentation"])).toBe("chore")
      expect(branchType(["task"])).toBe("task")
    })

    test("takes the first label that maps, ignoring ones that do not", () => {
      expect(branchType(["needs-triage", "P1", "docs"])).toBe("chore")
    })

    test("defaults to feat when no label maps, including when there are none", () => {
      expect(branchType(["P1"])).toBe("feat")
      expect(branchType([])).toBe("feat")
    })
  })

  describe("normaliseTicketId", () => {
    test("keeps alphanumerics and single dashes, drops the rest", () => {
      expect(normaliseTicketId("GH-98")).toBe("GH-98")
      expect(normaliseTicketId("  #proj/42 ")).toBe("proj-42")
    })

    test("is empty when nothing usable survives", () => {
      expect(normaliseTicketId("///")).toBe("")
    })
  })

  describe("formatBranchName", () => {
    test("joins type, id and slug in the documented convention", () => {
      expect(formatBranchName("GH-98", "Fix the parser", ["bug"])).toBe("bugfix/GH-98-fix-the-parser")
    })

    test("strips one leading copy of the id so the branch does not stutter", () => {
      expect(formatBranchName("EP-1633", "EP-1633 — Add sitting location", []))
        .toBe("feat/EP-1633-add-sitting-location")
    })

    test("omits the trailing dash when the title contributes no slug", () => {
      expect(formatBranchName("GH-98", "", [])).toBe("feat/GH-98")
      expect(formatBranchName("GH-98", "!!!", [])).toBe("feat/GH-98")
    })
  })

  describe("the node", () => {
    test("succeeds with the branch a ticket should use", () => {
      const value = succeed(formatBranchNameNode.run({ ticket: "GH-98", title: "Fix the parser", labels: ["bug"] }))
      expect(value).toStrictEqual({ branch: "bugfix/GH-98-fix-the-parser" })
    })

    test("treats title and labels as genuinely optional, defaulting the type to feat", () => {
      const value = succeed(formatBranchNameNode.run({ ticket: "GH-98" }))
      expect(value).toStrictEqual({ branch: "feat/GH-98" })
    })

    test("fails with MissingTicketId when a ticket id normalises to nothing", () => {
      const error = failure(formatBranchNameNode.run({ ticket: "///" }))
      expect(error).toBeInstanceOf(MissingTicketId)
      expect(error._tag).toBe("FORMAT_BRANCH_NAME_MISSING_TICKET_ID")
      expect(error.ticket).toBe("///")
    })

    test("is pure — no requirements, so it needs no layer to run", () => {
      // The `Effect.runSync` above is itself the proof: it does not typecheck against a non-never R.
      expect(formatBranchNameNode.name).toBe("format-branch-name")
    })
  })
})
