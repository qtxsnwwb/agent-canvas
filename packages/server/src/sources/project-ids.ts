/** Claude Code's encoding of a working directory into a project id: every non-alphanumeric character becomes `-`. */
export const encodeProjectId = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Project ids for working directories of sources that are not Claude Code (Codex, Cursor): the directory encoded as
 * Claude Code does, or a project id already in use that differs from it only in letter case (so `d:\work` and
 * `D:\work` land in one project). Ids in use are those noted by the source plus `known()` (the store's and Claude
 * Code's), consulted lazily on a miss.
 */
export class ProjectIdResolver {
  /** Lower-cased project id -> the project id in use. */
  private readonly byLower = new Map<string, string>();

  constructor(private readonly known: () => Iterable<string> = () => []) {}

  /** Records a project id in use (the first spelling of an id wins). */
  note(projectId: string): void {
    const lower = projectId.toLowerCase();
    if (!this.byLower.has(lower)) this.byLower.set(lower, projectId);
  }

  /** The encoded cwd, or a project id already in use that differs from it only in letter case. */
  forCwd(cwd: string): string {
    const id = encodeProjectId(cwd);
    const lower = id.toLowerCase();
    let hit = this.byLower.get(lower);
    if (hit === undefined) {
      for (const known of this.known()) this.note(known);
      hit = this.byLower.get(lower);
    }
    if (hit !== undefined) return hit;
    this.byLower.set(lower, id);
    return id;
  }
}
