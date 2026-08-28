# writing-tests eval kit

The harness that calibrated `../SKILL.md`. Keep it next to the skill so the skill can be
re-scored after a model change instead of trusted on memory.

## Layout

- `fixtures/<name>/` — six small TypeScript projects an agent is asked to test. Each has `src/`,
  a `mutants.json` (deliberate bugs as find/replace edits on the source; 72 in total), and for
  the repair scenarios a `seed.test.ts` (a suite of tests that cannot fail, copied in as the
  starting point). `limiter`, `normalize` and `sync` also carry `probe.ts` plus `refactors.json`
  (behaviour-preserving rewrites, used to measure false reds). `legacy-coverage/src/duration.test.ts`
  is the seed for the coverage-chase scenario. `dead-tests.json` lists, per fixture, the seeded
  test names that a repair run is expected to delete.
- `variants/{terse,v3,verbose}/` — the three skill variants that were raced. `v3` is the
  "anchored" variant; `verbose` is byte-identical to the shipped `../SKILL.md`.
- `scripts/` — the scorers (python, see below).
- `timing/` — tokens, wall time and tool-use counts per scenario, with and without the skill.
- `results/` — iteration 7's final outputs: `it7-manifest.json` (case to arm and source-run
  map), `it7-pairwise.json` (blind A/B pairs), `severity-final.json` (median of three judges),
  `it7-sev-map-judge-{a,b,c}.json` (judge case blinding), `escapes-verified.json` (every
  adversary escape claim, mechanically verified: 12/12 valid).

Run transcripts (iteration 1 to 6, and iteration 7's `break/`, `judge/`, `severity/` dirs) are
not committed; `results/*.json` `source` fields name them relative to the original workspace.

## Running a scorer

All scripts resolve paths relative to this directory, need `bun` and `node` on PATH, and read
the smell checker from `../scripts/test-smells.mjs`.

- `python3 scripts/score.py <run_dir> <fixture_dir> [--out grading.json]` — mutation score for
  one produced suite: applies each mutant to a scratch copy of `<run_dir>` and runs `bun test`;
  a mutant is killed when the suite goes red.
- `python3 scripts/grade_all.py <iteration-dir>` — `score.py` plus the smell checker over every
  `eval-*/<arm>/run-N/outputs` under an iteration directory, writing `grading.json` per run.
- `python3 scripts/score3.py <iteration-dir>` — the fuller grade: kill rate, false-red rate
  (suite stays green across `refactors.json`), dead-test survival (`dead-tests.json`), and suite
  density.
- `python3 scripts/ready.py <iteration-dir>` — has every arm actually written a suite yet, or is
  the seed still untouched? Exit 1 while anything is pending.
- `python3 scripts/verify_refactors.py` — proves each refactor is behaviour-preserving via
  `probe.ts`, so a false red is the suite's fault, not the refactor's.
- `python3 scripts/verify_escapes.py` — re-verifies adversary escape claims against
  `results/it7-manifest.json` (needs the `iteration-7/break/` transcripts).

The scorers are python, kept exactly as they ran during calibration. A TypeScript port is a
follow-up; changing them and re-scoring in the same change would leave no way to tell a scorer
regression from a skill regression.

## Where the numbers came from

Seven iterations, 103 agent runs, 72 mutants across the six fixtures. The verbose variant is
the one shipped as `../SKILL.md`. The smell checker (`../scripts/test-smells.mjs`) was tuned
until it reported 0 false-positive errors across 1,709 real tests while still catching 5/5
seeded flaws. Iteration 7 was the adversarial round: agents hunted for a mutant each produced
suite would let through; all 12 claimed escapes verified (`results/escapes-verified.json`), and
three judges rated each escape's severity blind (`results/severity-final.json`; the verbose
arm's escapes rated lowest).

## Re-calibrating

1. Copy a fixture to a scratch project, drop the variant under test in as the session's skill,
   and ask a fresh session to write or repair the tests (greenfield: no seed; repair: copy
   `seed.test.ts` in first).
2. Lay the outputs out as `<iteration-dir>/eval-<scenario>/<arm>/run-N/outputs/`.
3. `ready.py`, then `score3.py`. Compare against `results/` before touching `../SKILL.md`.
