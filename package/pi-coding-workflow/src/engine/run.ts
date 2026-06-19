import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { FlowLevel, RunInputMode, RunMode, WorkflowManifestAgent, WorkflowManifestEntryInput, WorkflowRecommendedCall, WorkflowRollbackHint, WorkflowRunBatchItem, WorkflowRunInput, WorkflowRunOutput, WorkflowTransaction } from "../types.ts";
import { createTask, findActiveTask, listArchivedTasks, listRootTasks, readTask, slugify, todayPrefix, tryReadTask, writeTask, type WorkflowTaskJson } from "./task.ts";
import { checkpoint } from "./checkpoint.ts";
import { validateTask } from "./validate.ts";
import { estimateTokens, RUN_RESULT_TARGET_TOKENS } from "./contextBudget.ts";
import { writeJsonArtifact, stableShortHash } from "../artifacts/writeToolResult.ts";
import { writeWorkflowTelemetry } from "./telemetry.ts";
import { appendGrillDecision, finalizeGrillState, refreshGrillPrdCoverage, validateGrillFinalization } from "./grill.ts";
import { appendPrdDecisionLog, readPrdKernel, updatePrdSection, type PrdSectionKey } from "./prd.ts";
import { assertRepoRelative, normalizeSlash, resolveInsideRoot } from "../safety/pathPolicy.ts";
import { readConfig } from "./config.ts";
import { initTaskManifests, removeManifestEntry, upsertManifestEntry } from "./manifest.ts";

const execFileAsync = promisify(execFile);

const PRD_SECTION_KEYS = new Set<PrdSectionKey>(["executionContract", "goal", "requirements", "acceptanceCriteria", "validationPlan", "openQuestions", "finalConfirmation", "outOfScope", "definitionOfDone", "grillResult", "architectureImpact"]);

// Actions whose execute path always runs preflight first and returns a structured blocker
// without mutating when gates fail. For these, mode="auto" resolves to "execute": gate-checked
// without requiring a separate dry_run round-trip. Non-listed actions (PRD writes, batch,
// sync_manifest_from_diff, checkpoint) keep their dry_run preview semantics; mode="auto" on
// them resolves to "dry_run" so explicit content/diff review still happens.
const AUTO_ELIGIBLE_ACTIONS = new Set<string>([
  "create_from_grill",
  "create_child",
  "init_manifests",
  "upsert_manifest_entry",
  "remove_manifest_entry",
  "finalize_grill",
  "start_checked",
  "finish_run",
  "archive",
  "reopen",
]);

function normalizeMode(action: string | undefined, requested: RunInputMode | undefined): RunMode {
  if (requested === "auto") return AUTO_ELIGIBLE_ACTIONS.has(action ?? "") ? "execute" : "dry_run";
  return requested ?? "dry_run";
}

export async function workflowRun(root: string, input: WorkflowRunInput): Promise<WorkflowRunOutput> {
  const startedAt = Date.now();
  const raw = await workflowRunInternal(root, input, 0);
  const result = decorateRunOutput(await applyRunDetail(root, raw, input), startedAt);
  await writeWorkflowTelemetry(root, "workflow_run", result);
  return result;
}

