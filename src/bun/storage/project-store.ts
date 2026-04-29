import { join } from "node:path";
import type { ProjectId } from "./types";

export class ProjectStore {
  constructor(
    private readonly projectsRoot: string,
    private readonly templateRoot: string,
  ) {}

  getCwd(projectId: ProjectId): string {
    return join(this.projectsRoot, projectId);
  }
}
