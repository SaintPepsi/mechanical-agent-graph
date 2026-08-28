import { syncUsers, TransientError, type Page, type Remote, type Store, type StoredUser } from "./src/sync"
const memory = (seed: StoredUser[] = []): Store => {
  const rows = new Map(seed.map((r) => [r.id, r]))
  return { get: async (id) => rows.get(id), put: async (u) => { rows.set(u.id, u) } }
}
const scripted = (pages: Page[], failures: (Error | null)[] = []): Remote => {
  let i = 0
  return { page: async () => {
    const fail = failures[i]
    if (fail) { failures[i] = null; throw fail }
    return pages[Math.min(i++, pages.length - 1)]!
  } }
}
const P = (items: { id: string; version: number; name: string }[], nextCursor: string | null): Page => ({ items, nextCursor })
const out: unknown[] = []
const run = async (label: string, fn: () => Promise<unknown>) => {
  try { out.push([label, await fn()]) } catch (e) { out.push([label, "threw", (e as Error).name, (e as Error).message]) }
}
await run("single", () => syncUsers(scripted([P([{ id: "a", version: 1, name: "A" }], null)]), memory()))
await run("multi", async () => {
  const store = memory([{ id: "b", version: 5, name: "old" }])
  const r = await syncUsers(scripted([P([{ id: "a", version: 2, name: "A" }, { id: "b", version: 1, name: "B" }], "c1"), P([{ id: "c", version: 1, name: "C" }], null)]), store)
  return [r, await store.get("a"), await store.get("b"), await store.get("c")]
})
await run("equal-version", async () => {
  const store = memory([{ id: "a", version: 3, name: "keep" }])
  return [await syncUsers(scripted([P([{ id: "a", version: 3, name: "new" }], null)]), store), await store.get("a")]
})
await run("transient-once", () => syncUsers(scripted([P([{ id: "a", version: 1, name: "A" }], null)], [new TransientError("blip")]), memory()))
await run("transient-twice", () => syncUsers({ page: async () => { throw new TransientError("always") } }, memory()))
await run("fatal", () => syncUsers({ page: async () => { throw new TypeError("boom") } }, memory()))
await run("empty", () => syncUsers(scripted([P([], null)]), memory()))
await run("no-terminate", () => syncUsers(scripted([P([{ id: "a", version: 1, name: "A" }], "loop")]), memory()))
console.log(JSON.stringify(out))