async function workflowRunInternal(root: string, input: WorkflowRunInput, depth: number): Promise<WorkflowRunOutput> {
  const action = input.action;
  if (!action) throw new Error("workflow_run requires action");
  const mode = normalizeMode(action, input.mode);

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
        mode: mode === "dry_run" ? "dry_run" : normalizeMode(item.action, item.mode ?? "execute"),
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
    if (!input.title) return blocked(action, mode, "missing_title", "create_from_grill requires title.");
    const level = await flowLevelForCreate(root, input.level);
    const plannedTask = `${todayPrefix()}-${input.slug ?? slugify(input.title)}`;
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run create_from_grill; would create task ${plannedTask} with flowLevel=${level} and manifest skeletons.`), task: plannedTask, status: "planning", stage: "grill", nextAction: "execute_create_from_grill" };
    const task = await createTask(root, input.title, level, input.slug);
    return { ...ok(action, mode, true, `Created task ${task.id} with PRD and manifest skeletons.`), task: task.id, status: task.status, stage: task.stage, nextAction: "upsert_manifest_entries_and_grill_decisions" };
  }

  if (action === "create_child") {
    if (!input.title || !input.parentTask) return blocked(action, mode, "missing_child_fields", "create_child requires title and parentTask.");
    const level = await flowLevelForCreate(root, input.level);
    const plannedTask = `${todayPrefix()}-${input.slug ?? slugify(input.title)}`;
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run create_child; would create child task ${plannedTask} with flowLevel=${level} and manifest skeletons.`), task: plannedTask, status: "planning", stage: "grill", nextAction: "execute_create_child" };
    const task = await createTask(root, input.title, level, input.slug, input.parentTask);
    return { ...ok(action, mode, true, `Created child task ${task.id} with PRD and manifest skeletons.`), task: task.id, status: task.status, stage: task.stage, nextAction: "upsert_child_manifest_entries_and_grill_decisions" };
  }

  if (action === "list_tasks") {
    const listed = await listWorkflowTasks(root, input);
    const total = listed.total;
    return { ...ok(action, mode, false, total > 0 ? `Found ${total} matching workflow task(s); returned ${listed.tasks.length}.` : "No workflow tasks found."), tasks: listed.tasks.map(taskSummary) as any, preflight: { total, limit: listed.limit, status: listed.status, includeArchived: listed.includeArchived }, nextAction: listed.tasks.length > 0 ? "select_task" : "no_task_grill" };
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

  if (action === "init_manifests") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "init_manifests requires task or an active task.");
    if (task.status === "completed") return blocked(action, mode, "task_completed", "init_manifests cannot mutate a completed task.");
    const implementEntries = manifestEntriesFromInput(input.implementEntries);
    const checkEntries = manifestEntriesFromInput(input.checkEntries);
    const entryError = implementEntries.error ?? checkEntries.error;
    if (entryError) return blocked(action, mode, entryError.code, entryError.message);
    const implementCount = implementEntries.entries.length;
    const checkCount = checkEntries.entries.length;
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run init_manifests; would ensure manifest skeletons for ${task.id} and upsert ${implementCount} implement / ${checkCount} check entr${implementCount + checkCount === 1 ? "y" : "ies"}.`), task: task.id, status: task.status, stage: task.stage, nextAction: "execute_init_manifests" };
    const initialized = await initTaskManifests(root, task, { overwrite: input.overwrite === true });
    const changed: string[] = [initialized.implement, initialized.check].filter((result) => result.changed).map((result) => result.path);
    for (const entry of implementEntries.entries) {
      const result = await upsertManifestEntry(root, task, "implement", entry);
      if (result.changed) changed.push(result.path);
    }
    for (const entry of checkEntries.entries) {
      const result = await upsertManifestEntry(root, task, "check", entry);
      if (result.changed) changed.push(result.path);
    }
    return { ...ok(action, mode, changed.length > 0, `Initialized manifest skeletons for ${task.id}; upserted ${implementCount} implement / ${checkCount} check entries.`), task: task.id, status: task.status, stage: task.stage, artifacts: [...new Set(changed)].map((ref) => ({ kind: "manifest", ref, summary: "manifest updated" })), nextAction: "continue_grill_or_start_checked" };
  }

  if (action === "upsert_manifest_entry") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "upsert_manifest_entry requires task or an active task.");
    if (task.status === "completed") return blocked(action, mode, "task_completed", "upsert_manifest_entry cannot mutate a completed task.");
    const manifest = parseManifestAgent(input.manifest);
    if (!manifest) return blocked(action, mode, "missing_manifest", "upsert_manifest_entry requires manifest=implement or manifest=check.");
    const entry = manifestEntryFromInput(input.file, input.reason ?? input.message ?? input.notes);
    if (entry.error) return blocked(action, mode, entry.error.code, entry.error.message);
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run upsert_manifest_entry; would upsert ${entry.entry.file} into ${manifest}.jsonl.`), task: task.id, status: task.status, stage: task.stage, nextAction: "execute_upsert_manifest_entry" };
    const result = await upsertManifestEntry(root, task, manifest, entry.entry);
    return { ...ok(action, mode, result.changed, result.summary), task: task.id, status: task.status, stage: task.stage, artifacts: [{ kind: "manifest", ref: result.path, summary: result.summary }], nextAction: "continue_grill_or_start_checked" };
  }

  if (action === "remove_manifest_entry") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "remove_manifest_entry requires task or an active task.");
    if (task.status === "completed") return blocked(action, mode, "task_completed", "remove_manifest_entry cannot mutate a completed task.");
    const manifest = parseManifestAgent(input.manifest);
    if (!manifest) return blocked(action, mode, "missing_manifest", "remove_manifest_entry requires manifest=implement or manifest=check.");
    const file = manifestFileFromInput(input.file);
    if (file.error) return blocked(action, mode, file.error.code, file.error.message);
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run remove_manifest_entry; would remove ${file.file} from ${manifest}.jsonl.`), task: task.id, status: task.status, stage: task.stage, nextAction: "execute_remove_manifest_entry" };
    const result = await removeManifestEntry(root, task, manifest, file.file);
    return { ...ok(action, mode, result.changed, result.summary), task: task.id, status: task.status, stage: task.stage, artifacts: [{ kind: "manifest", ref: result.path, summary: result.summary }], nextAction: "continue_grill_or_start_checked" };
  }

  if (action === "sync_manifest_from_diff") {
    const task = await resolveTask(root, input.task);
    if (!task) return blocked(action, mode, "missing_task", "sync_manifest_from_diff requires task or an active task.");
    const candidates = await gitChangedFiles(root);
    const manifest = parseManifestAgent(input.manifest);
    const rawEntries = manifest === "implement" ? input.implementEntries : manifest === "check" ? input.checkEntries : undefined;
    const entries = manifest ? manifestEntriesFromInput(rawEntries) : { entries: [] as WorkflowManifestEntryInput[] };
    if (entries.error) return blocked(action, mode, entries.error.code, entries.error.message);
    const requiredForExecute = { manifest: "implement or check", entries: "explicit entries with file and reason" };
    if (mode !== "execute") {
      const missingForExecute = [
        manifest ? undefined : "manifest",
        entries.entries.length > 0 ? undefined : "entries",
      ].filter(Boolean);
      const hint = missingForExecute.length > 0 ? ` Execute requires ${missingForExecute.join(" and ")}.` : " Execute input is complete.";
      return { ...ok(action, mode, false, candidates.length > 0 ? `Dry-run sync_manifest_from_diff; found ${candidates.length} changed file candidate(s).${hint}` : `Dry-run sync_manifest_from_diff; no git changed files found.${hint}`), task: task.id, status: task.status, stage: task.stage, preflight: { candidates, requiredForExecute, missingForExecute }, nextAction: missingForExecute.length > 0 ? "upsert_manifest_entry" : "execute_sync_manifest_from_diff" };
    }
    if (!manifest) return blocked(action, mode, "missing_manifest", "sync_manifest_from_diff execute requires manifest=implement or manifest=check plus explicit entries/reasons.");
    if (entries.entries.length === 0) return blocked(action, mode, "missing_manifest_entries", "sync_manifest_from_diff execute requires explicit entries with file and reason; dry_run lists candidates only.");
    const changed: string[] = [];
    for (const entry of entries.entries) {
      const result = await upsertManifestEntry(root, task, manifest, entry);
      if (result.changed) changed.push(result.path);
    }
    return { ...ok(action, mode, changed.length > 0, `Synced ${entries.entries.length} explicit ${manifest} manifest entr${entries.entries.length === 1 ? "y" : "ies"} from diff review.`), task: task.id, status: task.status, stage: task.stage, preflight: { candidates }, artifacts: [...new Set(changed)].map((ref) => ({ kind: "manifest", ref, summary: "manifest synced" })), nextAction: "continue" };
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
    const task = input.task ? await resolveTask(root, input.task) : await findLatestCompletedTask(root);
    if (!task) return blocked(action, mode, "missing_task", "archive requires task or an active completed task.");
    if (task.status !== "completed" || task.stage !== "finish") return blocked(action, mode, "task_not_completed", `archive requires completed/finish, got ${task.status}/${task.stage}.`);
    if (!input.userConfirmed) return blocked(action, mode, "user_confirmation_required", "archive requires userConfirmed=true.");
    const sourceRel = `.workflow/tasks/${task.id}`;
    const targetRel = `.workflow/tasks/archive/${task.id}`;
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run archive; would move ${sourceRel} to ${targetRel}.`), task: task.id, status: task.status, stage: task.stage, nextAction: "execute_archive" };
    const source = resolveInsideRoot(root, sourceRel);
    const target = resolveInsideRoot(root, targetRel);
    if (existsSync(target)) return blocked(action, mode, "archive_target_exists", `${targetRel} already exists.`);
    await mkdir(resolveInsideRoot(root, ".workflow/tasks/archive"), { recursive: true });
    await rename(source, target);
    return { ...ok(action, mode, true, `Archived task ${task.id} to ${targetRel}.`), task: task.id, status: task.status, stage: task.stage, artifacts: [{ kind: "archive", ref: targetRel, summary: `Archived ${task.id}` }], nextAction: "none" };
  }

  if (action === "reopen") {
    const task = input.task ? await resolveTask(root, input.task) : await findLatestCompletedTask(root);
    if (!task) return blocked(action, mode, "missing_task", "reopen requires a completed task.");
    if (task.status !== "completed" || task.stage !== "finish") return blocked(action, mode, "task_not_completed", `reopen requires completed/finish, got ${task.status}/${task.stage}.`);
    const reason = (input.message ?? input.notes ?? "").trim();
    if (!reason) return blocked(action, mode, "missing_message", "reopen requires message or notes explaining the reason.");
    if (!input.userConfirmed) return blocked(action, mode, "user_confirmation_required", "reopen requires userConfirmed=true.");
    if (mode !== "execute") return { ...ok(action, mode, false, `Dry-run reopen; would move ${task.id} back to in_progress/execute.`), task: task.id, status: task.status, stage: task.stage, nextAction: "execute_reopen" };
    const meta = task.meta ?? {};
    const reopenLog = Array.isArray(meta.reopenLog) ? meta.reopenLog : [];
    task.meta = { ...meta, reopenLog: [...reopenLog, { reason, reopenedAt: new Date().toISOString() }] };
    task.status = "in_progress";
    task.stage = "execute";
    await writeTask(root, task);
    return { ...ok(action, mode, true, `Reopened task ${task.id}: ${reason}`), task: task.id, status: task.status, stage: task.stage, nextAction: "checkpoint" };
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
    mode: mode === "dry_run" ? "dry_run" : normalizeMode(item.action, item.mode ?? "execute"),
    task: item.task ?? input.task,
    title: item.title,
    summary: item.action === "create_from_grill" || item.action === "create_child" ? `Plan ${item.action}: ${item.title ?? "untitled"}` : item.action === "record_grill_decision" ? `Plan record_grill_decision: ${item.decisionId ?? "unnamed"}` : item.action === "record_round_and_update_prd" ? `Plan record_round_and_update_prd: ${item.decisions?.length ?? 0} decision(s), ${item.prdUpdates?.length ?? 0} PRD update(s)` : `Plan ${item.action}`,
  };
}

