import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { copyRevealTemplate } from "./template-copier";
import {
  ProjectStoreError,
  type CreateProjectInput,
  type Project,
  type ProjectId,
  type ProjectMeta,
} from "./types";

function buildInitialMeta(id: string, title: string, now: string): ProjectMeta {
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

export class ProjectStore {
  constructor(
    private readonly projectsRoot: string,
    private readonly templateRoot: string,
  ) {}

  getCwd(projectId: ProjectId): string {
    return join(this.projectsRoot, projectId);
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const trimmed = input.title.trim();
    if (trimmed.length === 0) {
      throw new ProjectStoreError("INVALID_TITLE", "title must not be empty");
    }

    const id = crypto.randomUUID();
    const cwd = this.getCwd(id);

    try {
      await mkdir(this.projectsRoot, { recursive: true });
      await mkdir(cwd, { recursive: false });
      await mkdir(join(cwd, "slides"), { recursive: true });
      await mkdir(join(cwd, "seed"), { recursive: true });

      await copyRevealTemplate(this.templateRoot, cwd);
      await writeFile(join(cwd, "seed", "input.md"), input.seedText, "utf8");

      const now = new Date().toISOString();
      const meta = buildInitialMeta(id, trimmed, now);
      await writeFile(
        join(cwd, "meta.json"),
        `${JSON.stringify(meta, null, 2)}\n`,
        "utf8",
      );

      console.log(`[slAIdo:store] created project ${meta.id} title="${meta.title}"`);

      return {
        meta,
        cwd,
        slidesEntry: join(cwd, "slides", "index.html"),
      };
    } catch (err) {
      await this.bestEffortRm(cwd);
      if (err instanceof ProjectStoreError) throw err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") {
        throw new ProjectStoreError("PROJECT_ALREADY_EXISTS", `id collision: ${id}`, { cause: err });
      }
      throw new ProjectStoreError("IO_ERROR", `create failed: ${(err as Error)?.message ?? String(err)}`, {
        cause: err,
      });
    }
  }

  private async bestEffortRm(target: string): Promise<void> {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[slAIdo:store] cleanup failed for ${target}:`, cleanupErr);
    }
  }
}
