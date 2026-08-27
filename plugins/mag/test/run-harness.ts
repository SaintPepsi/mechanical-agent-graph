import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { TraceEventSchema } from "mag/runtime"
import type { TraceEvent } from "mag/runtime"

export interface RunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/**
 * Spawns `harnessPath` as a real `bun` child process and collects its stdout/stderr/exit code.
 * `env`, when given, is merged over `process.env` — the hook the trace-file tests use to point a
 * harness at `GRAPH_TRACE_FILE` without hand-rolling their own `Bun.spawn` call.
 */
export const runHarness = (harnessPath: string, env?: Record<string, string>) =>
  async (...argv: readonly string[]): Promise<RunResult> => {
    const proc = Bun.spawn(["bun", harnessPath, ...argv], {
      env: env === undefined ? process.env : { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe"
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ])
    return { stdout, stderr, exitCode }
  }

/** Reads `path` back as NDJSON, decoding every line through the published `TraceEventSchema`. */
export const readEvents = (path: string): ReadonlyArray<TraceEvent> =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => Schema.decodeUnknownSync(TraceEventSchema)(JSON.parse(line)))
