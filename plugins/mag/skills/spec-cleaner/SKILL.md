---
name: spec-cleaner
description: Strip a design or spec document down to what must be built — positive statements only, no reasoning, no history, no "not X but Y". USE WHEN a design doc reads like an argument instead of an instruction, before a spec becomes the contract for core work, or on request ("clean this spec", "spec-cleaner", "make this document state what to build").
---

# spec-cleaner

A design document has two jobs, and they fight. While it is being written it argues: this approach
over that one, this ruling because of that evidence. Once it is agreed it instructs: build this.
A document still carrying its argument makes a reader reconstruct the decision every time they open
it, and the parts that read as instruction get mixed with the parts that read as persuasion.

This skill converts the first kind into the second. Run it when a spec is settled and becomes the
thing someone builds from.

## Dispatch

Spawn **one Fable subagent** with the file path and the rules below. Fable, because the work is
judgment about language at every sentence and a weaker model deletes content along with the
argument.

The agent rewrites the file in place with the Write tool. Review the result before committing.

## The rules the agent applies

1. **Positive statements only.** Every sentence says what something *is* or what *must be done*.
   Delete every `not X but Y`, `rather than`, `instead of`, `X, not Y`, `never a Z`, `does not
   mean`. A boundary is stated positively: "`exitCode` holds the raw process exit code", never
   "`exitCode` is not interpreted".
2. **No reasoning.** Delete `because`, `the reason is`, `which is why`, `on the grounds that`.
   State the requirement; drop the justification.
3. **No history, no changelog.** Delete `an earlier draft`, `this was withdrawn`, `verified during
   probing`, `found by review`. A fact discovered by investigation is stated flatly, with no
   account of how it was learned.
4. **No comparison as justification.** References to a prior implementation survive as source
   citations for behaviour that must be replicated (`the allowlist is X (file.ts:46)`). Every
   sentence whose job is to argue the new way beats the old way goes.
5. **No hedging or salesmanship.** Delete `arguably`, `honestly`, `the whole argument`, `the
   strongest argument for`, `worth noting`, `the one that matters most`.
6. **Specification shape.** Tables and short declarative sentences. Every section answers "what
   gets built" or "what must hold true".

## What survives

Constraints that bind the implementation. Types and their fields. File layout. Tables of rules,
bounds, error classifications, ownership. Usage examples. Testing strategy. Authoring rules.
Anything a builder would otherwise have to guess.

## What goes

Approaches Considered. Chosen Approach. Principles Applied. Every paragraph that is argument
rather than instruction.

## Decisions still open

Pending rulings are not argument and they stay, as a closing **Decisions Required** section: each
item states the decision and the default that applies if nobody answers. No case for either side.

## Verification is part of the job

The agent checks factual claims against the source files as it goes, and states the correct
version of anything unclear or self-contradictory. Its final message reports the sections removed,
the count of contrastive constructions eliminated, and every contradiction it found with how it
resolved each one.

Contradictions it surfaces are findings to act on, never edits to accept unread: a stale comment in
an old implementation and a fresh probe of current behaviour disagree in one direction more often
than the other.

## What the document loses, and where it went

The reasoning is what stops a settled call being re-litigated, so it needs a home before it is cut
from the spec. Commit messages and the ticket's comment thread are that home. Run this skill only
once both carry the argument the document is about to drop.
