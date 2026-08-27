/**
 * Process-level reaping for every live child, refcounted.
 *
 * An Effect finalizer covers fiber completion and interruption. It does not run when the parent is
 * `SIGKILL`ed or exits hard, which is what the `exit` / `SIGTERM` / `SIGINT` handlers are for: the
 * parent dying for any reason must take the child process groups with it.
 *
 * The handlers are registered once for the process rather than once per spawn. Per-spawn
 * registration puts three listeners on `process` per concurrent call — past Node's default warning
 * threshold at five concurrent calls — and lets a finishing call remove coverage a sibling still
 * needs. Here a single set attaches when the live-child set becomes non-empty and detaches when it
 * empties.
 */

/** Kills a child's whole process group. A group that has already gone is not an error. */
export const killGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
  } catch {
    // Already gone.
  }
}

const liveChildren = new Set<number>()

const reapAll = (): void => {
  for (const pid of liveChildren) killGroup(pid, "SIGKILL")
}

const onExit = (): void => reapAll()
const onSigterm = (): void => {
  reapAll()
  process.exit(143)
}
const onSigint = (): void => {
  reapAll()
  process.exit(130)
}

const attach = (): void => {
  process.on("exit", onExit)
  process.on("SIGTERM", onSigterm)
  process.on("SIGINT", onSigint)
}

const detach = (): void => {
  process.removeListener("exit", onExit)
  process.removeListener("SIGTERM", onSigterm)
  process.removeListener("SIGINT", onSigint)
}

/** Registers a live child. The process-level handlers attach on the first one. */
export const trackChild = (pid: number): void => {
  if (liveChildren.size === 0) attach()
  liveChildren.add(pid)
}

/** Deregisters a child and kills its group. The handlers detach once the last child is gone. */
export const releaseChild = (pid: number): void => {
  liveChildren.delete(pid)
  killGroup(pid, "SIGKILL")
  if (liveChildren.size === 0) detach()
}

/** How many children are currently tracked. Exists for tests to assert the refcount. */
export const liveChildCount = (): number => liveChildren.size
