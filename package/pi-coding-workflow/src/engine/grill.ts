import type { WorkflowBlocker, WorkflowGrillDecision, WorkflowGrillDecisionSource, WorkflowGrillState, WorkflowRunInput } from "../types.ts";
import type { WorkflowTaskJson } from "./task.ts";
import { readPrdKernel } from "./prd.ts";

const HARD_GRILL_LEVELS = new Set(["standard", "complex", "goal"]);
const HUMAN_DECISION_SOURCES = new Set<WorkflowGrillDecisionSource>(["ask_user_question", "user", "command", "fast_path"]);

export function defaultGrillState(): WorkflowGrillState {
  return { status: "in_progress", rounds: 0, decisions: [], blockingOpenDecisions: 0, finalConfirmed: false };
}

export function ensureGrillState(task: WorkflowTaskJson): WorkflowGrillState {
  const existing = task.grill;
  if (!existing || typeof existing !== "object") {
    task.grill = defaultGrillState();
    return task.grill;
  }

  const decisions = Array.isArray(existing.decisions) ? existing.decisions.filter(isDecisionLike) : [];
  task.grill = {
    status: existing.status === "finalized" || existing.status === "not_started" || existing.status === "in_progress" ? existing.status : "in_progress",
    rounds: Number.isFinite(existing.rounds) ? Math.max(0, Math.trunc(existing.rounds)) : decisions.length,
    decisions,
    blockingOpenDecisions: countBlockingOpen(decisions),
    finalConfirmed: existing.finalConfirmed === true,
    finalConfirmedBy: existing.finalConfirmedBy,
    finalizedAt: typeof existing.finalizedAt === "string" ? existing.finalizedAt : undefined,
  };
  return task.grill;
}

export function appendGrillDecision(task: WorkflowTaskJson, input: WorkflowRunInput, fallbackId = "grill.decision"): WorkflowGrillDecision {
  const grill = ensureGrillState(task);
  const now = new Date().toISOString();
  const decision: WorkflowGrillDecision = {
    id: safeDecisionId(input.decisionId, fallbackId, grill.decisions.length),
    severity: input.decisionSeverity === "non_blocking" ? "non_blocking" : "blocking",
    status: input.decisionStatus === "unanswered" || input.decisionStatus === "skipped" ? input.decisionStatus : "answered",
    source: normalizeDecisionSource(input.decisionSource, "user"),
    summary: decisionSummary(input),
    persistTo: input.persistTo === "spec" || input.persistTo === "none" ? input.persistTo : "prd",
    createdAt: now,
  };
  grill.decisions.push(decision);
  grill.rounds = Math.max(grill.rounds + 1, grill.decisions.length);
  grill.status = "in_progress";
  grill.finalConfirmed = false;
  grill.finalConfirmedBy = undefined;
  grill.finalizedAt = undefined;
  grill.blockingOpenDecisions = countBlockingOpen(grill.decisions);
  return decision;
}

export async function validateGrillFinalization(root: string, task: WorkflowTaskJson, input: WorkflowRunInput): Promise<WorkflowBlocker[]> {
  const blockers: WorkflowBlocker[] = [];
  const taskDir = `.workflow/tasks/${task.id}`;
  const grill = ensureGrillState(task);
  const source = normalizeDecisionSource(input.decisionSource, "user");

  if (task.status !== "planning" || task.stage !== "grill") {
    blockers.push({ code: "task_not_planning", message: `finalize_grill requires planning/grill, got ${task.status}/${task.stage}.`, severity: "blocking", path: `${taskDir}/task.json` });
  }
  if (!input.userConfirmed) {
    blockers.push({ code: "user_confirmation_required", message: "finalize_grill requires userConfirmed=true after the user has reviewed the PRD/grill decisions.", severity: "blocking", path: `${taskDir}/task.json` });
  }
  if (source === "agent") {
    blockers.push({ code: "grill_final_confirmation_not_user_sourced", message: "finalize_grill cannot use decisionSource=agent; use a user/ask_user_question/command/fast_path source.", severity: "blocking", path: `${taskDir}/task.json` });
  }
  if (grill.blockingOpenDecisions > 0) {
    blockers.push({ code: "grill_blocking_decisions_unanswered", message: `Grill has ${grill.blockingOpenDecisions} unanswered blocking decision(s).`, severity: "blocking", path: `${taskDir}/task.json` });
  }

  const prd = await readPrdKernel(root, task, "compact");
  if (!prd.source.exists) blockers.push({ code: "prd_missing", message: `${taskDir}/prd.md is missing.`, severity: "blocking", path: `${taskDir}/prd.md` });
  if (prd.source.exists) {
    if (prd.quality.hasTodo) blockers.push({ code: "prd_todo_present", message: "PRD contains TODO/TBD markers; resolve them before finalize_grill.", severity: "blocking", path: prd.source.path });
    if (prd.openQuestions.blocking) blockers.push({ code: "prd_open_questions_blocking", message: `PRD has blocking open questions: ${prd.openQuestions.summary}`, severity: "blocking", path: prd.source.path });
    if (!prd.finalConfirmation.confirmed) blockers.push({ code: "prd_final_confirmation_missing", message: "PRD final confirmation is missing or not confirmed.", severity: "blocking", path: prd.source.path });
  }

  const hasHumanDecision = answeredHumanDecisions(grill).length > 0 || source === "fast_path";
  if (HARD_GRILL_LEVELS.has(task.flowLevel) && !hasHumanDecision) {
    blockers.push({
      code: "grill_decision_log_missing",
      message: "Standard/complex/goal tasks require at least one user-sourced grill decision, or an explicit fast_path confirmation with notes, before start_checked.",
      severity: "blocking",
      path: `${taskDir}/task.json`,
    });
  }
  if (source === "fast_path" && !decisionSummary(input)) {
    blockers.push({ code: "grill_fast_path_notes_missing", message: "fast_path grill finalization requires notes/message/decisionSummary explaining why no further grill is needed.", severity: "blocking", path: `${taskDir}/task.json` });
  }

  return blockers;
}

