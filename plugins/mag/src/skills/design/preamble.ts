import type { Concern, Section } from "mag/skills/design/concern"

/** The document's frame: title and one-line purpose. Recorded as its own module, not folded into
 * another concern's. A frame with no owner is how glue re-accumulates (partition record, remainder
 * table). Present in every variant; its `section` is required, not optional, so neither composer path
 * needs a branch for an absence that cannot happen. */
export const preamble: Concern<"any"> & { readonly section: Section } = {
  id: "preamble",
  audience: "any",
  section: {
    heading: "# Engineering Brainstorming",
    body: () =>
      "Turn a software idea into a fully-formed design through collaborative dialogue, evaluated against the engineering principles stack.\n\n"
  }
}
