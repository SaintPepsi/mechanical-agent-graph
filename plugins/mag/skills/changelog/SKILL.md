---
name: changelog
description: "Write a PR changelog / release notes in the house style — simple, readable, behaviour-focused sentences. USE WHEN write a changelog, changelog, change list, release notes, PR notes, PR description summary, 'what changed', summarise the changes for a PR."
---

# Changelog

Lead with what the reader sees differently. Behaviour, not diff. A reader should understand what changed without opening the code. This is a summary, not a restatement of the diff.

## Format

- `## Changes` heading, one `- ` bullet per change. No `Added`/`Fixed`/`Changed` subsections, no Keep-a-Changelog structure.
- One plain-English sentence per bullet. Say what changed, and the before and after when it sharpens the point.
- Wrap code-related things in backticks: identifiers (`JOURNAL_SCHEMA`, `isEndRow`), env vars, slugs, and any literal string or value quoted from the PR (`sonnet`, `"graph/journal@3"`).
- `Note:` line at the end (a plain line, not a bullet) for caveats or flagged follow-ups.
- Casual and terse is the target, not the exception.

## Delivery (always, without being asked)

- Output the changelog inside a fenced ```markdown block so the raw markdown is copyable.
- Copy it to the clipboard with whatever the platform offers (`pbcopy`, `wl-copy`, `clip.exe`); skip when none exists.
- These get pasted straight into PR descriptions. Rendered prose with no fence and nothing on the clipboard means asking twice.

## Hard rules (these are what gets rejected)

- **No em-dashes.** House ruling. Where you'd reach for one, use a period, a colon, or a comma. This applies everywhere: bullets, the Note line, and any title line a caller asks for.
- **No file names.** Not `graph-node.ts`, not in parens, not anywhere.
- **No commit hashes.**
- **No bare AC numbers.** No ticket or AC ids in code comments either; a comment states the reason, not the ticket.
- **Don't enumerate per-file diffs** or group by Added/Fixed/Changed.
- **Don't grow structure.** One heading, bullets, a Note line. If you're adding subheadings, you've overdone it.

## Shape

```markdown
## Changes

- <behavioural sentence: what changed, now X instead of Y>
- <behavioural sentence>

Note: <caveat or flagged follow-up, if any>
```

## Examples (in-voice)

```markdown
## Changes

- The run now refuses a ticket without acceptance criteria before any session starts, instead of dying at the verification node an hour in.
- The closing stderr line now names the failing tag, so a killed run and a failed run read differently at a glance.

Note: flagged a follow-up in code. A resumed run still re-pays its whole prefix, so nothing here makes a relaunch cheaper.
```

```markdown
## Changes

- Journal rows literally didn't say which pipeline version wrote them 🤦
- Drop a node from the topology walk when it's already been reached by another path.
```

## How to write one

1. Look at the diff and commits in scope.
2. For each meaningful change, ask "what does the user see differently now?" Write that as one bullet. Drop pure-internal refactors unless they're the point.
3. Lead with the user-facing behaviour. Add the before-state when it clarifies (`now X, instead of Y`).
4. Add a `Note:` line for anything you flagged as a follow-up or a known gap.
5. Re-read: any em-dashes, file names, hashes, or extra subheadings? Strip them. Too long? Cut.
6. Wrap in a ```markdown fence and copy it to the clipboard when the platform offers one.
