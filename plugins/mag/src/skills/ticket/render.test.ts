import { describe, expect, test } from "bun:test"
import { renderTicketBody } from "mag/skills/ticket/render"
import type { Ticket } from "mag/skills/ticket/schema"

const BASE: Ticket = {
  title: "ticket-writer flow: What/Why/How in, house-style ticket filed",
  executiveSummary: "A ticket-writer graph turns three sentences into a filed house-style ticket.",
  type: "Story",
  component: ["plugins/mag/src/graphs/", "plugins/mag/src/graph-nodes/"],
  context: "Ticket writing today consumes a session's context.",
  acceptanceCriteria: [
    {
      title: "The writer's reply is the ticket's structure",
      given: "inputs What, Why, How",
      when: "write-ticket runs",
      then: ["its success value is schema-validated ticket structure", "a reply that is prose never succeeds"]
    }
  ],
  dependsOn: [],
  blocks: [],
  graphNodes: []
}

describe("renderTicketBody — golden markdown", () => {
  test("no GraphNodes header when the list is empty, and no trailing GraphNodes line anywhere", () => {
    const body = renderTicketBody(BASE)
    expect(body.startsWith("## Executive Summary")).toBe(true)
    expect(body).not.toContain("GraphNodes:")
  })

  test("a GraphNodes header renders first, one entry per node, marker then backtick name, space-joined", () => {
    const body = renderTicketBody({
      ...BASE,
      graphNodes: [
        { marker: "+", name: "write-ticket" },
        { marker: "+", name: "github-ticket-create" }
      ]
    })
    expect(body.startsWith("GraphNodes: + `write-ticket` + `github-ticket-create`\n\n## Executive Summary")).toBe(true)
  })

  test("Type and Component render as house-style metadata lines, each component backticked", () => {
    const body = renderTicketBody(BASE)
    expect(body).toContain("**Type:** Story")
    expect(body).toContain("**Component:** `plugins/mag/src/graphs/`, `plugins/mag/src/graph-nodes/`")
  })

  test("Context renders under its own heading", () => {
    const body = renderTicketBody(BASE)
    expect(body).toContain("## Context\n\nTicket writing today consumes a session's context.")
  })

  test("an AC block: numbered title, GIVEN/WHEN/THEN&AND lines nbsp-joined except the last", () => {
    const body = renderTicketBody(BASE)
    expect(body).toContain(
      [
        "**AC.01 - The writer's reply is the ticket's structure**",
        "",
        "**GIVEN** inputs What, Why, How&nbsp;",
        "**WHEN** write-ticket runs&nbsp;",
        "**THEN** its success value is schema-validated ticket structure&nbsp;",
        "**AND** a reply that is prose never succeeds"
      ].join("\n")
    )
  })

  test("depends/blocks renders last, after every criterion, 'nothing' on both sides when empty", () => {
    const body = renderTicketBody(BASE)
    expect(body.endsWith("> Depends on: nothing · Blocks: nothing")).toBe(true)
  })

  test("depends/blocks names what's given when non-empty", () => {
    const body = renderTicketBody({ ...BASE, dependsOn: ["GH-100"], blocks: ["GH-200", "GH-201"] })
    expect(body.endsWith("> Depends on: GH-100 · Blocks: GH-200, GH-201")).toBe(true)
  })

  test("criterion numbering stays two-digit and increasing across eleven criteria, no reset", () => {
    const eleven: Ticket = {
      ...BASE,
      acceptanceCriteria: Array.from({ length: 11 }, (_, index) => ({
        title: `criterion ${index + 1}`,
        given: "a state",
        when: "an action",
        then: ["an outcome"]
      }))
    }
    const body = renderTicketBody(eleven)
    expect(body).toContain("**AC.01 - criterion 1**")
    expect(body).toContain("**AC.10 - criterion 10**")
    expect(body).toContain("**AC.11 - criterion 11**")
  })

  test("a criterion's source (the writer's echo of a provided sentence) plays no part in the rendered body", () => {
    const body = renderTicketBody({
      ...BASE,
      acceptanceCriteria: [{ ...BASE.acceptanceCriteria[0]!, source: "the raw sentence write-ticket was given" }]
    })
    expect(body).not.toContain("the raw sentence write-ticket was given")
  })

  test("pure: the same ticket renders the same string twice", () => {
    expect(renderTicketBody(BASE)).toBe(renderTicketBody(BASE))
  })
})
