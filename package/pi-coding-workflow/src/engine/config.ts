import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ProfileName, ProjectWorkflowConfig } from "../types.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";

export function defaultConfig(projectName = "Project", profile: ProfileName = "generic"): ProjectWorkflowConfig {
  return {
    schemaVersion: 1,
    package: { name: "pi-coding-workflow", requiredVersion: "0.1.0" },
    project: { name: projectName, profile, root: "." },
    workflow: { defaultFlowLevel: "standard", taskDir: ".workflow/tasks", specDir: ".workflow/spec", runtimeDir: ".workflow/.runtime" },
    context: { defaultMode: "lite", maxSummaryChars: 2000, artifactMode: "summary-first" },
    git: { autoCommit: true, autoPush: true, pushConfirmation: "risky", protectedBranches: ["main", "master"], allowBroadStage: false },
    profiles: { enabled: [profile] },
  };
}

export function validateConfig(config: ProjectWorkflowConfig): string[] {
  const errors: string[] = [];
  if (config.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (config.package?.name !== "pi-coding-workflow") errors.push("package.name must be pi-coding-workflow");
  if (!( ["generic", "unity"] as const).includes(config.project?.profile)) errors.push("project.profile must be generic or unity");
  if (config.project?.root !== ".") errors.push("project.root must be . in v1");
  if (config.workflow?.runtimeDir !== ".workflow/.runtime") errors.push("workflow.runtimeDir must be .workflow/.runtime in v1");
  if (config.git?.allowBroadStage !== false) errors.push("git.allowBroadStage must be false");
  for (const profile of config.profiles?.enabled ?? []) {
    if (!["generic", "unity"].includes(profile)) errors.push(`unsupported profile: ${profile}`);
  }
  return errors;
}

export async function readConfig(root: string): Promise<ProjectWorkflowConfig | null> {
  const path = resolveInsideRoot(root, ".workflow/config.json");
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8")) as ProjectWorkflowConfig;
}

export async function writeConfig(root: string, config: ProjectWorkflowConfig): Promise<void> {
  const path = resolveInsideRoot(root, ".workflow/config.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
