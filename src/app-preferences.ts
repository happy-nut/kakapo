import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { workspaceDataDirectory } from "./workspace-data.js";

export type RecentProject = { path: string; name: string; openedAt: number };

const RECENT_KEY = "kakapo-recent-projects";
const READ_MARK_KEY = "kakapo-read-mark";
const RECENT_MAX = 12;
const GLOBAL_SETTING_KEYS = new Set([
  "kakapo-locale",
  "kakapo-theme",
  "kakapo-syntax-theme",
  RECENT_KEY,
  "kakapo-ui-scale",
  "kakapo-shortcut-overrides",
]);

/** Owns persistent preferences without coupling storage rules to Electron. */
export class AppPreferences {
  constructor(
    private readonly userData: string,
    private readonly belongsInRecentProjects: (path: string) => boolean = () => true,
  ) {}

  readGlobal(): Record<string, unknown> {
    return this.readJson(join(this.userData, "kakapo-settings.json"));
  }

  writeGlobal(settings: Record<string, unknown>): void {
    this.writeJson(join(this.userData, "kakapo-settings.json"), settings, false);
  }

  readWorkspace(root: string): Record<string, unknown> {
    return this.readJson(this.workspaceFile(root));
  }

  rendererSettings(root: string): Record<string, unknown> {
    return { ...this.readGlobal(), ...this.readWorkspace(root) };
  }

  setRendererSetting(root: string | undefined, key: string, value: unknown): void {
    if (!root || GLOBAL_SETTING_KEYS.has(key)) {
      const settings = this.readGlobal();
      settings[key] = value;
      this.writeGlobal(settings);
      return;
    }
    const settings = this.readWorkspace(root);
    settings[key] = value;
    this.writeJson(this.workspaceFile(root), settings, true);
  }

  readReadMark(root: string): string | undefined {
    const saved = this.readWorkspace(root)[READ_MARK_KEY];
    return typeof saved === "string" && saved ? saved : undefined;
  }

  setReadMark(root: string, sha: string): void {
    this.setRendererSetting(root, READ_MARK_KEY, sha);
  }

  readRecentProjects(): RecentProject[] {
    const raw = this.readGlobal()[RECENT_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is RecentProject => {
      if (!entry || typeof entry !== "object") return false;
      const project = entry as Partial<RecentProject>;
      return typeof project.path === "string"
        && typeof project.name === "string"
        && typeof project.openedAt === "number";
    });
  }

  pruneRecentProjects(): void {
    const settings = this.readGlobal();
    const raw = settings[RECENT_KEY];
    if (!Array.isArray(raw)) return;
    const live = raw.filter((entry) => {
      const path = (entry as Partial<RecentProject> | null)?.path;
      return typeof path === "string" && existsSync(path) && this.belongsInRecentProjects(path);
    });
    if (live.length !== raw.length) {
      settings[RECENT_KEY] = live;
      this.writeGlobal(settings);
    }
  }

  recordRecentProject(root: string): void {
    const path = resolve(root);
    if (!this.belongsInRecentProjects(path)) return;
    const others = this.readRecentProjects().filter((project) => project.path !== path);
    const next: RecentProject[] = [
      { path, name: basename(path) || path, openedAt: Date.now() },
      ...others,
    ].slice(0, RECENT_MAX);
    const settings = this.readGlobal();
    settings[RECENT_KEY] = next;
    this.writeGlobal(settings);
  }

  forgetRecentProject(root: string): void {
    const path = resolve(root);
    const settings = this.readGlobal();
    settings[RECENT_KEY] = this.readRecentProjects().filter((project) => project.path !== path);
    this.writeGlobal(settings);
  }

  private workspaceFile(root: string): string {
    return join(workspaceDataDirectory(this.userData, root), "state.json");
  }

  private readJson(file: string): Record<string, unknown> {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private writeJson(file: string, value: Record<string, unknown>, trailingNewline: boolean): void {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(value, null, 2) + (trailingNewline ? "\n" : ""));
    } catch {
    }
  }
}
