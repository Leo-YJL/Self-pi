import { randomBytes } from "node:crypto";
import type { WorkflowRecommendedCall, WorkflowRollbackHint, WorkflowRunBatchItem, WorkflowRunInput, WorkflowRunOutput, WorkflowTransaction } from "../types.ts";
import { createTask, findActiveTask, readTask, slugify, todayPrefix, writeTask, type WorkflowTaskJson } from "./task.ts";
import { checkpoint } from "./checkpoint.ts";
import { validateTask } from "./validate.ts";
import { estimateTokens, RUN_RESULT_TARGET_TOKENS } from "./contextBudget.ts";
import { writeJsonArtifact } from "../artifacts/writeToolResult.ts";
import { writeWorkflowTelemetry } from "./telemetry.ts";

export async function workflowRun(root: string, input: WorkflowRunInput): Promise<WorkflowRunOutput> {
  const startedAt = Date.now();
  const result = decorateRunOutput(await workflowRunInternal(root, input, 0), startedAt);
  await writeWorkflowTelemetry(root, "workflow_run", result);
  return result;
}

async function workflowRunInternal(root: string, input: WorkflowRunInput, depth: number): Promise<WorkflowRunOutput> {
  const mode = input.mode ?? "dry_run";
  const action = input.action;
  if (!action) throw new Error("workflow_run requires action");

  if (action === "batch") {
    if (depth > 0) return blocked(action, mode, "nested_batch_not_supported", "workflow_run batch cannot contain another batch action.");
    if (!input.actions?.length) return blocked(action, mode, "missing_actions", "workflow_run batch requires a non-empty actions array.");

    const transactionId = makeTransactionId();
    const plannedActions = input.actions.map((item, index) => plannedAction(item, input, mode, index));
    const results: WorkflowRunOutput[] = [];
    const rollbackHints: WorkflowRollbackHint[] = [];
    let mutated = false;

    for (const [index, item] of input.actions.entries()) {
      if ((item as { action?: string }).action === "batch") return blocked(action, mode, "nested_batch_not_supported", "workflow_run batch cannot contain another batch action.");
      const childInput = {
        ...item,
        action: item.action,
        mode: mode === "dry_run" ? "dry_run" : item.mode ?? "execute",
        task: item.task ?? input.task,
      } as WorkflowRunInput;
      const beforeTask = childInput.mode === "execute" ? await taskSnapshotForRollback(root, childInput) : null;
      const childStartedAt = Date.now();
      const child = decorateRunOutput(await workflowRunInternal(root, childInput, depth + 1), childStartedAt);
      results.push(child);
      mutated = mutated || child.mutated;
      rollbackHints.push(...rollbackHintsFor(index, childInput, child, beforeTask));
      if (!child.ok) {
        return finishBatch(root, {
          ok: false,
          mode,
          transactionId,
          plannedActions,
          results,
          rollbackHints,
          mutated,
          task: child.task ?? input.task,
          status: child.status,
          stage: child.stage,
          blockedBy: child.blockedBy,
          warnings: child.warnings,
          summary: `Batch stopped at action ${results.length}/${input.actions.length} (${item.action}): ${child.summary}`,
          nextAction: child.nextAction ?? "fix",
        });
      }
    }

    const last = results.at(-1);
    return finishBatch(root, {
      ok: true,
      mode,
      transactionId,
      plannedActions,
      results,
      rollbackHints,
      mutated,
      task: last?.task ?? input.task,
      status: last?.status,
      stage: last?.stage,
      blockedBy: [],
      warnings: results.flatMap((result) => result.warnings),
      summary: mode === "execute" ? `Batch transaction ${transactionId} executed ${results.length} action(s).` : `Batch dry-run planned ${results.length} action(s).`,
      nextAction: last?.nextAction ?? "continue",
    });
  }

  if (action === "create_from_grill") {
    if (!input.title || !input.level) return blocked(action, mode, "missing_title_or_level", "create_from_grill requires title and level.");
    const plannedTask = `${todayPrefix()}-${input.slug ?? slugify(input.title)}`;
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run create_from_grill; would create task ${plannedTask}.`), task: plannedTask, status: "planning", stage: "grill", nextAction: "execute_create_from_grill" };
    const task = await createTask(root, input.title, input.level, input.slug);
    return { ...ok(action, mode, true, `Created task ${task.id}`), task: task.id, status: task.status, stage: task.stage, nextAction: "write_prd_and_manifests" };
  }

  if (action === "create_child") {
    if (!input.title || !input.level || !input.parentTask) return blocked(action, mode, "missing_child_fields", "create_child requires title, level and parentTask.");
    const plannedTask = `${todayPrefix()}-${input.slug ?? slugify(input.title)}`;
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run create_child; would create child task ${plannedTask}.`), task: plannedTask, status: "planning", stage: "grill", nextAction: "execute_create_child" };
    const task = await createTask(root, input.title, input.level, input.slug, input.parentTask);
    return { ...ok(action, mode, true, `Created child task ${task.id}`), task: task.id, status: task.status, stage: task.stage, nextAction: "write_child_prd_and_manifests" };
  }

  if (action === "start_checked") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "start_checked requires task or an active planning task.");
    const validation = await validateTask(root, task, "start");
    if (!validation.passed) return { ...blocked(action, mode, "start_validation_failed", "start_checked validation failed."), blockedBy: validation.blockedBy, warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage, preflight: validation.details, nextAction: "fix_start_blockers" };
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run start_checked; task ${task.id} can start.`), warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage, preflight: validation.details, nextAction: "execute_start_checked" };
    task.status = "in_progress";
    task.stage = "execute";
    await writeTask(root, task);
    return { ...ok(action, mode, true, `Started task ${task.id}`), warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage, preflight: validation.details, nextAction: "implement_slice" };
  }

  if (action === "checkpoint") {
    const task = await resolveTask(root, input.task);
    const validation = task ? await validateTask(root, task, "checkpoint") : { passed: true, blockedBy: [], warnings: [], details: undefined };
    if (!validation.passed) return { ...blocked(action, mode, "checkpoint_validation_failed", "checkpoint validation failed."), blockedBy: validation.blockedBy, warnings: validation.warnings, task: task?.id, preflight: validation.details, nextAction: "fix_checkpoint_blockers" };
    const result = await checkpoint(root, input.phase, input.notes);
    return {
      ok: result.passed,
      mutated: false,
      action,
      mode,
      task: task?.id,
      blockedBy: [],
      warnings: validation.warnings,
      summary: result.summary,
      artifactRef: result.artifactRef,
      artifacts: [{ kind: "checkpoint", ref: result.artifactRef, summary: result.summary }],
      checkpointId: result.artifactRef,
      nextAction: result.passed ? "continue" : "fix",
      preflight: validation.details,
    };
  }

  if (action === "finish_run") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "finish_run requires task or an active in-progress task.");
    if (mode === "execute" && !input.message) return blocked(action, mode, "missing_message", "finish_run execute requires message.");
    const validation = await validateTask(root, task, "finish");
    if (!validation.passed) return { ...blocked(action, mode, "finish_validation_failed", "finish_run validation failed."), blockedBy: validation.blockedBy, warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage, preflight: validation.details, nextAction: "fix_finish_blockers" };
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run finish_run; task ${task.id} can be marked completed. Git commit/push is not performed by package v1.`), warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage, preflight: validation.details, nextAction: "execute_finish_run" };
    task.status = "completed";
    task.stage = "finish";
    await writeTask(root, task);
    return { ...ok(action, mode, true, `Finished task ${task.id}; Git commit/push is not performed by package v1.`), warnings: validation.warnings, task: task.id, status: task.status, stage: task.stage, preflight: validation.details, git: { committed: false, pushed: false }, nextAction: "archive_or_new_task" };
  }

  if (action === "archive") {
    if (!input.userConfirmed) return blocked(action, mode, "user_confirmation_required", "archive requires userConfirmed=true.");
    return { ...ok(action, mode, false, "Archive is reserved for project-specific policy in v1."), nextAction: "none" };
  }

  return blocked(action, mode, "unknown_action", `Unknown action: ${action}`);
}

