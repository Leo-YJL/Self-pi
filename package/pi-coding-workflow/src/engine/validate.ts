import { existsSync } from "node:fs";
import type { FlowLevel, WorkflowBlocker, WorkflowWarning } from "../types.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";
import type { WorkflowTaskJson } from "./task.ts";
import { evaluatePrdChecklistGate, prdGateToBlocker, readPrdKernel, type PrdKernel } from "./prd.ts";
import { manifestFiles, manifestIssuesToBlockers, readTaskManifests, type WorkflowManifestSummary } from "./manifest.ts";
import { readWorkspaceSummary, runGitDiffCheck, type GitDiffCheckResult, type WorkspaceSummary } from "./workspace.ts";
import { grillStartBlockers } from "./grill.ts";

export interface TaskValidationResult {
  passed: boolean;
  blockedBy: WorkflowBlocker[];
  warnings: WorkflowWarning[];
  details?: TaskValidationDetails;
}

export interface TaskValidationDetails {
  phase: "start" | "finish" | "checkpoint";
  prd?: PrdKernel;
  manifests?: Record<"implement" | "check", WorkflowManifestSummary>;
  workspace?: WorkspaceSummary;
  gitDiffCheck?: GitDiffCheckResult;
  checklistGates?: Array<ReturnType<typeof evaluatePrdChecklistGate>>;
}

const FLOW_LEVELS = new Set<FlowLevel>(["simple", "standard", "complex", "goal"]);

export async function validateTask(root: string, task: WorkflowTaskJson, phase: "start" | "finish" | "checkpoint" = "checkpoint"): Promise<TaskValidationResult> {
  const blockedBy: WorkflowBlocker[] = [];
  const warnings: WorkflowWarning[] = [];
  const taskDir = `.workflow/tasks/${task.id}`;
  const taskJson = resolveInsideRoot(root, `${taskDir}/task.json`);
  const prd = await readPrdKernel(root, task, phase === "checkpoint" ? "compact" : "brief");
  const details: TaskValidationDetails = { phase, prd };

  if (!existsSync(taskJson)) blockedBy.push({ code: "task_json_missing", message: `${taskDir}/task.json is missing.`, severity: "blocking", path: `${taskDir}/task.json` });
  if (!prd.source.exists) blockedBy.push({ code: "prd_missing", message: `${taskDir}/prd.md is missing.`, severity: "blocking", path: `${taskDir}/prd.md` });
  if (!FLOW_LEVELS.has(task.flowLevel)) blockedBy.push({ code: "flow_level_missing", message: `Task flowLevel must be one of ${[...FLOW_LEVELS].join(", ")}.`, severity: "blocking", path: `${taskDir}/task.json` });

  if (phase === "start") {
    await validateStart(root, task, prd, blockedBy, warnings, details);
  } else if (phase === "finish") {
    await validateFinish(root, task, prd, blockedBy, warnings, details);
  } else {
    validateCheckpoint(task, prd, warnings);
  }

  return { passed: blockedBy.length === 0, blockedBy, warnings, details };
}

async function validateStart(
  root: string,
  task: WorkflowTaskJson,
  prd: PrdKernel,
  blockedBy: WorkflowBlocker[],
  warnings: WorkflowWarning[],
  details: TaskValidationDetails,
): Promise<void> {
  const taskDir = `.workflow/tasks/${task.id}`;
  if (task.status !== "planning") blockedBy.push({ code: "task_not_planning", message: `start_checked requires planning status, got ${task.status}.`, severity: "blocking", path: `${taskDir}/task.json` });
  if (task.stage !== "grill") blockedBy.push({ code: "stage_not_grill", message: `start_checked requires stage=grill, got ${task.stage}.`, severity: "blocking", path: `${taskDir}/task.json` });
  blockedBy.push(...grillStartBlockers(task));

  if (prd.source.exists) {
    if (prd.quality.hasTodo) blockedBy.push({ code: "prd_todo_present", message: "PRD contains TODO/TBD markers; resolve them before start_checked.", severity: "blocking", path: prd.source.path });
    if (prd.openQuestions.blocking) blockedBy.push({ code: "prd_open_questions_blocking", message: `PRD has blocking open questions: ${prd.openQuestions.summary}`, severity: "blocking", path: prd.source.path });
    if (!prd.finalConfirmation.confirmed) blockedBy.push({ code: "prd_final_confirmation_missing", message: "PRD final confirmation is missing or not confirmed.", severity: "blocking", path: prd.source.path });
  }

  const manifests = await readTaskManifests(root, task);
  details.manifests = manifests;
  blockedBy.push(...manifestIssuesToBlockers(manifests.implement), ...manifestIssuesToBlockers(manifests.check));

  const workspace = await readWorkspaceSummary(root, { inScopeFiles: manifestFiles(manifests), taskId: task.id });
  details.workspace = workspace;
  if (workspace.isGit && workspace.unrelatedCount > 0) {
    warnings.push({ code: "workspace_unrelated_dirty", message: `${workspace.unrelatedCount} dirty files are outside manifest/task scope; verify they are intentional before starting.` });
  }
}

