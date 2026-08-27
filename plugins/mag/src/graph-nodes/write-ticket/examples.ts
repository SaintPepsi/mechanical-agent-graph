export const inputExamples = [
  {
    what: "Ticket writing costs a session its context.",
    why: "So filing a ticket does not spend the budget of the ticket it describes.",
    how: "Turn three sentences into a schema-validated ticket a mechanical node files."
  },
  {
    what: "The pipeline has no way to draft a ticket without a full writing session.",
    why: "So the standard stays cold-startable and filing stays a subprocess call.",
    how: "Split writing and filing across two GraphNodes.",
    criteriaPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/draft/run-1/criteria.txt",
    agent: "effect-expert",
    model: "sonnet"
  }
]

export const successExamples = [
  {
    ticket: {
      title: "ticket-writer flow: What/Why/How in, house-style ticket filed",
      executiveSummary: "A ticket-writer graph turns three sentences into a filed house-style ticket.",
      type: "Story",
      component: ["plugins/mag/src/graphs/"],
      context: "Ticket writing today consumes a session's context.",
      acceptanceCriteria: [
        {
          title: "The writer's reply is the ticket's structure",
          given: "inputs What, Why, How",
          when: "write-ticket runs",
          then: ["its success value is schema-validated ticket structure"],
          source: "The writer's reply is the ticket's structure"
        }
      ],
      dependsOn: [],
      blocks: [],
      graphNodes: [{ marker: "+", name: "write-ticket" }]
    },
    ticketPath: "/home/dev/.claude/graph/mechanical-agent-graph-091d09d6/draft/run-1/ticket-1.json",
    sessions: ["a1b2c3"],
    costUsd: 0.08
  }
]
