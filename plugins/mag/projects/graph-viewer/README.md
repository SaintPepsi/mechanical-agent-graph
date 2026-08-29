# graph-viewer

A SvelteKit view of a graph run, run by Bun on loopback only. Spec: `docs/requirements/graph-visualiser.md` at the repository root.

## Routes

- `/` lists the graphs and runs.
- `/stats` reads every `journal.jsonl` under the graph root and reports the totals, the per-node,
  per-graph and per-run figures, and the failure tags. The root is `$MAG_GRAPH_ROOT`, else
  `~/.claude/graph`; the page names the one it read. Reading happens in the server load, and the
  viewer never writes.

## Commands

From the repository root, `bun run typecheck` runs this project's `svelte-check` and `bun run test` runs its vitest unit tests and Playwright smoke test alongside the rest of the suite. In this directory:

- `bun run dev` serves on `http://127.0.0.1:5173`
- `bun run check` runs `svelte-check`
- `bun run test:unit` runs vitest
- `bun run test:e2e` runs Playwright against `vite dev` on a free loopback port picked per process, so concurrent worktrees never collide
- `bun run revendor-tokens <source-tokens-file-path>` overwrites `tokens.css` from the tokens file at that path

Playwright needs its browser once per machine: `bunx playwright install chromium` (add `--with-deps` on a machine missing system libraries).

## Styling

`src/lib/styles/tokens.css` holds the vendored "Arcade Terminal" design tokens (`--mk-*` custom properties). Components use `--mk-*` tokens only; `src/lib/styles/tokens.test.ts` fails on any hex colour or font family literal outside the vendored file. No companion `fonts.css` is vendored: it would import `@fontsource` packages, so the display and mono families fall back to the system stacks the tokens declare.
