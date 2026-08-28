import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { AcceptanceCriteriaMissing } from "mag/graph-nodes/require-acs/errors"
import { developGraph, resolvePolicy } from "mag/graphs/develop-graph/graph"
import { type ClaudeAgentService, claudeAgentLayer, type ClaudePrint, type ClaudeReply } from "mag/runtime/claude/service"
import { Graph } from "mag/runtime/construct"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { GraphShapeSchema } from "mag/runtime/graph-shape"
import { RunRootEnv } from "mag/runtime/run-layers"
import { journalPathFor } from "mag/runtime/run-root"
import { type ShellService, shellLayer } from "mag/runtime/shell"
import { RunId } from "mag/runtime/trace/layer"
import { removeDir } from "mag/test/node-fixture"

const RUN_ID = "20260823140000-2b9a"
const TICKET = "GH-150"
const TICKET_TITLE = "Reticulate the splines"
const BASE = "main"
const BRANCH = "feat/GH-150-reticulate-the-splines"
const TICKET_BODY = "## Summary\n\nSplines need reticulating.\n\n## Acceptance Criteria\n\n**AC.01 - The splines are reticulated**"
const DIFF = "diff --git a/x.ts b/x.ts\n-old\n+new\n"
const PR_URL = "https://github.com/SaintPepsi/mechanical-agent-graph/pull/41"

const ok = (stdout: string) => Effect.succeed({ exitCode: 0, stdout, stderr: "" })

/**
 * One stub for every subprocess the run makes, routed by argv shape. Only the fields a test actually
 * varies are options; the rest are this repository's own declared policy value, so a test overriding
 * one proves the override reached the node without having to restate the others. Only a call whose
 * answer the node actually reads gets a route of its own: the two trailing generic routes already
 * report an unmatched `git diff` dirty, so design-graph's scoped `commitPath` calls proceed, and
 * answer every other `git` call with a clean success.
 */
const runShell = (options: {
  readonly repoRoot: string
  readonly remote?: string
  readonly maintainer?: string
  readonly slug?: string
}) => {
  const { repoRoot, remote = "origin", maintainer = "SaintPepsi", slug = "SaintPepsi/mechanical-agent-graph" } = options
  const calls: string[][] = []
  const service: ShellService = {
    run: (argv) => {
      calls.push([...argv])
      const line = argv.join(" ")
      if (line === "git rev-parse --show-toplevel") return ok(`${repoRoot}\n`)
      if (line === "git rev-parse HEAD") return ok("aaa111\n")
      if (line === `git rev-parse --verify -q refs/heads/${BASE}`) return ok("aaa111\n")
      if (line === `git ls-remote --exit-code --heads ${remote} refs/heads/${BASE}`) return ok(`aaa111\trefs/heads/${BASE}\n`)
      if (line.startsWith("git rev-parse --verify")) return Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })
      if (line === "sh -c bun install --frozen-lockfile") return ok("")
      if (line === "gh issue view 150 --json title,body,author,comments") {
        return ok(JSON.stringify({ title: TICKET_TITLE, body: TICKET_BODY, author: { login: maintainer }, comments: [] }))
      }
      if (line === "sh -c bun run typecheck && bun run test") return ok("42 pass\n")
      if (line === `git diff ${BASE}...HEAD`) return ok(DIFF)
      if (line === `git diff ${BASE}...HEAD -- :(exclude)docs/graph/**`) return ok(DIFF)
      if (line === `git diff --name-only ${BASE}...HEAD`) return ok(`docs/graph/${TICKET}/design.md\n`)
      // review-diff reads this one for real (`gitReadRaw` fails on non-zero), so it cannot fall to
      // the dirty-reporting generic diff route below.
      if (line === `git diff --no-renames --name-only -z ${BASE}...HEAD`) return ok("")
      if (line.startsWith("git rev-list --count ")) return ok("1\n")
      if (line.startsWith(`gh pr list --repo ${slug}`)) return ok("[]\n")
      if (line.startsWith(`gh pr create --repo ${slug}`)) return ok(`${PR_URL}\n`)
      if (argv[0] === "git" && argv[1] === "diff") return Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })
      if (argv[0] === "git") return ok("")
      throw new Error(`runShell: unexpected argv: ${line}`)
    }
  }
  return { calls, service }
}

