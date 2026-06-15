import type { WorkflowBlocker, WorkflowWarning } from "../types.ts";
import { manifestIssuesToBlockers, type WorkflowManifestSummary } from "./manifest.ts";
import type { PrdKernel } from "./prd.ts";
import { grillPrdGateBlockers, grillStartBlockers } from "./grill.ts";
import type { WorkflowTaskJson } from "./task.ts";
import type { WorkspaceSummary } from "./workspace.ts";

export function computeStartBlockers(
  task: WorkflowTaskJson,
  prd: PrdKernel,
  manifests: Record<"implement" | "check", WorkflowManifestSummary>,
): WorkflowBlocker[] {
  const blockedBy: WorkflowBlocker[] = [];
  const taskDir = `.workflow/tasks/${task.id}`;

  if (task.status !== "planning") blockedBy.push({ code: "task_not_planning", message: `start_checked requires planning status, got ${task.status}.`, severity: "blocking", path: `${taskDir}/task.json` });
  if (task.stage !== "grill") blockedBy.push({ code: "stage_not_grill", message: `start_checked requires stage=grill, got ${task.stage}.`, severity: "blocking", path: `${taskDir}/task.json` });
  blockedBy.push(...grillStartBlockers(task));

  if (prd.source.exists) {
    if (prd.quality.hasTodo) blockedBy.push({ code: "prd_todo_present", message: "PRD contains TODO/TBD markers; resolve them before start_checked.", severity: "blocking", path: prd.source.path });
    if (prd.openQuestions.blocking) blockedBy.push({ code: "prd_open_questions_blocking", message: `PRD has blocking open questions: ${prd.openQuestions.summary}`, severity: "blocking", path: prd.source.path });
    if (!prd.finalConfirmation.confirmed) blockedBy.push({ code: "prd_final_confirmation_missing", message: "PRD final confirmation is missing or not confirmed.", severity: "blocking", path: prd.source.path });
    blockedBy.push(...grillPrdGateBlockers(task, prd));
  }

  blockedBy.push(...manifestIssuesToBlockers(manifests.implement), ...manifestIssuesToBlockers(manifests.check));
  return blockedBy;
}

export function computeStartWarnings(workspace: WorkspaceSummary): WorkflowWarning[] {
  if (workspace.isGit && workspace.unrelatedCount > 0) {
    return [{ code: "workspace_unrelated_dirty", message: `${workspace.unrelatedCount} dirty files are outside manifest/task scope; verify they are intentional before starting.` }];
  }
  return [];
}