async function listWorkflowTasks(root: string, input: WorkflowRunInput): Promise<{ tasks: WorkflowTaskJson[]; total: number; limit: number; status: string; includeArchived: boolean }> {
  const status = input.taskStatus ?? input.status ?? "active";
  const includeArchived = input.includeArchived === true;
  const limit = Math.max(1, Math.min(50, Math.floor(Number(input.limit ?? 12)) || 12));
  const rootTasks = await listRootTasks(root);
  const archived = includeArchived ? await listArchivedTasks(root) : [];
  const all = [...rootTasks, ...archived];
  const filtered = all.filter((task) => {
    if (status === "all") return true;
    if (status === "active") return task.status === "planning" || task.status === "in_progress";
    return task.status === status;
  });
  const active = filtered.filter((task) => task.status === "planning" || task.status === "in_progress");
  const completed = filtered.filter((task) => task.status === "completed");
  const ordered = status === "active" ? active : [...active, ...completed];
  return { tasks: ordered.slice(0, limit), total: filtered.length, limit, status, includeArchived };
}

async function flowLevelForCreate(root: string, explicit?: FlowLevel): Promise<FlowLevel> {
  if (explicit) return explicit;
  const config = await readConfig(root);
  const fallback = config?.workflow?.defaultFlowLevel;
  return fallback === "simple" || fallback === "standard" || fallback === "complex" || fallback === "goal" ? fallback : "standard";
}

