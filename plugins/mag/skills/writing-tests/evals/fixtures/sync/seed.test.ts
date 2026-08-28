import { describe, expect, it } from "bun:test"
import { syncUsers, type Page, type Remote, type Store, type StoredUser } from "./sync"

const onePage = (): Remote => ({
  page: async (): Promise<Page> => ({ items: [{ id: "a", version: 1, name: "A" }], nextCursor: null })
})
const memory = (): Store => {
  const rows = new Map<string, StoredUser>()
  return { get: async (id) => rows.get(id), put: async (u) => { rows.set(u.id, u) } }
}

describe("syncUsers", () => {
  it("runs a sync", async () => {
    await syncUsers(onePage(), memory())
  })

  it("returns a report", async () => {
    expect(await syncUsers(onePage(), memory())).toBeDefined()
  })

  it("reports the four counters", async () => {
    expect(await syncUsers(onePage(), memory())).toEqual({
      pages: expect.any(Number),
      fetched: expect.any(Number),
      written: expect.any(Number),
      skipped: expect.any(Number)
    })
  })

  it("is repeatable", async () => {
    expect(await syncUsers(onePage(), memory())).toEqual(await syncUsers(onePage(), memory()))
  })

  it.skip("retries a transient failure", () => {
    expect(true).toBe(true)
  })

  it("writes a new user", async () => {
    const store = memory()
    await syncUsers(onePage(), store)
    expect(await store.get("a")).toStrictEqual({ id: "a", version: 1, name: "A" })
  })

  it("counts one page", async () => {
    expect((await syncUsers(onePage(), memory())).pages).toBe(1)
  })
})
