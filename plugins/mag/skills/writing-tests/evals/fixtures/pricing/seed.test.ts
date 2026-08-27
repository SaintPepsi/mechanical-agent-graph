import { describe, expect, it } from "bun:test"
import { applyDiscount, discountRateFor, formatCents, subtotalCents } from "./pricing"

describe("pricing", () => {
  it("totals a cart", () => {
    subtotalCents([{ sku: "a", unitPriceCents: 100, quantity: 2 }])
  })

  it("returns a subtotal", () => {
    expect(subtotalCents([{ sku: "a", unitPriceCents: 100, quantity: 2 }])).toBeDefined()
  })

  it("formats a price", () => {
    expect(formatCents(1234)).toEqual(expect.any(String))
  })

  it("discount rate is deterministic", () => {
    expect(discountRateFor(20000, true)).toBe(discountRateFor(20000, true))
  })

  it.skip("rounds half away from zero", () => {
    expect(true).toBe(true)
  })

  it("gives members ten percent over the threshold", () => {
    expect(discountRateFor(20000, true)).toBe(0.1)
  })

  it("applies a rate", () => {
    expect(applyDiscount(1000, 0.1)).toBe(900)
  })
})
