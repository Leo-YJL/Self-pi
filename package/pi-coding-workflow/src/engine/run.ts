import type { WorkflowRunInput, WorkflowRunOutput } from "../types.ts";
import { createTask, findActiveTask, readTask, slugify, todayPrefix, writeTask, type WorkflowTaskJson } from "./task.ts";
import { checkpoint } from "./checkpoint.ts";
import { validateTask } from "./validate.ts";

export async function workflowRun(root: string, input: WorkflowRunInput): Promise<WorkflowRunOutput> {
  const mode = input.mode ?? "dry_run";
  const action = input.action;
  if (!action) throw new Error("workflow_run requires action");

  if (action === "create_from_grill") {
    if (!input.title || !input.level) return blocked(action, mode, "missing_title_or_level", "create_from_grill requires title and level.");
    const plannedTask = `${todayPrefix()}-${input.slug ?? slugify(input.title)}`;
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run create_from_grill; would create task ${plannedTask}.`), task: plannedTask, status: "planning", stage: "grill" };
    const task = await createTask(root, input.title, input.level, input.slug);
    return { ...ok(action, mode, true, `Created task ${task.id}`), task: task.id, status: task.status, stage: task.stage };
  }

  if (action === "create_child") {
    if (!input.title || !input.level || !input.parentTask) return blocked(action, mode, "missing_child_fields", "create_child requires title, level and parentTask.");
    const plannedTask = `${todayPrefix()}-${input.slug ?? slugify(input.title)}`;
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run create_child; would create child task ${plannedTask}.`), task: plannedTask, status: "planning", stage: "grill" };
    const task = await createTask(root, input.title, input.level, input.slug, input.parentTask);
    return { ...ok(action, mode, true, `Created child task ${task.id}`), task: task.id, status: task.status, stage: task.stage };
  }

  if (action === "start_checked") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "start_checked requires task or an active planning task.");
    const validation = await validateTask(root, task, "start");
    if (!validation.passed) return { ...blocked(action, mode, "start_validation_failed", "start_checked validation failed."), blockedBy: validation.blockedBy, warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage };
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run start_checked; task ${task.id} can start.`), warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage };
    task.status = "in_progress";
    task.stage = "execute";
    await writeTask(root, task);
    return { ...ok(action, mode, true, `Started task ${task.id}`), warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage };
  }

  if (action === "checkpoint") {
    const task = await resolveTask(root, input.task);
    const validation = task ? await validateTask(root, task, "checkpoint") : { passed: true, blockedBy: [], warnings: [] };
    if (!validation.passed) return { ...blocked(action, mode, "checkpoint_validation_failed", "checkpoint validation failed."), blockedBy: validation.blockedBy, warnings: validation.warnings, task: task?.id };
    const result = await checkpoint(root, input.phase, input.notes);
    return { ok: result.passed, mutated: false, action, mode, task: task?.id, blockedBy: [], warnings: validation.warnings, summary: result.summary, artifactRef: result.artifactRef, nextAction: result.passed ? "continue" : "fix" };
  }

  if (action === "finish_run") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "finish_run requires task or an active in-progress task.");
    if (!input.message) return blocked(action, mode, "missing_message", "finish_run requires message.");
    const validation = await validateTask(root, task, "finish");
    if (!validation.passed) return { ...blocked(action, mode, "finish_validation_failed", "finish_run validation failed."), blockedBy: validation.blockedBy, warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage };
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run finish_run; task ${task.id} can be marked completed. Git commit/push is not performed by package v1.`), warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage };
    task.status = "completed";
    task.stage = "finish";
    await writeTask(root, task);
    return { ...ok(action, mode, true, `Finished task ${task.id}; Git commit/push is not performed by package v1.`), warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage, git: { committed: false, pushed: false } };
  }

  if (action === "archive") {
    if (!input.userConfirmed) return blocked(action, mode, "user_confirmation_required", "archive requires userConfirmed=true.");
    return ok(action, mode, false, "Archive is reserved for project-specific policy in v1.");
  }

  return blocked(action, mode, "unknown_action", `Unknown action: ${action}`);
}

async function resolveTask(root: string, id?: string): Promise<WorkflowTaskJson | null> {
  if (id) return readTask(root, id);
  return findActiveTask(root);
}

function ok(action: WorkflowRunInput["action"], mode: "dry_run" | "execute", mutated: boolean, summary: string): WorkflowRunOutput {
  return { ok: true, mutated, action, mode, blockedBy: [], warnings: [], summary };
}

function blocked(action: WorkflowRunInput["action"], mode: "dry_run" | "execute", code: string, message: string): WorkflowRunOutput {
  return { ok: false, mutated: false, action, mode, blockedBy: [{ code, message, severity: "blocking" }], warnings: [], summary: message };
}
