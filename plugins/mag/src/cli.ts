// Invocation: bun run mag --help works directly (bun forwards flags to the script)
import { registry } from "mag/registry"
import { main } from "mag/runtime/run-cli"

main(registry)
