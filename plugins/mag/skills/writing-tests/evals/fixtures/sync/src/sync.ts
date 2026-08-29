export interface RemoteUser {
  readonly id: string
  readonly version: number
  readonly name: string
}

export interface Page {
  readonly items: readonly RemoteUser[]
  readonly nextCursor: string | null
}

export interface Remote {
  page(cursor: string | null): Promise<Page>
}

export interface StoredUser {
  readonly id: string
  readonly version: number
  readonly name: string
}

export interface Store {
  get(id: string): Promise<StoredUser | undefined>
  put(user: StoredUser): Promise<void>
}

/** A failure worth trying again. Anything else is not. */
export class TransientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TransientError"
  }
}

export interface SyncReport {
  readonly pages: number
  readonly fetched: number
  readonly written: number
  readonly skipped: number
}

const MAX_PAGES = 100

async function fetchPage(remote: Remote, cursor: string | null): Promise<Page> {
  try {
    return await remote.page(cursor)
  } catch (error) {
    if (!(error instanceof TransientError)) throw error
    return await remote.page(cursor)
  }
}

/** Pulls every page from `remote` into `store`. */
export async function syncUsers(remote: Remote, store: Store): Promise<SyncReport> {
  let cursor: string | null = null
  let pages = 0
  let fetched = 0
  let written = 0
  let skipped = 0

  while (true) {
    const page = await fetchPage(remote, cursor)
    pages += 1
    fetched += page.items.length

    for (const item of page.items) {
      const existing = await store.get(item.id)
      if (existing !== undefined && existing.version >= item.version) {
        skipped += 1
        continue
      }
      await store.put({ id: item.id, version: item.version, name: item.name })
      written += 1
    }

    if (page.nextCursor === null) break
    cursor = page.nextCursor
    if (pages >= MAX_PAGES) throw new Error("pagination did not terminate")
  }

  return { pages, fetched, written, skipped }
}
