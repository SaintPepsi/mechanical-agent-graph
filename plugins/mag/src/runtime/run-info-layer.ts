import { join } from "node:path"
import { Effect } from "effect"
import { Shell } from "mag/runtime/shell"
import { RunId } from "mag/runtime/trace/layer"

/**
 * This checkout's own package root, resolved from this module's own location rather than
 * the process cwd — `skills/installed.ts`'s `SKILLS_ROOT` idiom, so `git rev-parse HEAD` run here
 * answers for whatever checkout contains it.
 */
export const PIPELINE_ROOT = join(import.meta.dirname, "..", "..")

/**
 * `git rev-parse HEAD` at `cwd`, degraded to `""` on any failure — a missing binary
 * (`CommandNotExecutable`) or a non-zero exit (no repo, no commits) read the same, because both
 * mean "no answer", not "stop the run". `Shell` is read from the `R` channel inside this Effect,
 * never threaded in as a parameter. Local to this module, not promoted to
 * `runtime/git.ts`: `git.ts`'s reads fail on non-zero exit by contract (`gitRead`/`gitReadRaw`), the
 * opposite of what this call site needs.
 */
const head = (cwd: string) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const result = yield* shell
      .run(["git", "rev-parse", "HEAD"], { cwd })
      .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })))
    return result.exitCode === 0 ? result.stdout.trim() : ""
  })

/**
 * Resolves the run's constants once — the same idiom `tracerLayer` uses to freeze its run
 * id (`trace/layer.ts`'s `tracerLayer`). The git sha costs one subprocess per run rather than one per row,
 * and a repo with no git, no commits, or no `git` on PATH yields `""` rather than ending the run:
 * the sha is a label on a record, and losing the label is worth less than losing the record.
 *
 * Two heads, not one. `sha` names the target checkout's HEAD (`options.repoRoot`);
 * `pipelineSha` names the executing plugin checkout's own HEAD (`PIPELINE_ROOT`) — the commit of
 * the pipeline that ran this run, so a journal row can say which version of it produced the row.
 *
 * Resolved in hand rather than deferred inside a `Layer` — `run-layers.ts`'s resume path
 * stamps its own `resume-run` record before the pipeline's layers are returned, since that record is
 * written outside `journaled`'s usual per-node path.
 *
 * Kept apart from `run-info.ts` because this file reaches `Shell` and `trace/layer.ts`, and
 * `journaled` — which every node's definition applies — reads only the reference.
 */
export const runInfoValues = (repoRoot: string) =>
  Effect.gen(function* () {
    const runId = yield* RunId
    const sha = yield* head(repoRoot)
    const pipelineSha = yield* head(PIPELINE_ROOT)
    return { runId, sha, pipelineSha }
  })
