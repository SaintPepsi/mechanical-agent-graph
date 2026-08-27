// Test harness: same entry-point shape as src/cli.ts, pointed at the unsupported-schema registry
// — the whole CLI build is expected to fail here.
import { main } from "mag/runtime/run-cli"
import { unsupportedRegistry } from "./fixtures/registry"

main(unsupportedRegistry)
