import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { copyRevealTemplate } from "./template-copier";
import {
  ProjectMetaSchema,
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

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string";
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

      return this.toProject(meta);
    } catch (err) {
      await this.bestEffortRm(cwd);
      if (err instanceof ProjectStoreError) throw err;
      if (isErrnoException(err) && err.code === "EEXIST") {
        throw new ProjectStoreError("PROJECT_ALREADY_EXISTS", `id collision: ${id}`, { cause: err });
      }
      throw new ProjectStoreError(
        "IO_ERROR",
        `create failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      );
    }
  }

  async load(projectId: ProjectId): Promise<Project> {
    const cwd = this.getCwd(projectId);
    const metaPath = join(cwd, "meta.json");

    let raw: string;
    try {
      raw = await readFile(metaPath, "utf8");
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        throw new ProjectStoreError("PROJECT_NOT_FOUND", `project not found: ${projectId}`, { cause: err });
      }
      throw new ProjectStoreError(
        "IO_ERROR",
        `load failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ProjectStoreError("META_CORRUPTED", `invalid meta.json JSON: ${projectId}`, { cause: err });
    }

    const result = ProjectMetaSchema.safeParse(parsed);
    if (!result.success) {
      throw new ProjectStoreError(
        "META_CORRUPTED",
        `meta.json schema mismatch: ${projectId}`,
        { cause: result.error },
      );
    }

    console.log(`[slAIdo:store] loaded project ${result.data.id} title="${result.data.title}"`);

    return this.toProject(result.data);
  }

  async list(): Promise<Project[]> {
    let entries: string[];
    try {
      const dirents = await readdir(this.projectsRoot, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return [];
      throw new ProjectStoreError(
        "IO_ERROR",
        `list failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      );
    }

    const projects: Project[] = [];
    for (const name of entries) {
      try {
        projects.push(await this.load(name));
      } catch (err) {
        if (
          err instanceof ProjectStoreError &&
          (err.code === "PROJECT_NOT_FOUND" || err.code === "META_CORRUPTED")
        ) {
          continue;
        }
        throw err;
      }
    }

    projects.sort((a, b) => (a.meta.updatedAt < b.meta.updatedAt ? 1 : -1));
    return projects;
  }

  async delete(projectId: ProjectId): Promise<void> {
    const cwd = this.getCwd(projectId);
    try {
      await rm(cwd, { recursive: true, force: true });
      console.log(`[slAIdo:store] deleted project ${projectId}`);
    } catch (err) {
      throw new ProjectStoreError(
        "DELETE_FAILED",
        `delete failed: ${(err as Error)?.message ?? String(err)}`,
        { cause: err },
      );
    }
  }

  private toProject(meta: ProjectMeta): Project {
    const cwd = this.getCwd(meta.id);
    return {
      meta,
      cwd,
      slidesEntry: join(cwd, "slides", "index.html"),
    };
  }

  private async bestEffortRm(target: string): Promise<void> {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(`[slAIdo:store] cleanup failed for ${target}:`, cleanupErr);
    }
  }
}
