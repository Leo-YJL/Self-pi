import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultConfig } from "../engine/config.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";
import type { ProfileName } from "../types.ts";

export interface InitWorkspacePlan {
  ok: boolean;
  mode: "dry_run" | "execute";
  willCreate: string[];
  willModify: string[];
  created?: string[];
  modified?: string[];
  skipped?: string[];
  blockedBy: string[];
  warnings: string[];
}

const BASE_FILES = [".workflow/config.json", ".workflow/tasks/.gitkeep", ".workflow/spec/.gitkeep", ".workflow/.runtime/.gitkeep"];

export async function planInitWorkspace(root: string, profile: ProfileName = "generic"): Promise<InitWorkspacePlan> {
  const willCreate = BASE_FILES.filter((file) => !existsSync(resolveInsideRoot(root, file)));
  const gitignore = resolveInsideRoot(root, ".gitignore");
  const willModify: string[] = [];
  if (existsSync(gitignore)) {
    const text = await readFile(gitignore, "utf8");
    if (!text.split(/\r?\n/).includes(".workflow/.runtime/")) willModify.push(".gitignore");
  } else {
    willModify.push(".gitignore");
  }
  return { ok: true, mode: "dry_run", willCreate, willModify, blockedBy: [], warnings: [] };
}

export async function executeInitWorkspace(root: string, profile: ProfileName = "generic"): Promise<InitWorkspacePlan> {
  const plan = await planInitWorkspace(root, profile);
  const created: string[] = [];
  const modified: string[] = [];
  const skipped: string[] = [];

  for (const rel of BASE_FILES) {
    const abs = resolveInsideRoot(root, rel);
    if (existsSync(abs)) {
      skipped.push(rel);
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    const content = rel.endsWith("config.json") ? `${JSON.stringify(defaultConfig("Project", profile), null, 2)}\n` : "";
    await writeFile(abs, content, "utf8");
    created.push(rel);
  }

  const gitignore = resolveInsideRoot(root, ".gitignore");
  let gitignoreText = existsSync(gitignore) ? await readFile(gitignore, "utf8") : "";
  if (!gitignoreText.split(/\r?\n/).includes(".workflow/.runtime/")) {
    if (gitignoreText.length > 0 && !gitignoreText.endsWith("\n")) gitignoreText += "\n";
    gitignoreText += ".workflow/.runtime/\n";
    await writeFile(gitignore, gitignoreText, "utf8");
    modified.push(".gitignore");
  }

  return { ...plan, mode: "execute", created, modified, skipped };
}