function taskSummary(task: WorkflowTaskJson): Record<string, unknown> {
  return { id: task.id, title: task.title, status: task.status, stage: task.stage, flowLevel: task.flowLevel, parentTask: task.parentTask, updatedAt: task.updatedAt };
}

function parseManifestAgent(value: unknown): WorkflowManifestAgent | null {
  return value === "implement" || value === "check" ? value : null;
}

function manifestEntryFromInput(file: unknown, reason: unknown): { entry: WorkflowManifestEntryInput; error?: never } | { entry?: never; error: { code: string; message: string } } {
  const parsedFile = manifestFileFromInput(file);
  if (parsedFile.error) return { error: parsedFile.error };
  const parsedReason = typeof reason === "string" ? reason.trim() : "";
  if (!parsedReason) return { error: { code: "missing_manifest_reason", message: "Manifest entry requires reason." } };
  return { entry: { file: parsedFile.file, reason: parsedReason } };
}

function manifestFileFromInput(file: unknown): { file: string; error?: never } | { file?: never; error: { code: string; message: string } } {
  if (typeof file !== "string" || !file.trim()) return { error: { code: "missing_manifest_file", message: "Manifest entry requires file." } };
  const normalized = normalizeSlash(file.trim());
  try {
    assertRepoRelative(normalized);
  } catch (error) {
    return { error: { code: "manifest_file_outside_root", message: error instanceof Error ? error.message : String(error) } };
  }
  return { file: normalized };
}

