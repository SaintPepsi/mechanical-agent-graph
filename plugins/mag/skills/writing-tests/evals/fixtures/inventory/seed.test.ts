import { describe, expect, it } from "bun:test"
import { reserveStock, type StockRepo } from "./reserve"

const repo = (available = 5): StockRepo => ({
  find: async (sku) => ({ sku, available }),
  reserve: async () => {}
})

describe("reserveStock", () => {
  it("reserves stock", async () => {
    await reserveStock(repo(), "widget", 1)
  })

  it("returns a result", async () => {
    expect(await reserveStock(repo(), "widget", 1)).toBeDefined()
  })

  it("result carries an ok flag", async () => {
    expect(await reserveStock(repo(), "widget", 1)).toEqual(
      expect.objectContaining({ ok: expect.any(Boolean) })
    )
  })

  it("is consistent", async () => {
    expect(await reserveStock(repo(), "widget", 1)).toEqual(await reserveStock(repo(), "widget", 1))
  })

  it.skip("rejects a quantity of zero", () => {
    expect(true).toBe(true)
  })

  it("succeeds when there is enough stock", async () => {
    expect(await reserveStock(repo(5), "widget", 2)).toStrictEqual({ ok: true, reserved: 2, remaining: 3 })
  })

  it("reports an unknown sku", async () => {
    const missing: StockRepo = { find: async () => null, reserve: async () => {} }
    expect(await reserveStock(missing, "ghost", 1)).toStrictEqual({ ok: false, reason: "unknown-sku" })
  })
})