interface FinishBatchOptions {
  ok: boolean;
  mode: "dry_run" | "execute";
  transactionId: string;
  plannedActions: WorkflowTransaction["plannedActions"];
  results: WorkflowRunOutput[];
  rollbackHints: WorkflowRollbackHint[];
  mutated: boolean;
  task?: string;
  status?: WorkflowRunOutput["status"];
  stage?: WorkflowRunOutput["stage"];
  blockedBy: WorkflowRunOutput["blockedBy"];
  warnings: WorkflowRunOutput["warnings"];
  summary: string;
  nextAction: string;
}

async function finishBatch(root: string, options: FinishBatchOptions): Promise<WorkflowRunOutput> {
  const transaction: WorkflowTransaction = {
    id: options.transactionId,
    mode: options.mode,
    state: options.mode === "dry_run" ? "planned" : options.ok ? "committed" : options.mutated ? "partial" : "failed",
    plannedActions: options.plannedActions,
    rollbackHints: options.rollbackHints,
    artifactRef: undefined,
  };
  const artifacts = [];

  if (options.mode === "execute" || options.mutated) {
    const artifact = await writeJsonArtifact(root, "transactions", {
      transaction,
      results: options.results.map((result) => ({
        ok: result.ok,
        action: result.action,
        mode: result.mode,
        task: result.task,
        status: result.status,
        stage: result.stage,
        summary: result.summary,
        blockedBy: result.blockedBy,
        warnings: result.warnings,
        artifactRef: result.artifactRef,
      })),
      createdAt: new Date().toISOString(),
    }, options.transactionId);
    transaction.artifactRef = artifact.artifactRef;
    artifacts.push({ kind: "transaction", ref: artifact.artifactRef, summary: `Batch transaction ${transaction.state}` });
  }

  return {
    ok: options.ok,
    mutated: options.mutated,
    action: "batch",
    mode: options.mode,
    task: options.task,
    status: options.status,
    stage: options.stage,
    blockedBy: options.blockedBy,
    warnings: options.warnings,
    summary: options.summary,
    results: options.results,
    transaction,
    rollbackHints: options.rollbackHints,
    artifacts,
    nextAction: options.nextAction,
  };
}

