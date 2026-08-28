---
name: discover
description: Recon what a request touches in the repository you are in, as a cited note: one learning question answered by reading the code, a reuse map, relevant files, constraints and open unknowns. USE WHEN asked to discover, recon, or map what already exists for a feature, bug or refactor before designing or planning it, or before building in an unfamiliar area.
---

# Discover

Take the request you were given as the ticket. Recon this repository for what it touches. Read only.
Write your findings to the path the request names, else `docs/graph/discover.md`. Change nothing else.

Reframe the ticket as one learning question of the form "How does X currently work today?" and write it as the note's first line. Answer it by reading the code. Report what exists; the design decides what changes.

Report:
- Reuse map: which existing modules, components, or services already cover parts of this ticket, cited by name and path, versus what is genuinely new.
- Relevant files: where the behaviour this ticket touches lives today, one line per file: entry points, the modules it changes, where similar behaviour already sits, and the consumers a change would ripple to, each line carrying the house micro-convention a change there will echo (log-tag style, error-message shape, comment idiom) where it matters.
- Constraints: existing contracts, validation rules, or behaviour that must not break.
- Open unknowns: questions the code alone could not resolve.

Rules:
- Derive search terms from the ticket's own nouns and their case variants (kebab/camel/snake/Pascal) and synonyms, never from export syntax.
- Cite every claim with a repo-relative path or path:line, and report only what you verified in the code, never what you assume is there.
- Every "genuinely new" claim in the reuse map names the searches that came up empty for it, and where they were run.
- Read no generated index and write none: the map is computed fresh, per ticket, by search.
- A contradiction between two documents is an open unknown quoting both, never silently resolved by picking one.
- Keep the note to what the next reader needs to find each file: a path and one line per entry; the reader opens the file for the rest.
- The note is your only write.