function manifestEntriesFromInput(raw: unknown): { entries: WorkflowManifestEntryInput[]; error?: never } | { entries: WorkflowManifestEntryInput[]; error: { code: string; message: string } } {
  if (raw === undefined) return { entries: [] };
  if (!Array.isArray(raw)) return { entries: [], error: { code: "invalid_manifest_entries", message: "Manifest entries must be an array." } };
  const entries: WorkflowManifestEntryInput[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { entries, error: { code: "invalid_manifest_entry", message: `Manifest entry ${index} must be an object.` } };
    const obj = item as Record<string, unknown>;
    const parsed = manifestEntryFromInput(obj.file, obj.reason);
    if (parsed.error) return { entries, error: { code: parsed.error.code, message: `Manifest entry ${index}: ${parsed.error.message}` } };
    entries.push(parsed.entry);
  }
  return { entries };
}

async function gitChangedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "status", "--short"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    return stdout.split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => normalizeSlash(line.slice(3).replace(/.* -> /, "")))
      .filter(Boolean)
      .filter((file) => !file.startsWith(".workflow/.runtime/"))
      .sort();
  } catch {
    return [];
  }
}

async function taskSnapshotForRollback(root: string, input: WorkflowRunInput): Promise<WorkflowTaskJson | null> {
  try {
    if (input.task) return await readTask(root, input.task);
    if (input.action === "archive" || input.action === "reopen") return await findLatestCompletedTask(root);
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
  if (input.action === "archive" && output.task) {
    hints.push({
      actionIndex: index,
      action: input.action,
      kind: "restore_archived_task",
      path: `.workflow/tasks/archive/${output.task}`,
      summary: `Move .workflow/tasks/archive/${output.task} back to .workflow/tasks/${output.task} if archive should be rolled back.`,
    });
  }
  if ((input.action === "record_grill_decision" || input.action === "record_round_and_update_prd" || input.action === "append_prd_decisions" || input.action === "finalize_grill" || input.action === "start_checked" || input.action === "finish_run" || input.action === "reopen") && beforeTask) {
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

async function findLatestCompletedTask(root: string): Promise<WorkflowTaskJson | null> {
  const tasks = await listRootTasks(root);
  return tasks.find((task) => task.status === "completed") ?? null;
}

async function resolveTask(root: string, id?: string): Promise<WorkflowTaskJson | null> {
  if (id) return tryReadTask(root, id);
  return findActiveTask(root);
}

async function applyRunDetail(root: string, output: WorkflowRunOutput, input: WorkflowRunInput): Promise<WorkflowRunOutput> {
  const detail = input.detail ?? "lite";
  if (detail === "full" || output.preflight === undefined) return output;

  // Trivial preflight payloads (e.g. list_tasks pagination metadata) carry no
  // diagnostic value beyond the inline summary — skip the artifact write entirely
  // to avoid `.workflow/.runtime/preflight/` accumulating throwaway files.
  if (isTrivialPreflight(output.preflight)) {
    return {
      ...output,
      preflight: detail === "summary" ? summarizePreflight(output.preflight) : output.preflight,
    };
  }

  // Deterministic id keyed on the action + task + preflight payload (no `createdAt`)
  // so identical preflight runs reuse a single artifact file. `writeJsonArtifact`
  // skips rewriting when an explicit id resolves to an existing file.
  const idMaterial = {
    action: output.action,
    task: output.task,
    status: output.status,
    stage: output.stage,
    ok: output.ok,
    blockedBy: output.blockedBy,
    preflight: output.preflight,
  };
  const artifactId = `preflight-${output.task ?? "no-task"}-${output.action}-${stableShortHash(idMaterial)}`;
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
  }, artifactId);
  const existingArtifacts = output.artifacts ?? (output.artifactRef ? [{ kind: output.action === "checkpoint" ? "checkpoint" : "artifact", ref: output.artifactRef, summary: output.summary }] : []);
  const preflightArtifact = { kind: "preflight", ref: artifact.artifactRef, summary: `${output.action} preflight details` };

  return {
    ...output,
    preflight: detail === "summary" ? summarizePreflight(output.preflight) : undefined,
    preflightRef: artifact.artifactRef,
    artifacts: [...existingArtifacts, preflightArtifact],
  };
}

/**
 * A preflight payload is "trivial" when it carries no nested validation detail —
 * just scalar metadata or empty arrays. Examples: `list_tasks` pagination info,
 * `sync_manifest_from_diff` with zero candidates. Such payloads are not worth
 * writing to disk; the inline summary already covers them.
 */
function isTrivialPreflight(preflight: unknown): boolean {
  if (!preflight || typeof preflight !== "object") return true;
  const value = preflight as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) return false;
      continue;
    }
    if (typeof v === "object") return false;
  }
  return true;
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
