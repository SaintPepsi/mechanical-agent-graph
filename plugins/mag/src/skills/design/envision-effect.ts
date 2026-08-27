import effectCode from "mag/docs/envision/effect-code.envision.md" with { type: "text" }
import type { Concern } from "mag/skills/design/concern"
import { envisionDocBody } from "mag/skills/design/concern"

/**
 * Draw the ideal as railway pseudo-code — the rails, the channels, the error union — before any of
 * it exists. The prose is `plugins/mag/docs/envision/effect-code.envision.md`, spliced whole (see
 * `envisionDocBody`). Selected only when `detect-effect` matches; its text is absent from every
 * prompt that doesn't.
 */
export const envisionEffect: Concern<"any"> = {
  id: "envision-effect",
  audience: "any",
  section: {
    heading: "",
    body: () => envisionDocBody(effectCode)
  }
}
