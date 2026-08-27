import { describe, expect, test } from "bun:test"
import { compileTicketStandard } from "mag/skills/ticket/compose"
import { GRAPH_NODE_MARKER_LEGEND } from "mag/skills/ticket/schema"
import { TICKET_STANDARD } from "mag/skills/ticket/variant"

describe("compileTicketStandard — TICKET_STANDARD", () => {
  const compiled = compileTicketStandard(TICKET_STANDARD)

  test("opens straight on the instruction, no front-matter: spliced into a prompt, never installed", () => {
    expect(compiled.startsWith("Write the ticket's structure")).toBe(true)
  })

  // The house standard's six elements (executive summary, Type/Component, context,
  // Gherkin ACs, depends/blocks, GraphNodes) all reach the compiled prompt.
  test("every one of the six house-standard elements gets its own heading", () => {
    expect(compiled).toContain("Executive summary:")
    expect(compiled).toContain("Type and component:")
    expect(compiled).toContain("Context:")
    expect(compiled).toContain("Acceptance criteria:")
    expect(compiled).toContain("Depends/blocks:")
    expect(compiled).toContain("Graph nodes:")
  })

  // The marker glyphs must carry their meaning somewhere a model reads at dispatch, not just as a bare enum.
  test("the graph-nodes marker legend renders, the same string schema.ts puts on the marker field", () => {
    expect(compiled).toContain(GRAPH_NODE_MARKER_LEGEND)
  })

  test("every concern's own text renders, in the order TICKET_STANDARD lists", () => {
    let cursor = 0
    for (const concern of TICKET_STANDARD) {
      const index = compiled.indexOf(concern.section!.heading, cursor)
      expect(index).toBeGreaterThanOrEqual(cursor)
      cursor = index + concern.section!.heading.length
    }
  })

  // Cold-startable: a repo with no history of this ticket must still be able to follow the
  // standard, asserted mechanically rather than by reading. Each concern's own body is checked
  // alongside the composed join, so a dirty section is named where it is authored.
  test("cold-startable: no ticket numbers, no issue references, no repo path fragments, no em-dash", () => {
    for (const text of [compiled, ...TICKET_STANDARD.map((concern) => concern.section!.body(null))]) {
      expect(text).not.toMatch(/GH-\d/)
      expect(text).not.toMatch(/#\d/)
      expect(text).not.toContain("plugins/")
      expect(text).not.toContain("docs/")
      expect(text).not.toContain("—")
      expect(text.toLowerCase()).not.toContain("ruled")
      expect(text.toLowerCase()).not.toContain("maintainer")
    }
  })
})

describe("compileTicketStandard — pure: concerns in, string out", () => {
  test("the same concern list renders the same string twice", () => {
    expect(compileTicketStandard(TICKET_STANDARD)).toBe(compileTicketStandard(TICKET_STANDARD))
  })

  test("dropping a concern drops its text, and nothing else's — proves the composer knows no concern's name", () => {
    const withoutStyle = compileTicketStandard(TICKET_STANDARD.filter((concern) => concern.id !== "style"))
    expect(withoutStyle).not.toContain("No em-dashes")
    expect(withoutStyle).toContain("Executive summary:")
    expect(withoutStyle).toContain("Graph nodes:")
  })
})
