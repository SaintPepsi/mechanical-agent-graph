/**
 * Parses `git merge-tree --write-tree --name-only -z <ours> <theirs>`'s stdout on a conflicting
 * exit (1). Probed directly against git 2.53.0, a single-file conflict emits
 * `<write-tree-oid>\0<path>\0\0<per-conflict messages>\0`, and
 * a two-file conflict repeats the same shape with both paths ahead of the same closing empty field:
 * the tree oid, then the conflicting paths each NUL-terminated, then one empty NUL-terminated field
 * closing the path list, then free-form message fields this node never reads.
 *
 * `-z` rather than the newline form the probe table also recorded: a path containing a newline
 * cannot be misread as two paths this way.
 *
 * The oid (index 0) is discarded — `detect-conflicts` already has both refs' shas from its own
 * `rev-parse` probes, so a second tree identity from a different command is not this node's to
 * carry. Everything from the closing empty field onward (git's own prose) is discarded too: this
 * node names paths, it doesn't explain them. Empty stdout (no oid, no fields at all) yields no
 * paths, which `detect-conflicts` reads as `ConflictProbeFailed` rather than a clean run — exit 1
 * always means git found a conflict, so naming zero paths is a state this node cannot judge.
 */
export const conflictPaths = (stdout: string): readonly string[] => {
  const fields = stdout.split("\0")
  const paths: string[] = []
  for (let i = 1; i < fields.length; i++) {
    const field = fields[i]
    if (field === "") break
    paths.push(field)
  }
  return paths
}