export function finalizeGrillState(task: WorkflowTaskJson, input: WorkflowRunInput): void {
  const grill = ensureGrillState(task);
  if (grill.decisions.length === 0 && normalizeDecisionSource(input.decisionSource, "user") === "fast_path") {
    appendGrillDecision(task, {
      ...input,
      decisionId: input.decisionId ?? "grill.fast_path",
      decisionSeverity: "blocking",
      decisionStatus: "answered",
      decisionSource: "fast_path",
      decisionSummary: decisionSummary(input),
      persistTo: input.persistTo ?? "prd",
    }, "grill.fast_path");
  }

  const next = ensureGrillState(task);
  next.status = "finalized";
  next.blockingOpenDecisions = countBlockingOpen(next.decisions);
  next.finalConfirmed = true;
  next.finalConfirmedBy = normalizeDecisionSource(input.decisionSource, "user");
  next.finalizedAt = new Date().toISOString();
}

export function grillStartBlockers(task: WorkflowTaskJson): WorkflowBlocker[] {
  if (task.status !== "planning") return [];
  const taskDir = `.workflow/tasks/${task.id}`;
  const grill = task.grill;
  if (!grill || grill.status !== "finalized") {
    return [{
      code: "grill_not_finalized",
      message: "Stage 1 grill is not finalized. Record user decisions and run workflow_run finalize_grill before start_checked.",
      severity: "blocking",
      path: `${taskDir}/task.json`,
    }];
  }

  const blockers: WorkflowBlocker[] = [];
  if (grill.blockingOpenDecisions > 0) {
    blockers.push({ code: "grill_blocking_decisions_unanswered", message: `Grill has ${grill.blockingOpenDecisions} unanswered blocking decision(s).`, severity: "blocking", path: `${taskDir}/task.json` });
  }
  if (!grill.finalConfirmed) {
    blockers.push({ code: "grill_final_confirmation_missing", message: "Grill final confirmation is missing.", severity: "blocking", path: `${taskDir}/task.json` });
  }
  if (HARD_GRILL_LEVELS.has(task.flowLevel) && answeredHumanDecisions(grill).length === 0) {
    blockers.push({ code: "grill_decision_log_missing", message: "Standard/complex/goal tasks require a user-sourced grill decision log before start_checked.", severity: "blocking", path: `${taskDir}/task.json` });
  }
  return blockers;
}

export function isGrillFinalized(task: WorkflowTaskJson): boolean {
  return grillStartBlockers(task).length === 0;
}

function answeredHumanDecisions(grill: WorkflowGrillState): WorkflowGrillDecision[] {
  return grill.decisions.filter((decision) => decision.status === "answered" && HUMAN_DECISION_SOURCES.has(decision.source));
}

function countBlockingOpen(decisions: WorkflowGrillDecision[]): number {
  return decisions.filter((decision) => decision.severity === "blocking" && decision.status !== "answered").length;
}

function normalizeDecisionSource(source: unknown, fallback: WorkflowGrillDecisionSource): WorkflowGrillDecisionSource {
  if (source === "ask_user_question" || source === "user" || source === "command" || source === "fast_path" || source === "agent") return source;
  return fallback;
}

function safeDecisionId(raw: unknown, fallback: string, index: number): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value) return value;
  return `${fallback}.${index + 1}`;
}

function decisionSummary(input: WorkflowRunInput): string {
  return (input.decisionSummary ?? input.message ?? input.notes ?? "").trim();
}

function isDecisionLike(value: unknown): value is WorkflowGrillDecision {
  const item = value as WorkflowGrillDecision;
  return !!item && typeof item.id === "string" && typeof item.summary === "string" && typeof item.createdAt === "string";
}
