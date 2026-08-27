/** The PR-body writing standard, as data plus a pure renderer: one operative home for house style. */

/** The controlled-language section: when it exists, what it is called, and the register it is written in. */
export interface ContractDeltaRules {
  readonly heading: string
  /** A clause, not a sentence: spliced after "when" into an instruction, never rendered standalone. */
  readonly trigger: string
  readonly register: readonly string[]
}

/** One variant's decisions: how the body opens, how the facts group, and the contract-delta register. */
export interface ChangelogParams {
  readonly lead: readonly string[]
  readonly grouping: readonly string[]
  readonly contractDelta: ContractDeltaRules
  readonly exclusions: readonly string[]
}

/**
 * No front-matter: this variant is spliced straight into a session's prompt, never installed or
 * discovered (the `write-pr-body` node variant, following `mag/skills/CLAUDE.md`'s pattern).
 */
export const PR_BODY_PARAMS: ChangelogParams = {
  lead: [
    "Open with one present-tense sentence naming what the change ships.",
    "Add a second sentence only when one line cannot carry the outcome.",
    "Never restate the title."
  ],
  grouping: [
    "Bullet the remaining facts, grouped by the behaviour they change.",
    "State behaviour a reader sees, not a file list.",
    "Backtick identifiers, flags, and literal values.",
    "Drop internal refactors unless they are the point."
  ],
  contractDelta: {
    heading: "## Contract delta",
    trigger: "the diff changes a schema, an error tag, prompt text, wiring between components, or a command-line surface",
    register: [
      "One fact per sentence: present tense, active voice, no subordinate clauses.",
      "Name the thing that changes, then state what it does now.",
      "One term for one concept.",
      "Omit the section when no such contract moved."
    ]
  },
  exclusions: [
    "No process narration: reviews, passes, retries, or how the change was produced.",
    "No file names, commit hashes, or requirement numbers.",
    "No em-dashes: use a period, a colon, or a comma."
  ]
}

/**
 * Pure: params in, one string out. No parsing, no I/O, no dispatch-time facts.
 *
 * The contract-delta line is an instruction ("Add a `heading` section when...") like every
 * sibling label, never the heading rendered bare at line-start: a bare `## heading: trigger` reads
 * as a literal markdown H2 splicing itself into the prompt, and a bare declarative trigger carries
 * no verb telling the session to act on it. Backticking `heading` here
 * keeps its literal text available to the session — it is what the rendered PR body's own section
 * must be called — without ever starting a line with `## `.
 */
export const compileChangelog = (params: ChangelogParams): string =>
  [
    "Write the pull request description under this standard.",
    "",
    "Lead:",
    ...params.lead.map((line) => `- ${line}`),
    "",
    "Grouping:",
    ...params.grouping.map((line) => `- ${line}`),
    "",
    "Contract delta:",
    `- Add a \`${params.contractDelta.heading}\` section when ${params.contractDelta.trigger}.`,
    ...params.contractDelta.register.map((line) => `- ${line}`),
    "",
    "Exclusions:",
    ...params.exclusions.map((line) => `- ${line}`)
  ].join("\n")
