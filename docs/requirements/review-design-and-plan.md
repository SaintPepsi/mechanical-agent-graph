# A design is reviewed and turned into a plan before any build starts

## Executive Summary

The design lane gets two new nodes, `plan` and `review-plan`, so a design defect stops the run before a build spends an hour on it.

**Type:** Task
**Component:** design-graph

> Depends on: none · Blocks: GH-367 (its rerun needs a design review to hold the AC.04 collision)

## Definitions

- Design record: the file `design.md` that the `brainstorm` node writes into the run root. It states the chosen approach and its interpretation rulings.
- Plan: a file `plan.md` in the run root. It lists the build as small ordered tasks. Each task names the files to change and the test that proves it.
- Undecided ruling: a ruling in the design record stated as a choice still open, or with no basis named. An autonomous design decides; a run that cannot decide has failed, not asked.
- Findings: a file that a review node writes into the run root. It lists each defect with a location and a reason.
- Dispute: a file that the disputed node writes into the run root. It answers each finding it does not accept.

## Background

The v1 pipeline ran fourteen steps. Step 4 wrote a plan and step 5 reviewed that plan before step 6 built anything. The current `design-graph` runs `envision ∥ discover → brainstorm` and then hands `design.md` straight to `build-under-review`. Nothing reads the design record before the build. Nothing writes a plan. The skill `plugins/mag/skills/writing-plans` ships but no node calls it.

Run `GH-367/20260827091705-482d` shows the cost. The design record listed a collision with the ruling "coached, not invented" in its Open Questions. The build shipped the collision. The diff review found it after 86 minutes of build, verification and simplify. The build disputed the finding. The second review rejected the dispute. The run escalated with nothing shippable after 113 minutes and $19.91.

Run `GH-332/20260827085239-211a` shows the second cost. The build session on Sonnet read `construct.test.ts` eleven times and ran the full suite three times, because it worked from a prose design with no task list.

## Proposed structure

`design-graph` becomes `envision ∥ discover → brainstorm → plan → review-plan`.

- `plan` is a GraphNode. It runs one session with the `writing-plans` skill. It reads `design.md` and writes `plan.md`.
- `review-plan` is a GraphNode. It runs one review session at the altitude of v1 step 5: acceptance criteria coverage, collisions with a ruling in a `CLAUDE.md` or `PRINCIPLES.md`, and undecided rulings. It reads `design.md`, `plan.md` and the ticket. It does not review code.
- The errors of `review-plan` mirror the errors of `review-diff`: `PLAN_BLOCKED` with a `findingsPath`, and `PLAN_DISPUTE_REJECTED` with a `disputePath`.
- `build-under-review` reads `plan.md`. `design.md` stays in the run root as the record of why.
- One review session covers both files. The pipeline does not run a second review for the design.

## Acceptance criteria

**AC.01 - The plan node writes a plan from the design record**

**GIVEN** the `brainstorm` node has written `design.md` into the run root

**WHEN** the `plan` node runs

**THEN** the `plan` node writes `plan.md` into the run root

**AND** every task in `plan.md` names the files it changes and the test that proves it

**AND** the success of the `plan` node carries `planPath`, `headSha`, `sessions` and `costUsd`

&nbsp;

**AC.02 - The review node reviews the design record and the plan together**

**GIVEN** AC.01

**WHEN** the `review-plan` node runs

**THEN** the `review-plan` node runs exactly one session

**AND** that session reads the ticket, `design.md` and `plan.md`

**AND** that session does not read the diff of the branch

&nbsp;

**AC.03 - An undecided ruling is a blocking finding**

**GIVEN** AC.02

**AND** `design.md` states a ruling as a choice still open, or with no basis named

**WHEN** the `review-plan` node runs

**THEN** the `review-plan` node fails with the tag `PLAN_BLOCKED`

**AND** the findings file quotes each undecided ruling as a finding

&nbsp;

**AC.04 - A collision with a ruling is a blocking finding**

**GIVEN** AC.02

**AND** the plan or the design record asks a session to do something that a `CLAUDE.md` or `PRINCIPLES.md` ruling in the target repository forbids

**WHEN** the `review-plan` node runs

**THEN** the `review-plan` node fails with the tag `PLAN_BLOCKED`

**AND** the findings file quotes the ruling and names the task or the design section that collides with it

&nbsp;

**AC.05 - A missed acceptance criterion is a blocking finding**

**GIVEN** AC.02

**AND** the ticket has an acceptance criterion that no task in `plan.md` proves

**WHEN** the `review-plan` node runs

**THEN** the `review-plan` node fails with the tag `PLAN_BLOCKED`

**AND** the findings file names the acceptance criterion

&nbsp;

**AC.06 - A blocked plan goes back to the brainstorm node, not to the build**

**GIVEN** the `review-plan` node has failed with `PLAN_BLOCKED`

**WHEN** the `design-graph` reacts to the failure

**THEN** the `design-graph` runs the `brainstorm` node again with the findings file as an input

**AND** the `design-graph` runs the `plan` node and the `review-plan` node again

**AND** no build node runs before the `review-plan` node succeeds

&nbsp;

**AC.07 - A rejected dispute escalates to the user**

**GIVEN** the `brainstorm` node has answered a findings file with a dispute file

**AND** the `review-plan` node does not accept the dispute

**WHEN** the `review-plan` node fails

**THEN** the tag is `PLAN_DISPUTE_REJECTED`

**AND** the failure carries `disputePath`, `findingsPath`, `headSha`, `sessions` and `costUsd`

**AND** the run stops without a build

&nbsp;

**AC.08 - The build node works from the plan**

**GIVEN** the `review-plan` node has succeeded

**WHEN** the `build-under-review` node runs

**THEN** the first prompt of the build session names `plan.md` as the list of tasks to do

**AND** the build session receives `design.md` as the record of the reasons, not as the list of tasks

&nbsp;

**AC.09 - The success of the design graph carries the plan**

**GIVEN** the `review-plan` node has succeeded

**WHEN** the `design-graph` returns

**THEN** the success carries `planPath` beside `designPath`

**AND** the `sessions` and `costUsd` fields include the `plan` session and the `review-plan` session

&nbsp;

**AC.10 - The develop-ticket-graph skill states the new failure tags**

**GIVEN** the skill `plugins/mag/skills/develop-ticket-graph/SKILL.md`

**WHEN** a session reads the section "Reading the outcome"

**THEN** the section lists `PLAN_BLOCKED` and `PLAN_DISPUTE_REJECTED` beside the `review-diff` tags

**AND** the section tells the session to read the findings file or the dispute file first

## References

- v1 step map: `complete-ticket-workflow` at commit `49f797d`, `plugins/ticket-workflow/skills/complete-ticket-workflow/SKILL.md:37`
- Run `~/.claude/graph/mechanical-agent-graph-ca1bf6d4/GH-367/20260827091705-482d/`: `design.md` Open Questions 1, `review-diff-1.md` finding 2, `dispute-1.md`, `review-diff-2.md`
- Run `~/.claude/graph/mechanical-agent-graph-ca1bf6d4/GH-332/20260827085239-211a/`: build transcript, eleven reads of `construct.test.ts`
- `plugins/mag/src/graphs/design-graph/graph.ts`: the current spine
- `plugins/mag/src/graph-nodes/review-diff/errors.ts`: the error family to mirror
- `plugins/mag/skills/writing-plans/SKILL.md`: the plan skill