async function validateFinish(
  root: string,
  task: WorkflowTaskJson,
  prd: PrdKernel,
  blockedBy: WorkflowBlocker[],
  warnings: WorkflowWarning[],
  details: TaskValidationDetails,
): Promise<void> {
  const taskDir = `.workflow/tasks/${task.id}`;
  if (task.status !== "in_progress") blockedBy.push({ code: "task_not_in_progress", message: `finish_run requires in_progress status, got ${task.status}.`, severity: "blocking", path: `${taskDir}/task.json` });
  if (task.stage !== "execute") blockedBy.push({ code: "stage_not_execute", message: `finish_run requires stage=execute, got ${task.stage}.`, severity: "blocking", path: `${taskDir}/task.json` });

  if (prd.source.exists) {
    if (prd.openQuestions.blocking) blockedBy.push({ code: "prd_open_questions_blocking", message: `PRD still has blocking open questions: ${prd.openQuestions.summary}`, severity: "blocking", path: prd.source.path });
    const checklistGates = [
      evaluatePrdChecklistGate(prd, "acceptanceCriteria", { requireChecklist: true, allowNA: true }),
      evaluatePrdChecklistGate(prd, "validationPlan", { requireChecklist: true, allowNA: true, allowLimitation: true }),
      evaluatePrdChecklistGate(prd, "definitionOfDone", { requireChecklist: true, allowNA: true }),
    ];
    details.checklistGates = checklistGates;
    for (const gate of checklistGates) {
      const blocker = prdGateToBlocker(gate);
      if (blocker) blockedBy.push(blocker);
    }
  }

  const manifests = await readTaskManifests(root, task);
  details.manifests = manifests;
  const workspace = await readWorkspaceSummary(root, { inScopeFiles: manifestFiles(manifests), taskId: task.id });
  details.workspace = workspace;
  if (workspace.isGit && workspace.unrelatedCount > 0) {
    warnings.push({ code: "workspace_unrelated_dirty", message: `${workspace.unrelatedCount} dirty files are outside manifest/task scope; finish_run will not stage/commit them.` });
  }

  const gitDiffCheck = await runGitDiffCheck(root);
  details.gitDiffCheck = gitDiffCheck;
  if (!gitDiffCheck.passed) {
    blockedBy.push({ code: "git_diff_check_failed", message: gitDiffCheck.error ? `${gitDiffCheck.summary}: ${gitDiffCheck.error}` : gitDiffCheck.summary, severity: "blocking" });
  }
}

function validateCheckpoint(task: WorkflowTaskJson, prd: PrdKernel, warnings: WorkflowWarning[]): void {
  if (task.stage === "grill" && task.status === "planning") {
    warnings.push({ code: "checkpoint_before_start", message: "checkpoint is usually expected after start_checked, but task is still planning/grill.", path: `.workflow/tasks/${task.id}/task.json` });
  }
  if (prd.source.exists) {
    if (prd.openQuestions.blocking) warnings.push({ code: "open_questions_maybe_present", message: `PRD contains open questions: ${prd.openQuestions.summary}`, path: prd.source.path });
    if (prd.quality.hasTodo) warnings.push({ code: "prd_todo_present", message: "PRD still contains TODO/TBD markers.", path: prd.source.path });
  }
}
