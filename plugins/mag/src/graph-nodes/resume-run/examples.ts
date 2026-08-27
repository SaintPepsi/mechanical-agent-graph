export const inputExamples = [
  { ticket: "GH-98", graph: "develop-graph" },
  { ticket: "GH-213", graph: "design-graph" }
]
export const successExamples = [
  {
    predecessorRunId: "20260820120000-a1b2",
    journalPath: "/home/dev/.claude/graph/repo-7eb2cc6a/GH-98/20260820120000-a1b2/journal.jsonl",
    workRoot: "/home/dev/repo-worktrees/GH-98-20260819090000-c3d4",
    rule: "the prior run of this ticket with the most replayable nodes for this graph, its own resume record excluded, newest run id on ties",
    replayable: 4
  },
  {
    // `workRoot` absent: the chosen predecessor was itself a first-generation run, never a resume.
    predecessorRunId: "20260819090000-c3d4",
    journalPath: "/home/dev/.claude/graph/repo-7eb2cc6a/GH-213/20260819090000-c3d4/journal.jsonl",
    rule: "the prior run of this ticket with the most replayable nodes for this graph, its own resume record excluded, newest run id on ties",
    replayable: 1
  }
]
