import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Layer } from "effect"

/**
 * The `FileSystem` + `Path` layer every GraphNode gets its I/O from. This file and
 * `runtime/run-cli.ts` are the only two files in this repo allowed to import
 * `@effect/platform-node` — the deliberate boundary around process globals.
 */
export const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** What a refused platform tells the user: the flat statement, and where to go instead. */
export interface PlatformRefusal {
  readonly detail: string
  readonly hint: string
}

/** Exit status of a refusal, distinct from 1 (a run that started and then failed). */
export const REFUSED_EXIT_CODE = 7

/**
 * WSL reports `linux` here, not `win32`, so it passes with no probe and no warning (repo policy:
 * WSL is the POSIX path, not a special case).
 */
export const platformRefusal = (platform: string): PlatformRefusal | undefined =>
  platform === "win32"
    ? {
        detail: "REFUSED: win32 is not a supported platform for mag",
        hint: "run this from a WSL distribution instead (inside WSL this CLI sees linux and proceeds)"
      }
    : undefined
