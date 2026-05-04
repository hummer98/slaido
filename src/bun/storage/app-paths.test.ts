import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import {
  getAppDataRoot,
  getProjectsRoot,
  getRubricPresetsRoot,
  getLastOpenedFile,
  getBundledTemplateRoot,
} from "./app-paths";

describe("app-paths", () => {
  describe("getAppDataRoot", () => {
    it("homeOverride 引数で任意の HOME を解決できる", () => {
      const home = "/tmp/fake-home";
      expect(getAppDataRoot(home)).toBe(
        join(home, "Library", "Application Support", "slAIdo"),
      );
    });

    it("引数を省略すると process.env.HOME 配下を返す", () => {
      const home = process.env.HOME ?? "";
      expect(getAppDataRoot()).toBe(
        join(home, "Library", "Application Support", "slAIdo"),
      );
    });
  });

  describe("getProjectsRoot", () => {
    it("getAppDataRoot/projects を返す", () => {
      const home = "/tmp/fake-home";
      expect(getProjectsRoot(home)).toBe(
        join(getAppDataRoot(home), "projects"),
      );
    });
  });

  describe("getRubricPresetsRoot", () => {
    it("getAppDataRoot/rubric-presets を返す", () => {
      const home = "/tmp/fake-home";
      expect(getRubricPresetsRoot(home)).toBe(
        join(getAppDataRoot(home), "rubric-presets"),
      );
    });

    it("homeOverride を引き継いで完全パスを返す", () => {
      const home = "/tmp/fake-home";
      expect(getRubricPresetsRoot(home)).toBe(
        join(home, "Library", "Application Support", "slAIdo", "rubric-presets"),
      );
    });
  });

  describe("getLastOpenedFile", () => {
    it("getAppDataRoot/last-opened.json を返す", () => {
      const home = "/tmp/fake-home";
      expect(getLastOpenedFile(home)).toBe(
        join(getAppDataRoot(home), "last-opened.json"),
      );
    });
  });

  describe("getBundledTemplateRoot", () => {
    it("文字列で templates/reveal を含むパスを返す", () => {
      const root = getBundledTemplateRoot();
      expect(typeof root).toBe("string");
      expect(root).toContain("templates");
      expect(root).toContain("reveal");
    });
  });
});
