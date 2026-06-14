import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { WorkflowRecommendedCall, WorkflowRollbackHint, WorkflowRunBatchItem, WorkflowRunInput, WorkflowRunOutput, WorkflowTransaction } from "../types.ts";
import { createTask, findActiveTask, readTask, slugify, todayPrefix, writeTask, type WorkflowTaskJson } from "./task.ts";
import { checkpoint } from "./checkpoint.ts";
import { validateTask } from "./validate.ts";
import { estimateTokens, RUN_RESULT_TARGET_TOKENS } from "./contextBudget.ts";
import { writeJsonArtifact } from "../artifacts/writeToolResult.ts";
import { writeWorkflowTelemetry } from "./telemetry.ts";
import { appendGrillDecision, finalizeGrillState, refreshGrillPrdCoverage, validateGrillFinalization } from "./grill.ts";
import { appendPrdDecisionLog, readPrdKernel, updatePrdSection, type PrdSectionKey } from "./prd.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";

const PRD_SECTION_KEYS = new Set<PrdSectionKey>(["executionContract", "goal", "requirements", "acceptanceCriteria", "validationPlan", "openQuestions", "finalConfirmation", "outOfScope", "definitionOfDone", "grillResult", "architectureImpact"]);

export async function workflowRun(root: string, input: WorkflowRunInput): Promise<WorkflowRunOutput> {
  const startedAt = Date.now();
  const raw = await workflowRunInternal(root, input, 0);
  const result = decorateRunOutput(await applyRunDetail(root, raw, input), startedAt);
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
    const batchDecisionRoundId = input.roundId ?? `batch-${transactionId}`;
    const batchDecisionCount = input.actions.filter((item) => item.action === "record_grill_decision").length;
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
        detail: item.detail ?? input.detail ?? "lite",
        roundId: item.roundId ?? (item.action === "record_grill_decision" ? batchDecisionRoundId : input.roundId),
        roundKind: item.roundKind ?? input.roundKind,
        questionCount: item.questionCount ?? (item.action === "record_grill_decision" && batchDecisionCount > 0 ? batchDecisionCount : input.questionCount),
      } as WorkflowRunInput;
      const beforeTask = childInput.mode === "execute" ? await taskSnapshotForRollback(root, childInput) : null;
      const childStartedAt = Date.now();
      const childRaw = await workflowRunInternal(root, childInput, depth + 1);
      const child = decorateRunOutput(await applyRunDetail(root, childRaw, childInput), childStartedAt);
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
          detail: input.detail ?? "lite",
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
      detail: input.detail ?? "lite",
    });
  }

  if (action === "create_from_grill") {
    if (!input.title || !input.level) return blocked(action, mode, "missing_title_or_level", "create_from_grill requires title and level.");
    const plannedTask = `${todayPrefix()}-${input.slug ?? slugify(input.title)}`;
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run create_from_grill; would create task ${plannedTask}.`), task: plannedTask, status: "planning", stage: "grill", nextAction: "execute_create_from_grill" };
    const task = await createTask(root, input.title, input.level, input.slug);
    return { ...ok(action, mode, true, `Created task ${task.id}`), task: task.id, status: task.status, stage: task.stage, nextAction: "write_prd_manifests_and_grill_decisions" };
  }

  if (action === "create_child") {
    if (!input.title || !input.level || !input.parentTask) return blocked(action, mode, "missing_child_fields", "create_child requires title, level and parentTask.");
    const plannedTask = `${todayPrefix()}-${input.slug ?? slugify(input.title)}`;
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run create_child; would create child task ${plannedTask}.`), task: plannedTask, status: "planning", stage: "grill", nextAction: "execute_create_child" };
    const task = await createTask(root, input.title, input.level, input.slug, input.parentTask);
    return { ...ok(action, mode, true, `Created child task ${task.id}`), task: task.id, status: task.status, stage: task.stage, nextAction: "write_child_prd_manifests_and_grill_decisions" };
  }

  if (action === "record_grill_decision") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "record_grill_decision requires task or an active planning task.");
    if (task.status !== "planning" || task.stage !== "grill") return blocked(action, mode, "task_not_planning", `record_grill_decision requires planning/grill, got ${task.status}/${task.stage}.`);
    if (!input.decisionId) return blocked(action, mode, "missing_decision_id", "record_grill_decision requires decisionId.");
    const summary = (input.decisionSummary ?? input.message ?? input.notes ?? "").trim();
    if (!summary) return blocked(action, mode, "missing_decision_summary", "record_grill_decision requires decisionSummary, message or notes.");
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run record_grill_decision; would record ${input.decisionId} for ${task.id}.`), task: task.id, status: task.status, stage: task.stage, nextAction: "execute_record_grill_decision" };
    const prdBefore = await readPrdKernel(root, task, "compact");
    const decision = appendGrillDecision(task, {
      ...input,
      prdHashBefore: prdBefore.source.confirmationHash ?? prdBefore.source.hash,
      prdDecisionIdsBefore: prdBefore.decisions.presentDecisionIds,
    });
    await writeTask(root, task);
    return { ...ok(action, mode, true, `Recorded grill decision ${decision.id} for ${task.id}.`), task: task.id, status: task.status, stage: task.stage, nextAction: "continue_grill_or_finalize" };
  }

  if (action === "record_round_and_update_prd") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "record_round_and_update_prd requires task or an active planning task.");
    if (task.status !== "planning" || task.stage !== "grill") return blocked(action, mode, "task_not_planning", `record_round_and_update_prd requires planning/grill, got ${task.status}/${task.stage}.`);
    const decisions = input.decisions ?? [];
    if (decisions.length === 0) return blocked(action, mode, "missing_decisions", "record_round_and_update_prd requires at least one decision in decisions[].");
    if (input.roundKind === "final_confirmation" || decisions.some((decision) => decision.roundKind === "final_confirmation")) {
      return blocked(action, mode, "final_confirmation_not_supported", "record_round_and_update_prd is for business grill rounds; use /workflow-prd-confirm and finalize_grill for final confirmation.");
    }
    for (const [index, decision] of decisions.entries()) {
      if (!decision.decisionId) return blocked(action, mode, "missing_decision_id", `decisions[${index}] requires decisionId.`);
      if (!(decision.decisionSummary ?? "").trim()) return blocked(action, mode, "missing_decision_summary", `decisions[${index}] requires decisionSummary.`);
    }
    const updates = input.prdUpdates ?? [];
    for (const [index, update] of updates.entries()) {
      const section = update.prdSection as PrdSectionKey | undefined;
      if (!section || !PRD_SECTION_KEYS.has(section)) return blocked(action, mode, "missing_prd_section", `prdUpdates[${index}] requires a valid prdSection.`);
      if (!(update.prdContent ?? "").trim()) return blocked(action, mode, "missing_prd_content", `prdUpdates[${index}] requires prdContent.`);
    }
    const prdPath = `.workflow/tasks/${task.id}/prd.md`;
    const absPrdPath = resolveInsideRoot(root, prdPath);
    if (!existsSync(absPrdPath)) return blocked(action, mode, "prd_missing", `${prdPath} is missing.`);
    if (mode !== "execute") {
      const appendLog = input.appendPrdDecisions !== false;
      const sectionSummary = updates.length > 0 ? ` and update ${updates.length} PRD section(s)` : "";
      const appendSummary = appendLog ? " plus append missing decision log rows" : "";
      return { ...ok(action, mode, false, `Dry-run record_round_and_update_prd; would record ${decisions.length} decision(s)${sectionSummary}${appendSummary} for ${task.id}.`), task: task.id, status: task.status, stage: task.stage, nextAction: "execute_record_round_and_update_prd" };
    }

    const markdownBefore = await readFile(absPrdPath, "utf8");
    const prdBefore = await readPrdKernel(root, task, "compact");
    const sharedRoundKind = input.roundKind ?? decisions[0]?.roundKind ?? "custom";
    const sharedRoundId = input.roundId ?? decisions[0]?.roundId ?? `round-${(task.grill?.roundLog?.length ?? 0) + 1}-${sharedRoundKind}`;
    const recordedDecisions = decisions.map((decision) => appendGrillDecision(task, {
      ...input,
      decisionId: decision.decisionId,
      decisionSummary: decision.decisionSummary,
      decisionSeverity: decision.decisionSeverity ?? input.decisionSeverity,
      decisionStatus: decision.decisionStatus ?? input.decisionStatus,
      decisionSource: decision.decisionSource ?? input.decisionSource ?? "ask_user_question",
      persistTo: decision.persistTo ?? input.persistTo,
      roundId: decision.roundId ?? sharedRoundId,
      roundKind: decision.roundKind ?? input.roundKind ?? sharedRoundKind,
      questionCount: input.questionCount ?? decisions.length,
      prdHashBefore: prdBefore.source.confirmationHash ?? prdBefore.source.hash,
      prdDecisionIdsBefore: prdBefore.decisions.presentDecisionIds,
    }));

    let nextMarkdown = markdownBefore;
    const changedSections: string[] = [];
    for (const update of updates) {
      const section = update.prdSection as PrdSectionKey;
      const updated = updatePrdSection(nextMarkdown, section, update.prdContent, update.prdUpdateMode ?? "replace");
      nextMarkdown = updated.markdown;
      if (updated.changed) changedSections.push(section);
    }

    let appendedDecisionIds: string[] = [];
    if (input.appendPrdDecisions !== false) {
      const appended = appendPrdDecisionLog(nextMarkdown, recordedDecisions);
      nextMarkdown = appended.markdown;
      appendedDecisionIds = appended.appendedDecisionIds;
    }

    const normalizedBefore = `${markdownBefore.replace(/\s+$/g, "")}\n`;
    const prdChanged = nextMarkdown !== normalizedBefore;
    if (prdChanged) await writeFile(absPrdPath, nextMarkdown, "utf8");
    const prdAfter = await readPrdKernel(root, task, "compact");
    refreshGrillPrdCoverage(task, prdAfter.decisions.presentDecisionIds, prdAfter.source.confirmationHash ?? prdAfter.source.hash);
    await writeTask(root, task);

    const parts = [
      `Recorded ${recordedDecisions.length} decision(s): ${recordedDecisions.map((decision) => decision.id).join(", ")}`,
      changedSections.length > 0 ? `updated PRD section(s): ${[...new Set(changedSections)].join(", ")}` : "no PRD section changes",
      input.appendPrdDecisions !== false ? `appended ${appendedDecisionIds.length} decision log row(s)` : "decision log append skipped",
    ];
    return { ...ok(action, mode, true, `${parts.join("; ")}.`), task: task.id, status: task.status, stage: task.stage, nextAction: "continue_grill_or_finalize" };
  }

  if (action === "update_prd_section") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "update_prd_section requires task or an active task.");
    if (task.status === "completed") return blocked(action, mode, "task_completed", "update_prd_section cannot mutate a completed task PRD.");
    const section = input.prdSection as PrdSectionKey | undefined;
    if (!section || !PRD_SECTION_KEYS.has(section)) return blocked(action, mode, "missing_prd_section", "update_prd_section requires prdSection.");
    const content = (input.prdContent ?? input.message ?? input.notes ?? "").trim();
    if (!content) return blocked(action, mode, "missing_prd_content", "update_prd_section requires prdContent, message or notes.");
    const prdPath = `.workflow/tasks/${task.id}/prd.md`;
    const absPrdPath = resolveInsideRoot(root, prdPath);
    if (!existsSync(absPrdPath)) return blocked(action, mode, "prd_missing", `${prdPath} is missing.`);
    const markdown = await readFile(absPrdPath, "utf8");
    const updated = updatePrdSection(markdown, section, content, input.prdUpdateMode ?? "replace");
    const summary = updated.changed
      ? `${input.prdUpdateMode ?? "replace"} PRD section ${section}.`
      : `PRD section ${section} already matches requested content.`;
    if (mode !== "execute") {
      return { ...ok(action, mode, false, `Dry-run ${summary}`), task: task.id, status: task.status, stage: task.stage, nextAction: updated.changed ? "execute_update_prd_section" : "continue" };
    }
    if (updated.changed) await writeFile(absPrdPath, updated.markdown, "utf8");
    return { ...ok(action, mode, updated.changed, summary), task: task.id, status: task.status, stage: task.stage, nextAction: "continue" };
  }

  if (action === "append_prd_decisions") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "append_prd_decisions requires task or an active planning task.");
    if (task.status !== "planning" || task.stage !== "grill") return blocked(action, mode, "task_not_planning", `append_prd_decisions requires planning/grill, got ${task.status}/${task.stage}.`);
    const prdPath = `.workflow/tasks/${task.id}/prd.md`;
    const absPrdPath = resolveInsideRoot(root, prdPath);
    if (!existsSync(absPrdPath)) return blocked(action, mode, "prd_missing", `${prdPath} is missing.`);
    const markdown = await readFile(absPrdPath, "utf8");
    const allDecisions = task.grill?.decisions ?? [];
    const decisions = input.roundId ? allDecisions.filter((decision) => decision.roundId === input.roundId) : allDecisions;
    const appended = appendPrdDecisionLog(markdown, decisions);
    const summary = appended.changed
      ? `Append ${appended.appendedDecisionIds.length} PRD grill decision(s): ${appended.appendedDecisionIds.join(", ")}.`
      : "No missing PRD grill decisions to append.";
    if (mode !== "execute") {
      return { ...ok(action, mode, false, `Dry-run ${summary}`), task: task.id, status: task.status, stage: task.stage, nextAction: appended.changed ? "execute_append_prd_decisions" : "continue_grill_or_finalize" };
    }
    if (appended.changed) await writeFile(absPrdPath, appended.markdown, "utf8");
    const prdAfter = await readPrdKernel(root, task, "compact");
    refreshGrillPrdCoverage(task, prdAfter.decisions.presentDecisionIds, prdAfter.source.confirmationHash ?? prdAfter.source.hash);
    await writeTask(root, task);
    return { ...ok(action, mode, appended.changed, summary), task: task.id, status: task.status, stage: task.stage, nextAction: "continue_grill_or_finalize" };
  }

  if (action === "finalize_grill") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "finalize_grill requires task or an active planning task.");
    const blockers = await validateGrillFinalization(root, task, input);
    if (blockers.length > 0) return { ...blocked(action, mode, "grill_finalization_failed", "finalize_grill validation failed."), blockedBy: blockers, task: task.id, status: task.status, stage: task.stage, nextAction: "fix_grill_blockers" };
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run finalize_grill; task ${task.id} can enter start_checked preflight.`), task: task.id, status: task.status, stage: task.stage, nextAction: "execute_finalize_grill" };
    finalizeGrillState(task, input);
    await writeTask(root, task);
    return { ...ok(action, mode, true, `Finalized Stage 1 grill for ${task.id}.`), task: task.id, status: task.status, stage: task.stage, nextAction: "start_checked" };
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
  detail?: WorkflowRunInput["detail"];
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
  const compactResults = (options.detail ?? "lite") !== "full";

  if (compactResults || options.mode === "execute" || options.mutated) {
    const artifact = await writeJsonArtifact(root, "transactions", {
      transaction,
      results: options.results,
      resultsSummary: options.results.map(compactBatchChildResult),
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
    results: compactResults ? options.results.map(compactBatchChildResult) : options.results,
    transaction,
    rollbackHints: options.rollbackHints,
    artifacts,
    nextAction: options.nextAction,
  };
}

function compactBatchChildResult(result: WorkflowRunOutput): WorkflowRunOutput {
  return {
    ok: result.ok,
    mutated: result.mutated,
    action: result.action,
    mode: result.mode,
    task: result.task,
    status: result.status,
    stage: result.stage,
    nextAction: result.nextAction,
    blockedBy: result.blockedBy,
    warnings: result.warnings,
    summary: result.summary,
    artifactRef: result.artifactRef,
    artifacts: result.artifacts,
    checkpointId: result.checkpointId,
    preflightRef: result.preflightRef,
    git: result.git,
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
    summary: item.action === "create_from_grill" || item.action === "create_child" ? `Plan ${item.action}: ${item.title ?? "untitled"}` : item.action === "record_grill_decision" ? `Plan record_grill_decision: ${item.decisionId ?? "unnamed"}` : item.action === "record_round_and_update_prd" ? `Plan record_round_and_update_prd: ${item.decisions?.length ?? 0} decision(s), ${item.prdUpdates?.length ?? 0} PRD update(s)` : `Plan ${item.action}`,
  };
}

async function taskSnapshotForRollback(root: string, input: WorkflowRunInput): Promise<WorkflowTaskJson | null> {
  try {
    if (input.task) return await readTask(root, input.task);
    if (input.action === "record_grill_decision" || input.action === "record_round_and_update_prd" || input.action === "append_prd_decisions" || input.action === "finalize_grill" || input.action === "start_checked" || input.action === "finish_run") return await findActiveTask(root);
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

  const hints: WorkflowRollbackHint[] = [];
  if ((input.action === "append_prd_decisions" || input.action === "update_prd_section" || input.action === "record_round_and_update_prd") && output.task) {
    hints.push({
      actionIndex: index,
      action: input.action,
      kind: "manual",
      path: `.workflow/tasks/${output.task}/prd.md`,
      summary: `Review git diff or transaction artifact to revert PRD changes for ${output.task}.`,
    });
  }
  if ((input.action === "record_grill_decision" || input.action === "record_round_and_update_prd" || input.action === "append_prd_decisions" || input.action === "finalize_grill" || input.action === "start_checked" || input.action === "finish_run") && beforeTask) {
    hints.push({
      actionIndex: index,
      action: input.action,
      kind: "restore_task_json",
      path: `.workflow/tasks/${beforeTask.id}/task.json`,
      summary: `Restore task ${beforeTask.id} to ${beforeTask.status}/${beforeTask.stage}.`,
      data: { status: beforeTask.status, stage: beforeTask.stage, grill: beforeTask.grill, updatedAt: beforeTask.updatedAt },
    });
  }
  return hints;
}

async function resolveTask(root: string, id?: string): Promise<WorkflowTaskJson | null> {
  if (id) return readTask(root, id);
  return findActiveTask(root);
}

async function applyRunDetail(root: string, output: WorkflowRunOutput, input: WorkflowRunInput): Promise<WorkflowRunOutput> {
  const detail = input.detail ?? "lite";
  if (detail === "full" || output.preflight === undefined) return output;

  const artifact = await writeJsonArtifact(root, "preflight", {
    kind: "pi-coding-workflow.preflight",
    schemaVersion: 1,
    action: output.action,
    mode: output.mode,
    task: output.task,
    status: output.status,
    stage: output.stage,
    ok: output.ok,
    summary: output.summary,
    blockedBy: output.blockedBy,
    warnings: output.warnings,
    preflight: output.preflight,
    createdAt: new Date().toISOString(),
  });
  const existingArtifacts = output.artifacts ?? (output.artifactRef ? [{ kind: output.action === "checkpoint" ? "checkpoint" : "artifact", ref: output.artifactRef, summary: output.summary }] : []);
  const preflightArtifact = { kind: "preflight", ref: artifact.artifactRef, summary: `${output.action} preflight details` };

  return {
    ...output,
    preflight: detail === "summary" ? summarizePreflight(output.preflight) : undefined,
    preflightRef: artifact.artifactRef,
    artifacts: [...existingArtifacts, preflightArtifact],
  };
}

function summarizePreflight(preflight: unknown): unknown {
  if (!preflight || typeof preflight !== "object") return preflight;
  const value = preflight as any;
  return {
    phase: value.phase,
    prd: value.prd ? {
      title: value.prd.title,
      source: value.prd.source,
      openQuestions: value.prd.openQuestions,
      finalConfirmation: value.prd.finalConfirmation,
      quality: value.prd.quality ? {
        hasTodo: value.prd.quality.hasTodo,
        uncheckedChecklistCount: value.prd.quality.uncheckedChecklistCount,
        blockingOpenQuestions: value.prd.quality.blockingOpenQuestions,
      } : undefined,
      summary: value.prd.summary,
    } : undefined,
    manifests: value.manifests ? {
      implement: summarizeManifest(value.manifests.implement),
      check: summarizeManifest(value.manifests.check),
    } : undefined,
    workspace: value.workspace ? {
      isGit: value.workspace.isGit,
      dirtyCount: value.workspace.dirtyCount,
      inScopeCount: value.workspace.inScopeCount,
      taskFileCount: value.workspace.taskFileCount,
      unrelatedCount: value.workspace.unrelatedCount,
      summary: value.workspace.summary,
    } : undefined,
    gitDiffCheck: value.gitDiffCheck ? {
      passed: value.gitDiffCheck.passed,
      summary: value.gitDiffCheck.summary,
      error: value.gitDiffCheck.error,
    } : undefined,
    checklistGates: Array.isArray(value.checklistGates) ? value.checklistGates.map((gate: any) => ({ key: gate.key, passed: gate.passed, code: gate.code, message: gate.message })) : undefined,
  };
}

function summarizeManifest(manifest: any): unknown {
  if (!manifest) return undefined;
  return {
    path: manifest.path,
    exists: manifest.exists,
    hash: manifest.hash,
    entryCount: Array.isArray(manifest.entries) ? manifest.entries.length : undefined,
    missingCount: Array.isArray(manifest.missingFiles) ? manifest.missingFiles.length : undefined,
    issueCount: Array.isArray(manifest.issues) ? manifest.issues.length : undefined,
    summary: manifest.summary,
  };
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
