import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { WorkflowBlocker, WorkflowWarning } from "../types.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";
import type { WorkflowTaskJson } from "./task.ts";

export interface TaskValidationResult {
  passed: boolean;
  blockedBy: WorkflowBlocker[];
  warnings: WorkflowWarning[];
}

export async function validateTask(root: string, task: WorkflowTaskJson, phase: "start" | "finish" | "checkpoint" = "checkpoint"): Promise<TaskValidationResult> {
  const blockedBy: WorkflowBlocker[] = [];
  const warnings: WorkflowWarning[] = [];
  const taskDir = `.workflow/tasks/${task.id}`;
  const taskJson = resolveInsideRoot(root, `${taskDir}/task.json`);
  const prdPath = resolveInsideRoot(root, `${taskDir}/prd.md`);

  if (!existsSync(taskJson)) blockedBy.push({ code: "task_json_missing", message: `${taskDir}/task.json is missing.`, severity: "blocking", path: `${taskDir}/task.json` });
  if (!existsSync(prdPath)) blockedBy.push({ code: "prd_missing", message: `${taskDir}/prd.md is missing.`, severity: "blocking", path: `${taskDir}/prd.md` });

  if (phase === "start") {
    if (task.status !== "planning") blockedBy.push({ code: "task_not_planning", message: `start_checked requires planning status, got ${task.status}.`, severity: "blocking", path: `${taskDir}/task.json` });
    if (task.stage !== "grill") warnings.push({ code: "stage_not_grill", message: `start_checked expected stage=grill, got ${task.stage}.`, path: `${taskDir}/task.json` });
  }

  if (phase === "finish") {
    if (task.status !== "in_progress") blockedBy.push({ code: "task_not_in_progress", message: `finish_run requires in_progress status, got ${task.status}.`, severity: "blocking", path: `${taskDir}/task.json` });
    if (task.stage !== "execute") warnings.push({ code: "stage_not_execute", message: `finish_run expected stage=execute, got ${task.stage}.`, path: `${taskDir}/task.json` });
  }

  if (existsSync(prdPath)) {
    const prd = await readFile(prdPath, "utf8");
    if (/Open Questions\s*\n\s*(?!None|无|无阻塞)/i.test(prd)) {
      warnings.push({ code: "open_questions_maybe_present", message: "PRD appears to contain non-empty Open Questions; verify before mutating stage.", path: `${taskDir}/prd.md` });
    }
    if (/TODO\b|TODO\(|待定/.test(prd)) {
      warnings.push({ code: "prd_todo_present", message: "PRD still contains TODO markers; package v1 warns but does not block.", path: `${taskDir}/prd.md` });
    }
  }

  return { passed: blockedBy.length === 0, blockedBy, warnings };
}
