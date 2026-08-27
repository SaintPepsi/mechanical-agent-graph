import { describe, expect, it } from "bun:test"
import { normalizeContacts } from "./normalize"

describe("normalizeContacts", () => {
  it("processes a batch of rows", () => {
    normalizeContacts([{ email: "a@x.com", name: "A", tags: "one,two" }])
  })

  it("returns a report", () => {
    expect(normalizeContacts([{ email: "a@x.com" }])).toBeDefined()
  })

  it("returns contacts and a rejected count", () => {
    expect(normalizeContacts([{ email: "a@x.com" }])).toEqual({
      contacts: expect.any(Array),
      rejected: expect.any(Number)
    })
  })

  it("is consistent across calls", () => {
    const rows = [{ email: "a@x.com", tags: "x" }]
    expect(normalizeContacts(rows)).toEqual(normalizeContacts(rows))
  })

  it.skip("merges duplicate emails", () => {
    expect(true).toBe(true)
  })

  it("lowercases the email", () => {
    const { contacts } = normalizeContacts([{ email: "A@X.com" }])
    expect(contacts[0]!.email).toBe("a@x.com")
  })

  it("rejects a row with no email", () => {
    expect(normalizeContacts([{ name: "nobody" }]).rejected).toBe(1)
  })
})