/** Extracts the backticked destination `envision-notation`/`discover` splice into their own prompt (`graphs/design-graph/graph.test.ts`'s own convention). */
const destinationOf = (prompt: string, marker: string): string => {
  const match = prompt.match(new RegExp(`${marker} \`([^\`]+)\``))
  if (match === null || match[1] === undefined) throw new Error(`no destination for "${marker}" in prompt`)
  return match[1]
}

/** Every route answers the same reply shape; only the verdict, the session id and the price differ. */
const reply = <A>(verdict: unknown, session: string, costUsd: number) =>
  Effect.succeed({ verdict: verdict as A, result: {}, sessions: [session], costUsd, attempts: 1 } as ClaudeReply<A>)

/** The dispatch spine every writing node shares: the artifact exists at the path the node itself computed. */
const writeAt = (destination: string, text: string): string => {
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, text)
  return destination
}

/**
 * One stub for every agent dispatch, routed by the marker text unique to each dispatching node's own
 * prompt — design-graph's three (`envision-notation`, `discover`, `brainstorm`) replace develop-graph's
 * single `design` route entirely: this graph never dispatches `design`, only the subgraph that
 * replaces it.
 */
const runAgent = (root: string) => {
  const requests: Array<ClaudePrint<unknown>> = []
  const service: ClaudeAgentService = {
    prompt: <A>(request: ClaudePrint<A>) => {
      requests.push(request as ClaudePrint<unknown>)
      const prompt = request.prompt

      if (prompt.includes("Draw the ideal shape")) {
        const path = writeAt(destinationOf(prompt, "Write the vision to"), "graph TD\n  A --> B\n")
        return reply<A>({ visionPath: path }, "session-envision", 0.1)
      }
      if (prompt.includes("Recon this repository")) {
        const path = writeAt(destinationOf(prompt, "Write your findings to"), "# Discover\n\nNothing relevant found.\n")
        return reply<A>({ discoverPath: path }, "session-discover", 0.15)
      }
      if (prompt.includes("Read each vision below")) {
        // brainstorm's write step backtick-quotes the path it resolved through `recordPath`,
        // so the stub reads it back the way `design-graph/graph.test.ts` does rather than composing
        // its own from `root` and silently agreeing with a placement the node no longer makes.
        const path = writeAt(destinationOf(prompt, "Write the design doc to"), "# Design\n\n## Vision Reconciliation\n\nNo collisions.\n")
        return reply<A>({ designPath: path }, "session-brainstorm", 0.2)
      }
      if (prompt.includes("terse one-liner")) return reply<A>({ rewritten: 0, note: "already terse" }, "session-terseness", 0.02)
      // No blocking findings, so the review loop settles on its first pass: `build-under-review`'s
      // own test owns the send-back path, this one owns the spine.
      if (prompt.includes("reply with only the blocking findings")) return reply<A>({ blocking: [] }, "session-review-1", 0.1)
      if (prompt.includes("Reduce this diff to the same behaviour in less code")) return reply<A>({ note: "nothing to trim" }, "session-simplify", 0.05)
      if (prompt.includes("Write the pull request description for the diff at")) {
        return reply<A>({ description: "Reticulates the splines." }, "session-write-pr-body", 0.05)
      }
      return reply<A>({ summary: "built from the design" }, "session-build-1", 0.5)
    }
  }
  return { requests, service }
}

