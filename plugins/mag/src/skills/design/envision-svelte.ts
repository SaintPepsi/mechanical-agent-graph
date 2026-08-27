import svelteUiComponents from "mag/docs/envision/svelte-ui-components.envision.md" with { type: "text" }
import type { Concern } from "mag/skills/design/concern"
import { envisionDocBody } from "mag/skills/design/concern"

/**
 * Draw the ideal UI as component tags, blind to what renders today — svelte's half of what was once
 * `seams-ownership`'s unconditional shell rules, moved here so a non-svelte headless prompt never
 * carries it. The prose is `plugins/mag/docs/envision/svelte-ui-components.envision.md`, spliced
 * whole (see `envisionDocBody`).
 */

/** No heading of its own (continues `seams-ownership`'s `## The Envisioned Shell`, the way
 *  `reference-sweep`'s paragraph already does). Selected only when `detect-svelte` matches. */
export const envisionSvelte: Concern<"any"> = {
  id: "envision-svelte",
  audience: "any",
  section: {
    heading: "",
    body: () => envisionDocBody(svelteUiComponents)
  }
}
