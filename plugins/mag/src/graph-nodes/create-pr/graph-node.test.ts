import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { CreatePrFailed, UnsupportedHost } from "mag/graph-nodes/create-pr/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/create-pr/examples"
import { createPr } from "mag/graph-nodes/create-pr/graph-node"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { type ShellResult, type ShellService, shellLayer } from "mag/runtime/shell"

/** Like branch's `scriptedShell`: one canned reply per call, in order, recording every argv. */
const scriptedShell = (replies: readonly ShellResult[]) => {
  const calls: Array<string[]> = []
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const reply = replies[calls.length - 1]
      if (reply === undefined) throw new Error(`scriptedShell: unexpected call ${calls.length}: ${argv.join(" ")}`)
      return Effect.succeed(reply)
    }
  }
  return { calls, service }
}

const out = (stdout: string): ShellResult => ({ exitCode: 0, stdout, stderr: "" })
const exit = (exitCode: number, stderr = ""): ShellResult => ({ exitCode, stdout: "", stderr })

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, service: ShellService) =>
  Effect.runSync(Effect.result(effect.pipe(Effect.provide(shellLayer(service)))))

const GITHUB = {
  host: "github.com",
  slug: "owner/repo",
  base: "main",
  source: "feat/gh-110",
  title: "GH-110: push and PR nodes",
  bodyPath: "/repo/.claude/graph/run-1/pr-body-1.md"
}

describe("create-pr", () => {
  test("the fixtures decode against create-pr's own schemas", () => {
    if (!isSchemaHandle(createPr.input)) throw new Error("createPr.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(createPr.input)(example)
    if (!isSchemaHandle(createPr.success)) throw new Error("createPr.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(createPr.success)(example)
  })

  test("GitHub with no open request creates one, title verbatim and body by file, and returns its URL", () => {
    const { calls, service } = scriptedShell([out("[]\n"), out("https://github.com/owner/repo/pull/12\n")])
    const result = runWith(createPr.run(GITHUB), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ url: "https://github.com/owner/repo/pull/12" })
    expect(calls).toStrictEqual([
      ["gh", "pr", "list", "--repo", "owner/repo", "--head", "feat/gh-110", "--base", "main", "--state", "open", "--json", "url"],
      [
        "gh", "pr", "create", "--repo", "owner/repo", "--base", "main", "--head", "feat/gh-110",
        "--title", "GH-110: push and PR nodes", "--body-file", "/repo/.claude/graph/run-1/pr-body-1.md"
      ]
    ])
  })

  test("an already-open request's URL is returned and `gh pr create` never runs", () => {
    const { calls, service } = scriptedShell([out(`[{"url":"https://github.com/owner/repo/pull/9"}]\n`)])
    const result = runWith(createPr.run(GITHUB), service)

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({ url: "https://github.com/owner/repo/pull/9" })
    expect(calls).toHaveLength(1)
  })

  test("a GitLab host builds the MR-new URL without any CLI call, branches percent-encoded", () => {
    const { calls, service } = scriptedShell([])
    const result = runWith(
      createPr.run({ host: "gitlab.example.com", slug: "group/project", base: "main", source: "feat/gh-110", title: "t", bodyPath: "/run/pr-body-1.md" }),
      service
    )

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({
      url: "https://gitlab.example.com/group/project/-/merge_requests/new" +
        "?merge_request%5Bsource_branch%5D=feat%2Fgh-110&merge_request%5Btarget_branch%5D=main"
    })
    expect(calls).toHaveLength(0)
  })

  test("bitbucket.org builds the PR-new URL without any CLI call", () => {
    const { calls, service } = scriptedShell([])
    const result = runWith(
      createPr.run({ host: "bitbucket.org", slug: "workspace/repo", base: "main", source: "feat/gh-110", title: "t", bodyPath: "/run/pr-body-1.md" }),
      service
    )

    expect(Result.isSuccess(result)).toBe(true)
    if (!Result.isSuccess(result)) return
    expect(result.success).toStrictEqual({
      url: "https://bitbucket.org/workspace/repo/pull-requests/new?source=feat%2Fgh-110&dest=main"
    })
    expect(calls).toHaveLength(0)
  })

  test("an unrecognized host fails as UnsupportedHost citing the host, with no CLI call", () => {
    const { calls, service } = scriptedShell([])
    const result = runWith(
      createPr.run({ host: "git.sr.ht", slug: "~u/repo", base: "main", source: "feat/gh-110", title: "t", bodyPath: "/run/pr-body-1.md" }),
      service
    )

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(UnsupportedHost)
    expect((result.failure as UnsupportedHost).host).toBe("git.sr.ht")
    expect(calls).toHaveLength(0)
  })

  test("a failing `gh pr list` fails as CreatePrFailed carrying gh's message, and create never runs", () => {
    const { calls, service } = scriptedShell([exit(4, "gh: Not logged in\n")])
    const result = runWith(createPr.run(GITHUB), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(CreatePrFailed)
    const failure = result.failure as CreatePrFailed
    expect(failure.exitCode).toBe(4)
    expect(failure.stderr).toBe("gh: Not logged in")
    expect(calls).toHaveLength(1)
  })

  test("a failing `gh pr create` fails as CreatePrFailed carrying gh's message", () => {
    const { service } = scriptedShell([out("[]\n"), exit(1, "GraphQL: something broke\n")])
    const result = runWith(createPr.run(GITHUB), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(CreatePrFailed)
    expect((result.failure as CreatePrFailed).stderr).toBe("GraphQL: something broke")
  })

  test("unparseable `gh pr list` output fails as CreatePrFailed naming the parse, never as a crash", () => {
    const { service } = scriptedShell([out("not json")])
    const result = runWith(createPr.run(GITHUB), service)

    expect(Result.isFailure(result)).toBe(true)
    if (!Result.isFailure(result)) return
    expect(result.failure).toBeInstanceOf(CreatePrFailed)
    expect((result.failure as CreatePrFailed).stderr).toStartWith("unparseable gh pr list output")
  })
})
