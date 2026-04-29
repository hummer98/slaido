import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { ProjectStore } from "./project-store";

describe("ProjectStore.getCwd", () => {
  it("projectId から projectsRoot/<id> を返す純関数", () => {
    const projectsRoot = "/tmp/projects-root";
    const templateRoot = "/tmp/template-root";
    const store = new ProjectStore(projectsRoot, templateRoot);

    expect(store.getCwd("abc-123")).toBe(join(projectsRoot, "abc-123"));
  });
});