describe("develop-graph", () => {
  test("wears the GraphNode shape, so the registry can run it with no graph runner", () => {
    expect(isSchemaHandle(developGraph.input)).toBe(true)
    expect(isSchemaHandle(developGraph.success)).toBe(true)
    expect(developGraph.name).toBe("develop-graph")
  })

  describe("resolvePolicy", () => {
    test("every field absent resolves to this repository's own eleven declared defaults", () => {
      expect(resolvePolicy({ ticket: TICKET })).toStrictEqual({
        base: "main",
        worktree: true,
        resume: false,
        verification: "bun run typecheck && bun run test",
        worktreeSetup: "bun install --frozen-lockfile",
        remote: "origin",
        host: "github.com",
        slug: "SaintPepsi/mechanical-agent-graph",
        maintainer: "SaintPepsi",
        agent: "effect-expert",
        records: "run-root"
      })
    })

    test("each field overrides independently, the other ten staying this repository's own default", () => {
      expect(resolvePolicy({ ticket: TICKET, remote: "upstream" }).remote).toBe("upstream")
      expect(resolvePolicy({ ticket: TICKET, remote: "upstream" }).host).toBe("github.com")
      expect(resolvePolicy({ ticket: TICKET, maintainer: "OtherMaintainer" }).maintainer).toBe("OtherMaintainer")
      expect(resolvePolicy({ ticket: TICKET, slug: "consumer/repo" }).slug).toBe("consumer/repo")
      expect(resolvePolicy({ ticket: TICKET, agent: "consumer-agent" }).agent).toBe("consumer-agent")
      expect(resolvePolicy({ ticket: TICKET, base: "develop" }).base).toBe("develop")
    })

    // node-command.ts's wrapOptionalByKind exists so an explicit `false` decodes distinct from
    // absence; resolvePolicy has to preserve that distinction, not collapse both onto `?? true`.
    test("worktree: false decodes distinct from absence", () => {
      expect(resolvePolicy({ ticket: TICKET }).worktree).toBe(true)
      expect(resolvePolicy({ ticket: TICKET, worktree: false }).worktree).toBe(false)
    })

    // resume defaults false rather than true — the opposite direction from worktree, since
    // "absent" has always meant a first run, and a launch input has to opt in to skip that.
    test("resume: true decodes distinct from absence", () => {
      expect(resolvePolicy({ ticket: TICKET }).resume).toBe(false)
      expect(resolvePolicy({ ticket: TICKET, resume: true }).resume).toBe(true)
    })

    // `scope()` (`.finalise`'s own field, inline) reads `resolvePolicy(input).records` straight
    // through into `RunScope.records` — this is the one function that feeds it, so proving it here
    // proves the plumbing all the way to `run-layers.ts` without a shell.
    test("records: \"committed\" decodes distinct from the run-root default", () => {
      expect(resolvePolicy({ ticket: TICKET }).records).toBe("run-root")
      expect(resolvePolicy({ ticket: TICKET, records: "committed" }).records).toBe("committed")
    })
  })

  test("the design slot dispatches design-graph, not design — one journal, the subgraph's own nodes present as rows, the PR opens", async () => {
    const temp = mkdtempSync(join(tmpdir(), "develop-graph-"))
    try {
      const repoRoot = join(temp, "repo")
      mkdirSync(repoRoot, { recursive: true })
      const workRoot = `${repoRoot}-worktrees/${TICKET}-${RUN_ID}`
      // Stands in for `git worktree add`'s real effect: the shell call is mocked, so the tree it
      // would have materialized is made here instead, for design-graph's own manifest probes to read.
      mkdirSync(workRoot, { recursive: true })

      const { calls, service } = runShell({ repoRoot })
      const agent = runAgent(workRoot)

      const result = await Effect.runPromise(
        Effect.result(
          developGraph.run({ ticket: TICKET }).pipe(
            Effect.provide(Layer.mergeAll(shellLayer(service), claudeAgentLayer(agent.service))),
            Effect.provideService(RunId, RUN_ID),
            Effect.provideService(RunRootEnv, { env: { CLAUDE_CONFIG_DIR: temp }, home: "/unused" })
          )
        )
      )

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success.ticket).toBe(TICKET)
      expect(result.success.branch).toBe(BRANCH)
      expect(result.success.prUrl).toBe(PR_URL)
      expect(result.success.costUsd).not.toBeNull()
      expect(result.success.sessions).toContain("session-brainstorm")

      const where = { env: { CLAUDE_CONFIG_DIR: temp }, home: "/unused", repoPath: repoRoot, ticket: TICKET, runId: RUN_ID }
      const rows = readFileSync(journalPathFor(where), "utf8")
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row) as Record<string, unknown>)

      const names = rows.map((row) => row["node"])
      // design-graph fills this slot; a bare `design` node never runs here — never both, never neither.
      expect(names).toContain("design-graph")
      expect(names).not.toContain("design")
      // The subgraph's own nodes appear as rows too — it ran underneath, not as an opaque stub.
      // The rail-sketch's own compositions journal as graphs of their own, borrowed by the host,
      // and the publish tail runs as the sketch's boxes — never the fused `publish` composite.
      for (const name of [
        "prepare", "require-acs", "checkout", "write-body", "publish-tail",
        "resolve-notations", "envision-visions", "discover", "brainstorm", "build-under-review", "push-branch", "create-pr"
      ]) {
        expect(names).toContain(name)
      }
      expect(names).not.toContain("publish")
      // Composition mints no second scope: every row shares the host's run id and is stamped with its name.
      for (const row of rows) {
        expect(row["runId"]).toBe(RUN_ID)
        expect(row["graph"]).toBe("develop-graph")
      }

      // Worktree bracketing: default worktree (absent input, policy default true) adds and removes.
      expect(calls.some((call) => call.join(" ") === `git worktree add --detach ${workRoot} main`)).toBe(true)
      expect(calls.some((call) => call.join(" ") === `git worktree remove ${workRoot}`)).toBe(true)

      // The default `records: "run-root"` policy (absent input) never stages the design doc —
      // `record`'s commit half (`records.ts`) is gated on `RunInfo.records`, and this run never asked
      // for `"committed"`.
      const designPath = `${workRoot}/docs/graph/${TICKET}/design.md`
      expect(calls).not.toContainEqual(["git", "add", "--", designPath])
    } finally {
      await removeDir(temp)
    }
  })

  test("records: \"committed\" as a develop-graph input reaches RunInfo.records in the record-writing nodes — brainstorm's design commit fires", async () => {
    const temp = mkdtempSync(join(tmpdir(), "develop-graph-records-"))
    try {
      const repoRoot = join(temp, "repo")
      mkdirSync(repoRoot, { recursive: true })
      const workRoot = `${repoRoot}-worktrees/${TICKET}-${RUN_ID}`
      mkdirSync(workRoot, { recursive: true })

      const { calls, service } = runShell({ repoRoot })
      const agent = runAgent(workRoot)

      const result = await Effect.runPromise(
        Effect.result(
          developGraph.run({ ticket: TICKET, records: "committed" }).pipe(
            Effect.provide(Layer.mergeAll(shellLayer(service), claudeAgentLayer(agent.service))),
            Effect.provideService(RunId, RUN_ID),
            Effect.provideService(RunRootEnv, { env: { CLAUDE_CONFIG_DIR: temp }, home: "/unused" })
          )
        )
      )

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return

      // `RunScope.records` (`develop-graph`'s own `scope()`) reached `RunInfo.records` in the node
      // that writes the design doc: `record`'s commit half fires, pathspec-scoped to that one path.
      const designPath = `${workRoot}/docs/graph/${TICKET}/design.md`
      expect(calls).toContainEqual(["git", "add", "--", designPath])
      expect(calls.some((call) => call[0] === "git" && call[1] === "commit" && call.at(-1) === designPath)).toBe(true)
    } finally {
      await removeDir(temp)
    }
  })

  test("disconfirming: a ticket with no acceptance criteria refuses the run before any worktree, branch or model session", async () => {
    const temp = mkdtempSync(join(tmpdir(), "develop-graph-no-acs-"))
    try {
      const repoRoot = join(temp, "repo")
      mkdirSync(repoRoot, { recursive: true })
      const calls: string[][] = []
      const service: ShellService = {
        run: (argv) => {
          calls.push([...argv])
          const line = argv.join(" ")
          if (line === "git rev-parse --show-toplevel") return ok(`${repoRoot}\n`)
          if (line === "git rev-parse HEAD") return ok("aaa111\n")
          // run-layers's identity check — one answer for both sides keeps this a home run.
          if (line === "git rev-parse --path-format=absolute --git-common-dir") return ok(`${repoRoot}/.git\n`)
          if (line === `git rev-parse --verify -q refs/heads/${BASE}`) return ok("aaa111\n")
          if (line === `git ls-remote --exit-code --heads origin refs/heads/${BASE}`) return ok(`aaa111\trefs/heads/${BASE}\n`)
          // No Acceptance Criteria section at all — the AC-less fixture this test exists to prove.
          if (line === "gh issue view 150 --json title,body,author,comments") {
            return ok(JSON.stringify({
              title: TICKET_TITLE,
              body: "## Summary\n\nNo criteria drafted yet.",
              author: { login: "SaintPepsi" },
              comments: []
            }))
          }
          throw new Error(`runShell: unexpected argv: ${line}`)
        }
      }
      const agent = runAgent(repoRoot)

      const result = await Effect.runPromise(
        Effect.result(
          developGraph.run({ ticket: TICKET }).pipe(
            Effect.provide(Layer.mergeAll(shellLayer(service), claudeAgentLayer(agent.service))),
            Effect.provideService(RunId, RUN_ID),
            Effect.provideService(RunRootEnv, { env: { CLAUDE_CONFIG_DIR: temp }, home: "/unused" })
          )
        )
      )

      expect(Result.isFailure(result)).toBe(true)
      if (!Result.isFailure(result)) return
      // The ticket file opens with the title as its own heading, so the inventory names it first.
      expect(result.failure).toStrictEqual(
        new AcceptanceCriteriaMissing({ ticket: TICKET, title: TICKET_TITLE, headings: `${TICKET_TITLE}, Summary` })
      )

      // Refused before spend: no worktree, no branch, no dispatch — the gate is `prepare`'s door.
      expect(agent.requests).toHaveLength(0)
      expect(calls.some((call) => call[1] === "worktree")).toBe(false)
      expect(calls.some((call) => call.join(" ").startsWith("git checkout"))).toBe(false)
    } finally {
      await removeDir(temp)
    }
  })

  test("every per-repo override reaches the node that reads it — resolve-base's remote, fetch-ticket's maintainer, publish-tail's remote/slug, and every dispatch's agent", async () => {
    const temp = mkdtempSync(join(tmpdir(), "develop-graph-policy-"))
    try {
      const repoRoot = join(temp, "repo")
      mkdirSync(repoRoot, { recursive: true })
      const OTHER_MAINTAINER = "OtherMaintainer"
      const OTHER_SLUG = "consumer/repo"
      const OTHER_REMOTE = "upstream"
      const OTHER_AGENT = "consumer-agent"

      // worktree: false — this test is about policy plumbing, not the tree bracket already proved above.
      const { calls, service } = runShell({ repoRoot, remote: OTHER_REMOTE, maintainer: OTHER_MAINTAINER, slug: OTHER_SLUG })
      const agent = runAgent(repoRoot)

      const result = await Effect.runPromise(
        Effect.result(
          developGraph.run({
            ticket: TICKET,
            worktree: false,
            remote: OTHER_REMOTE,
            maintainer: OTHER_MAINTAINER,
            slug: OTHER_SLUG,
            agent: OTHER_AGENT
          }).pipe(
            Effect.provide(Layer.mergeAll(shellLayer(service), claudeAgentLayer(agent.service))),
            Effect.provideService(RunId, RUN_ID),
            Effect.provideService(RunRootEnv, { env: { CLAUDE_CONFIG_DIR: temp }, home: "/unused" })
          )
        )
      )

      expect(Result.isSuccess(result)).toBe(true)
      const lines = calls.map((call) => call.join(" "))

      // resolve-base and fetch-ticket read the override, not this repository's own default.
      expect(lines).toContain(`git ls-remote --exit-code --heads ${OTHER_REMOTE} refs/heads/main`)
      expect(lines.some((line) => line.includes("refs/heads/main") && line.includes("origin"))).toBe(false)

      // publish's push and create-pr both read the override slug/remote, never this repository's own.
      expect(lines).toContain(`git push -u ${OTHER_REMOTE} ${BRANCH}`)
      expect(lines.some((line) => line.startsWith(`gh pr create --repo ${OTHER_SLUG}`))).toBe(true)
      expect(lines.some((line) => line.includes("SaintPepsi/mechanical-agent-graph"))).toBe(false)

      // Never a real worktree call: worktree: false skips both bracket nodes entirely.
      expect(calls.some((call) => call[0] === "git" && call[1] === "worktree")).toBe(false)

      // Every dispatch that carries an agent at all carries the override, not this repository's own effect-expert.
      const withAgent = agent.requests.filter((request) => request.agent !== undefined)
      expect(withAgent.length).toBeGreaterThan(0)
      for (const request of withAgent) expect(request.agent).toBe(OTHER_AGENT)
      // write-pr-body's own ruling survives the override too: it still carries no agent at all.
      const writeBodyRequest = agent.requests.find((request) => request.prompt.includes("Write the pull request description for the diff at"))
      expect(writeBodyRequest?.agent).toBeUndefined()
    } finally {
      await removeDir(temp)
    }
  })

  describe("Graph.shapeOf(developGraph)", () => {
    const shape = Graph.shapeOf(developGraph)

    test("shapeOf resolves the real graph — no `.finalise` is skipped, no node runs to get here", () => {
      expect(shape).toBeDefined()
    })

    if (shape === undefined) return

    const byId = new Map(shape.elements.map((element) => [element.id, element]))

    test("every borrowed construct's own stages appear, and a borrowed non-construct is a plain node", () => {
      // The four borrowed constructs, each a group with its own id derived from the root.
      const prepareId = "develop-graph/0:group:prepare"
      const checkoutId = "develop-graph/1:group:checkout"
      const publishTailId = "develop-graph/6:group:publish-tail"
      const writeBodyId = `${publishTailId}/0:left:write-body`
      for (const [id, label] of [
        [prepareId, "prepare"],
        [checkoutId, "checkout"],
        [publishTailId, "publish-tail"],
        [writeBodyId, "write-body"]
      ] as const) {
        expect(byId.get(id)).toEqual({ kind: "group", id, label, parent: expect.any(String) })
      }

      // design-graph and build-under-review borrow no blueprint (built with `graph()`/`make()`
      // directly, not `Graph.construct`) — plain node elements, not groups.
      expect(byId.get("develop-graph/2:node:design-graph")).toEqual({
        kind: "node",
        id: "develop-graph/2:node:design-graph",
        label: "design-graph",
        parent: "develop-graph"
      })
      expect(byId.get("develop-graph/3:node:build-under-review")).toEqual({
        kind: "node",
        id: "develop-graph/3:node:build-under-review",
        label: "build-under-review",
        parent: "develop-graph"
      })

      // Every node prepare/checkout/publish-tail themselves borrow shows up under their own group.
      expect(byId.get(`${prepareId}/1:node:require-acs`)).toBeDefined()
      expect(byId.get(`${prepareId}/2:node:format-branch-name`)).toBeDefined()
      expect(byId.get(`${checkoutId}/1:node:branch`)).toBeDefined()
      expect(byId.get(`${publishTailId}/1:node:create-pr`)).toBeDefined()
    })

    test("prepare's .fork is one fork element with two branch edges; checkout's .when is one decision with a branch edge to worktree-add", () => {
      const forkId = "develop-graph/0:group:prepare/0:fork"
      const leftId = "develop-graph/0:group:prepare/0:left:resolve-base"
      const rightId = "develop-graph/0:group:prepare/0:right:fetch-ticket"
      expect(byId.get(forkId)).toEqual({ kind: "fork", id: forkId, label: "fork", parent: "develop-graph/0:group:prepare" })
      const branchEdgesFromFork = shape.edges.filter((edge) => edge.kind === "branch" && edge.from === forkId)
      expect(branchEdgesFromFork).toHaveLength(2)
      expect(branchEdgesFromFork).toContainEqual({ kind: "branch", from: forkId, to: leftId, label: "left" })
      expect(branchEdgesFromFork).toContainEqual({ kind: "branch", from: forkId, to: rightId, label: "right" })

      const decisionId = "develop-graph/1:group:checkout/0:decision:worktree-add"
      const guardedId = "develop-graph/1:group:checkout/0:node:worktree-add"
      expect(byId.get(decisionId)).toEqual({
        kind: "decision",
        id: decisionId,
        label: "worktree-add",
        parent: "develop-graph/1:group:checkout"
      })
      expect(shape.edges).toContainEqual({ kind: "branch", from: decisionId, to: guardedId, label: "true" })
    })

    test("write-body's group is parented to publish-tail's group id, three levels deep from the root", () => {
      const publishTailId = "develop-graph/6:group:publish-tail"
      const writeBodyId = `${publishTailId}/0:left:write-body`
      const writeBody = byId.get(writeBodyId)
      expect(writeBody?.parent).toBe(publishTailId)

      const publishTail = byId.get(publishTailId)
      expect(publishTail?.parent).toBe("develop-graph")

      const root = byId.get("develop-graph")
      expect(root?.parent).toBeNull()
    })

    test("the shape round-trips through JSON and its own schema to an equal value, carrying schema \"mag/shape@1\" and no positions", () => {
      expect(shape.schema).toBe("mag/shape@1")

      const roundTripped = Schema.decodeUnknownSync(GraphShapeSchema)(JSON.parse(JSON.stringify(shape)))
      expect(roundTripped).toEqual(shape)
    })
  })
})
