// Test harness: same entry-point shape as src/cli.ts, pointed at the fixture registry.
import { main } from "mag/runtime/run-cli"
import { fixtureRegistry } from "./fixtures/registry"

main(fixtureRegistry)
