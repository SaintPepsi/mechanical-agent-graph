import { Effect, Schema } from "effect"
import { CreatePrFailed, UnsupportedHost } from "mag/graph-nodes/create-pr/errors"
import { make } from "mag/runtime/graph-node.definition"
import { Shell } from "mag/runtime/shell"

/** `gh pr list --json url` output: an array of open requests, possibly empty. */
const OpenPrs = Schema.fromJsonString(Schema.Array(Schema.Struct({ url: Schema.String })))

/** GitLab dispatch covers both "gitlab.com" and self-hosted instances; mechanically, a hostname carrying "gitlab" is the parse that covers both. */
const isGitLabHost = (host: string): boolean => host.includes("gitlab")

interface RequestTarget {
  readonly host: string
  readonly slug: string
  readonly base: string
  readonly source: string
}

/** GitLab's MR-new URL, branch names percent-encoded (the bracketed param names arrive pre-encoded). */
const gitlabMergeRequestUrl = (target: RequestTarget): string =>
  `https://${target.host}/${target.slug}/-/merge_requests/new` +
  `?merge_request%5Bsource_branch%5D=${encodeURIComponent(target.source)}` +
  `&merge_request%5Btarget_branch%5D=${encodeURIComponent(target.base)}`

/** Bitbucket's PR-new URL. */
const bitbucketPullRequestUrl = (target: RequestTarget): string =>
  `https://${target.host}/${target.slug}/pull-requests/new` +
  `?source=${encodeURIComponent(target.source)}&dest=${encodeURIComponent(target.base)}`

/**
 * Open the pull/merge request for an already-pushed branch on an already-detected host, and
 * return its URL. The host and slug arrive as input — host detection is a launch input today, not
 * this node's job — and so does the title (`gh pr create` refuses to run non-interactively without one,
 * which is why `title` is input rather than generated here).
 *
 * A PR body that names the ticket it closes matters: without it, every graph-opened PR leaves its
 * ticket open on merge. This repo's graphs have no changelog step to source PR body text from, so
 * `body` is caller-supplied, formatted by nothing in this node — the same discipline `title`
 * already follows — and reaches `gh pr create --body` verbatim; deciding what it says is
 * `runtime/pr-body.ts` and the graph's business, not this node's.
 *
 * GitHub is the CLI arm: it asks `gh` for an open request from source to base first and returns
 * that URL rather than opening a duplicate, with `--repo` pinning the target so the whole call is
 * determined by this input alone. GitLab and Bitbucket have no assumed CLI; the proven shape
 * there is the prefilled create-request URL, which submits nothing itself — the host deduplicates
 * on submission, so no duplicate can originate here either. Both arms ignore `body` today
 * (GitLab/Bitbucket accept a description param each, but no graph in this repo targets those
 * hosts). Every other host, CodeCommit included, fails named; an arm no graph hands a host into would be
 * dead code.
 */
export const createPr = make({
  name: "create-pr",
  description: "Open the pull/merge request for a pushed branch on a detected host, returning its URL.",
  input: Schema.Struct({
    host: Schema.String,
    slug: Schema.String,
    base: Schema.String,
    source: Schema.String,
    title: Schema.String,
    body: Schema.String
  }),
  success: Schema.Struct({ url: Schema.String }),
  run: (input) =>
    Effect.gen(function* () {
      if (input.host === "github.com") {
        const shell = yield* Shell

        const listed = yield* shell.run([
          "gh", "pr", "list",
          "--repo", input.slug,
          "--head", input.source,
          "--base", input.base,
          "--state", "open",
          "--json", "url"
        ])
        if (listed.exitCode !== 0) {
          return yield* Effect.fail(
            new CreatePrFailed({ host: input.host, exitCode: listed.exitCode, stderr: listed.stderr.trim() })
          )
        }

        const open = yield* Schema.decodeUnknownEffect(OpenPrs)(listed.stdout).pipe(
          Effect.mapError((error) =>
            new CreatePrFailed({ host: input.host, exitCode: 0, stderr: `unparseable gh pr list output: ${error.message}` })
          )
        )
        const existing = open[0]
        if (existing !== undefined) return { url: existing.url }

        const created = yield* shell.run([
          "gh", "pr", "create",
          "--repo", input.slug,
          "--base", input.base,
          "--head", input.source,
          "--title", input.title,
          "--body", input.body
        ])
        if (created.exitCode !== 0) {
          return yield* Effect.fail(
            new CreatePrFailed({ host: input.host, exitCode: created.exitCode, stderr: created.stderr.trim() })
          )
        }
        return { url: created.stdout.trim() }
      }

      if (isGitLabHost(input.host)) return { url: gitlabMergeRequestUrl(input) }
      if (input.host === "bitbucket.org") return { url: bitbucketPullRequestUrl(input) }

      return yield* Effect.fail(new UnsupportedHost({ host: input.host }))
    })
})