function makeTransactionId(): string {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}`;
  return `workflow-tx-${stamp}-${randomBytes(3).toString("hex")}`;
}

function plannedAction(item: WorkflowRunBatchItem, input: WorkflowRunInput, mode: "dry_run" | "execute", index: number): WorkflowTransaction["plannedActions"][number] {
  return {
    index,
    action: item.action,
    mode: mode === "dry_run" ? "dry_run" : item.mode ?? "execute",
    task: item.task ?? input.task,
    title: item.title,
    summary: item.action === "create_from_grill" || item.action === "create_child" ? `Plan ${item.action}: ${item.title ?? "untitled"}` : `Plan ${item.action}`,
  };
}

async function taskSnapshotForRollback(root: string, input: WorkflowRunInput): Promise<WorkflowTaskJson | null> {
  try {
    if (input.task) return await readTask(root, input.task);
    if (input.action === "start_checked" || input.action === "finish_run") return await findActiveTask(root);
  } catch {
    return null;
  }
  return null;
}

function rollbackHintsFor(index: number, input: WorkflowRunInput, output: WorkflowRunOutput, beforeTask: WorkflowTaskJson | null): WorkflowRollbackHint[] {
  if (!output.mutated) return [];
  if ((input.action === "create_from_grill" || input.action === "create_child") && output.task) {
    return [{
      actionIndex: index,
      action: input.action,
      kind: "remove_created_task",
      path: `.workflow/tasks/${output.task}`,
      summary: `Remove .workflow/tasks/${output.task} if this created task should be rolled back.`,
    }];
  }
  if ((input.action === "start_checked" || input.action === "finish_run") && beforeTask) {
    return [{
      actionIndex: index,
      action: input.action,
      kind: "restore_task_json",
      path: `.workflow/tasks/${beforeTask.id}/task.json`,
      summary: `Restore task ${beforeTask.id} to ${beforeTask.status}/${beforeTask.stage}.`,
      data: { status: beforeTask.status, stage: beforeTask.stage, updatedAt: beforeTask.updatedAt },
    }];
  }
  return [];
}

async function resolveTask(root: string, id?: string): Promise<WorkflowTaskJson | null> {
  if (id) return readTask(root, id);
  return findActiveTask(root);
}

function decorateRunOutput(output: WorkflowRunOutput, startedAt: number): WorkflowRunOutput {
  const artifacts = output.artifacts ?? (output.artifactRef ? [{ kind: output.action === "checkpoint" ? "checkpoint" : "artifact", ref: output.artifactRef, summary: output.summary }] : undefined);
  const compactForBudget = {
    ok: output.ok,
    mutated: output.mutated,
    action: output.action,
    mode: output.mode,
    task: output.task,
    status: output.status,
    stage: output.stage,
    nextAction: output.nextAction,
    blockedBy: output.blockedBy,
    warnings: output.warnings,
    summary: output.summary,
    artifacts,
    results: output.results?.map((result) => ({ ok: result.ok, action: result.action, task: result.task, nextAction: result.nextAction, summary: result.summary })),
    transaction: output.transaction ? { id: output.transaction.id, state: output.transaction.state, plannedActions: output.transaction.plannedActions.length, rollbackHints: output.transaction.rollbackHints.length } : undefined,
  };
  return {
    ...output,
    artifacts,
    checkpointId: output.checkpointId ?? (output.action === "checkpoint" ? output.artifactRef : undefined),
    nextRecommendedCall: output.nextRecommendedCall ?? recommendedAfterRun(output),
    meta: {
      estimatedTokens: estimateTokens(compactForBudget),
      targetTokens: RUN_RESULT_TARGET_TOKENS,
      maxRecommendedTokens: RUN_RESULT_TARGET_TOKENS,
      truncatedBytes: 0,
      omittedRefs: artifacts?.map((artifact) => artifact.ref) ?? [],
      durationMs: Date.now() - startedAt,
      cacheHit: false,
      ...output.meta,
    },
  };
}

function recommendedAfterRun(output: WorkflowRunOutput): WorkflowRecommendedCall {
  if (output.action === "batch" && output.results?.length) {
    return recommendedAfterRun(output.results.at(-1)!);
  }

  const args: Record<string, unknown> = { includeContext: "lite" };
  if (output.task) args.task = output.task;
  if (output.action === "finish_run" || output.nextAction?.includes("finish")) args.agent = "finish";
  if (output.action === "checkpoint" && output.nextAction === "fix") args.agent = "check";
  return { name: "workflow_next", arguments: args };
}

function ok(action: WorkflowRunInput["action"], mode: "dry_run" | "execute", mutated: boolean, summary: string): WorkflowRunOutput {
  return { ok: true, mutated, action, mode, blockedBy: [], warnings: [], summary };
}

function blocked(action: WorkflowRunInput["action"], mode: "dry_run" | "execute", code: string, message: string): WorkflowRunOutput {
  return { ok: false, mutated: false, action, mode, blockedBy: [{ code, message, severity: "blocking" }], warnings: [], summary: message, nextAction: "fix" };
}
