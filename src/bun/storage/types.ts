import { z } from "zod";

export type ProjectId = string;

export const ProjectMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  schemaVersion: z.literal(1),
});

export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;

export interface Project {
  meta: ProjectMeta;
  cwd: string;
  slidesEntry: string;
}

export interface CreateProjectInput {
  title: string;
  seedText: string;
}

export type ProjectStoreErrorCode =
  | "INVALID_TITLE"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ALREADY_EXISTS"
  | "META_CORRUPTED"
  | "TEMPLATE_MISSING"
  | "DELETE_FAILED"
  | "IO_ERROR";

export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode;

  constructor(code: ProjectStoreErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.name = "ProjectStoreError";
    this.code = code;
  }
}
