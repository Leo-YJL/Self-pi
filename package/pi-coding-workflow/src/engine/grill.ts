import type { FlowLevel, WorkflowBlocker, WorkflowGrillDecision, WorkflowGrillDecisionSource, WorkflowGrillRound, WorkflowGrillRoundKind, WorkflowGrillState, WorkflowRunInput } from "../types.ts";
import type { WorkflowTaskJson } from "./task.ts";
import { readPrdKernel, type PrdKernel } from "./prd.ts";
import { isFinalConfirmationDecisionId } from "./identifiers.ts";

const HARD_GRILL_LEVELS = new Set<FlowLevel>(["standard", "complex", "goal"]);
const HUMAN_DECISION_SOURCES = new Set<WorkflowGrillDecisionSource>(["ask_user_question", "user", "command", "fast_path"]);
const DEFAULT_MIN_BUSINESS_ROUNDS: Record<FlowLevel, number> = {
  simple: 1,
  standard: 2,
  complex: 3,
  goal: 3,
};

export function defaultGrillState(): WorkflowGrillState {
  return {
    status: "in_progress",
    rounds: 0,
    decisionCount: 0,
    askRounds: 0,
    prdRevisionCount: 0,
    decisions: [],
    roundLog: [],
    blockingOpenDecisions: 0,
    finalConfirmed: false,
  };
}

export function ensureGrillState(task: WorkflowTaskJson): WorkflowGrillState {
  const existing = task.grill;
  if (!existing || typeof existing !== "object") {
    task.grill = defaultGrillState();
    return task.grill;
  }

  const decisions = Array.isArray(existing.decisions) ? existing.decisions.filter(isDecisionLike) : [];
  const roundLog = normalizeRoundLog(existing.roundLog, decisions);
  const askRounds = roundLog.length;
  const decisionCount = decisions.length;
  task.grill = {
    status: existing.status === "finalized" || existing.status === "not_started" || existing.status === "in_progress" ? existing.status : "in_progress",
    rounds: askRounds,
    decisionCount,
    askRounds,
    prdRevisionCount: Number.isFinite(existing.prdRevisionCount) ? Math.max(0, Math.trunc(existing.prdRevisionCount)) : roundLog.filter((round) => round.prdUpdated).length,
    decisions,
    roundLog,
    blockingOpenDecisions: countBlockingOpen(decisions),
    finalConfirmed: existing.finalConfirmed === true,
    finalConfirmedBy: existing.finalConfirmedBy,
    finalConfirmedAt: typeof existing.finalConfirmedAt === "string" ? existing.finalConfirmedAt : undefined,
    finalConfirmedPrdHash: typeof existing.finalConfirmedPrdHash === "string" ? existing.finalConfirmedPrdHash : undefined,
    finalizedAt: typeof existing.finalizedAt === "string" ? existing.finalizedAt : undefined,
  };
  return task.grill;
}

export function appendGrillDecision(task: WorkflowTaskJson, input: WorkflowRunInput, fallbackId = "grill.decision"): WorkflowGrillDecision {
  const grill = ensureGrillState(task);
  const now = new Date().toISOString();
  const id = safeDecisionId(input.decisionId, fallbackId, grill.decisions.length);
  const roundKind = normalizeRoundKind(input.roundKind, inferRoundKind(id));
  const roundId = safeRoundId(input.roundId, roundKind, grill.roundLog.length);
  const decision: WorkflowGrillDecision = {
    id,
    severity: input.decisionSeverity === "non_blocking" ? "non_blocking" : "blocking",
    status: input.decisionStatus === "unanswered" || input.decisionStatus === "skipped" ? input.decisionStatus : "answered",
    source: normalizeDecisionSource(input.decisionSource, "user"),
    summary: decisionSummary(input),
    persistTo: input.persistTo === "spec" || input.persistTo === "none" ? input.persistTo : "prd",
    roundId,
    roundKind,
    createdAt: now,
  };
  grill.decisions.push(decision);
  upsertRound(grill, decision, input.questionCount, now, input.prdHashBefore, input.prdDecisionIdsBefore);
  grill.status = "in_progress";
  grill.finalConfirmed = false;
  grill.finalConfirmedBy = undefined;
  grill.finalConfirmedAt = undefined;
  grill.finalConfirmedPrdHash = undefined;
  grill.finalizedAt = undefined;
  refreshGrillMetrics(grill);
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
    blockers.push(...grillPrdGateBlockers(task, prd, { source }));
  }

  const hasHumanDecision = answeredHumanDecisions(grill).length > 0 || source === "fast_path";
  if (HARD_GRILL_LEVELS.has(task.flowLevel) && !hasHumanDecision) {
    blockers.push({
      code: "grill_decision_log_missing",
      message: "Standard/complex/goal tasks require user-sourced grill decisions, or an explicit fast_path confirmation with notes, before start_checked.",
      severity: "blocking",
      path: `${taskDir}/task.json`,
    });
  }
  if (source === "fast_path" && !decisionSummary(input)) {
    blockers.push({ code: "grill_fast_path_notes_missing", message: "fast_path grill finalization requires notes/message/decisionSummary explaining why no further grill is needed.", severity: "blocking", path: `${taskDir}/task.json` });
  }

  return blockers;
}

export function grillPrdGateBlockers(task: WorkflowTaskJson, prd: PrdKernel, options: { source?: WorkflowGrillDecisionSource } = {}): WorkflowBlocker[] {
  const grill = ensureGrillState(task);
  const blockers: WorkflowBlocker[] = [];
  const taskDir = `.workflow/tasks/${task.id}`;
  const source = options.source ?? "user";

  if (source !== "fast_path") {
    const minRounds = DEFAULT_MIN_BUSINESS_ROUNDS[task.flowLevel] ?? 1;
    const businessRounds = businessRoundLog(grill);
    if (HARD_GRILL_LEVELS.has(task.flowLevel) && businessRounds.length < minRounds) {
      blockers.push({
        code: "grill_min_rounds_not_met",
        message: `${task.flowLevel} tasks require at least ${minRounds} business grill round(s); current business rounds: ${businessRounds.length}.`,
        severity: "blocking",
        path: `${taskDir}/task.json`,
      });
    }
    const revisionBlocker = prdRevisionBlockerBetweenRounds(task, businessRounds, prd);
    if (revisionBlocker) blockers.push(revisionBlocker);
  }

  const mixedRound = grill.roundLog.find((round) => {
    const finalCount = round.decisionIds.filter(isFinalConfirmationDecisionId).length;
    return finalCount > 0 && finalCount < round.decisionIds.length;
  });
  if (mixedRound) {
    blockers.push({
      code: "grill_final_confirmation_mixed_with_business_round",
      message: `Final confirmation decision must be a separate grill round; round ${mixedRound.id} mixes final confirmation with business decisions.`,
      severity: "blocking",
      path: `${taskDir}/task.json`,
    });
  }

  const missingBusinessIds = decisionsRequiringPrd(task)
    .map((decision) => decision.id)
    .filter((id) => !prd.decisions.presentDecisionIds.includes(id));
  if (missingBusinessIds.length > 0) {
    blockers.push({
      code: "prd_missing_grill_decision",
      message: `PRD Grill Decision Log is missing decision id(s): ${missingBusinessIds.slice(0, 5).join(", ")}.`,
      severity: "blocking",
      path: prd.source.path,
    });
  }

  if (prd.finalConfirmation.confirmed) {
    if (!prd.finalConfirmation.confirmedPrdHash) {
      blockers.push({
        code: "prd_final_confirmation_hash_missing",
        message: "PRD final confirmation must include Confirmed PRD Hash so later PRD edits invalidate stale confirmation.",
        severity: "blocking",
        path: prd.source.path,
      });
    } else if (prd.source.confirmationHash && prd.finalConfirmation.confirmedPrdHash !== prd.source.confirmationHash) {
      blockers.push({
        code: "prd_changed_after_final_confirmation",
        message: `PRD changed after final confirmation; confirmed hash ${prd.finalConfirmation.confirmedPrdHash} does not match current ${prd.source.confirmationHash}.`,
        severity: "blocking",
        path: prd.source.path,
      });
    }
  }

  return blockers;
}

export function refreshGrillPrdCoverage(task: WorkflowTaskJson, presentDecisionIds: string[], prdHash?: string): void {
  const grill = ensureGrillState(task);
  const present = new Set(presentDecisionIds);
  for (const round of grill.roundLog) {
    const businessIds = grill.decisions
      .filter((decision) => decision.roundId === round.id && decision.status === "answered" && (decision.persistTo ?? "prd") === "prd" && !isFinalConfirmationDecisionId(decision.id))
      .map((decision) => decision.id);
    if (businessIds.length > 0 && businessIds.every((id) => present.has(id))) {
      round.prdUpdated = true;
      round.prdHashAfter = prdHash ?? round.prdHashAfter;
    }
  }
  refreshGrillMetrics(grill);
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
      roundKind: "custom",
    }, "grill.fast_path");
  }

  const next = ensureGrillState(task);
  next.status = "finalized";
  next.blockingOpenDecisions = countBlockingOpen(next.decisions);
  next.finalConfirmed = true;
  next.finalConfirmedBy = normalizeDecisionSource(input.decisionSource, "user");
  next.finalConfirmedAt = new Date().toISOString();
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

  const normalized = ensureGrillState(task);
  const blockers: WorkflowBlocker[] = [];
  if (normalized.blockingOpenDecisions > 0) {
    blockers.push({ code: "grill_blocking_decisions_unanswered", message: `Grill has ${normalized.blockingOpenDecisions} unanswered blocking decision(s).`, severity: "blocking", path: `${taskDir}/task.json` });
  }
  if (!normalized.finalConfirmed) {
    blockers.push({ code: "grill_final_confirmation_missing", message: "Grill final confirmation is missing.", severity: "blocking", path: `${taskDir}/task.json` });
  }
  if (HARD_GRILL_LEVELS.has(task.flowLevel) && answeredHumanDecisions(normalized).length === 0) {
    blockers.push({ code: "grill_decision_log_missing", message: "Standard/complex/goal tasks require a user-sourced decision log before start_checked.", severity: "blocking", path: `${taskDir}/task.json` });
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

function normalizeRoundKind(kind: unknown, fallback: WorkflowGrillRoundKind): WorkflowGrillRoundKind {
  if (kind === "scope" || kind === "runtime" || kind === "validation" || kind === "final_confirmation" || kind === "custom") return kind;
  return fallback;
}

function inferRoundKind(decisionId: string): WorkflowGrillRoundKind {
  if (isFinalConfirmationDecisionId(decisionId)) return "final_confirmation";
  if (/runtime|behavior|failure|fallback|error|policy/i.test(decisionId)) return "runtime";
  if (/validation|acceptance|check|test|verify/i.test(decisionId)) return "validation";
  return "scope";
}

function safeDecisionId(raw: unknown, fallback: string, index: number): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value) return value;
  return `${fallback}.${index + 1}`;
}

function safeRoundId(raw: unknown, kind: WorkflowGrillRoundKind, index: number): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value) return value;
  return `round-${index + 1}-${kind}`;
}

function decisionSummary(input: WorkflowRunInput): string {
  return (input.decisionSummary ?? input.message ?? input.notes ?? "").trim();
}

function isDecisionLike(value: unknown): value is WorkflowGrillDecision {
  const item = value as WorkflowGrillDecision;
  return !!item && typeof item.id === "string" && typeof item.summary === "string" && typeof item.createdAt === "string";
}

function normalizeRoundLog(raw: unknown, decisions: WorkflowGrillDecision[]): WorkflowGrillRound[] {
  const rounds = Array.isArray(raw) ? raw.filter(isRoundLike).map((round) => ({ ...round, decisionIds: [...new Set(round.decisionIds)] })) : [];
  const byId = new Map(rounds.map((round) => [round.id, round]));
  for (const [index, decision] of decisions.entries()) {
    const kind = normalizeRoundKind(decision.roundKind, inferRoundKind(decision.id));
    const roundId = decision.roundId ?? `legacy-round-${index + 1}-${kind}`;
    decision.roundId = roundId;
    decision.roundKind = kind;
    const existing = byId.get(roundId);
    if (existing) {
      if (!existing.decisionIds.includes(decision.id)) existing.decisionIds.push(decision.id);
      continue;
    }
    const round: WorkflowGrillRound = { id: roundId, kind, decisionIds: [decision.id], questionCount: 1, prdUpdated: false, createdAt: decision.createdAt };
    rounds.push(round);
    byId.set(roundId, round);
  }
  return rounds;
}

function isRoundLike(value: unknown): value is WorkflowGrillRound {
  const item = value as WorkflowGrillRound;
  return !!item && typeof item.id === "string" && Array.isArray(item.decisionIds) && typeof item.createdAt === "string";
}

function upsertRound(grill: WorkflowGrillState, decision: WorkflowGrillDecision, questionCount: unknown, now: string, prdHashBefore?: string, prdDecisionIdsBefore?: string[]): void {
  const roundId = decision.roundId ?? safeRoundId(undefined, decision.roundKind ?? "custom", grill.roundLog.length);
  let round = grill.roundLog.find((candidate) => candidate.id === roundId);
  if (!round) {
    round = {
      id: roundId,
      kind: decision.roundKind ?? "custom",
      decisionIds: [],
      questionCount: Number.isFinite(questionCount) ? Math.max(1, Math.trunc(Number(questionCount))) : 1,
      prdHashBefore,
      prdDecisionIdsBefore: prdDecisionIdsBefore ? [...new Set(prdDecisionIdsBefore)] : undefined,
      prdUpdated: false,
      createdAt: now,
    };
    grill.roundLog.push(round);
  }
  if (!round.decisionIds.includes(decision.id)) round.decisionIds.push(decision.id);
  if (prdHashBefore && !round.prdHashBefore) round.prdHashBefore = prdHashBefore;
  if (prdDecisionIdsBefore) {
    round.prdDecisionIdsBefore = [...new Set([...(round.prdDecisionIdsBefore ?? []), ...prdDecisionIdsBefore])];
    const covered = new Set(prdDecisionIdsBefore);
    for (const previousRound of grill.roundLog) {
      if (previousRound.id !== round.id && previousRound.decisionIds.length > 0 && previousRound.decisionIds.every((id) => covered.has(id))) {
        previousRound.prdUpdated = true;
      }
    }
  }
  if (Number.isFinite(questionCount)) round.questionCount = Math.max(round.questionCount, Math.trunc(Number(questionCount)));
  if (round.kind === "custom" && decision.roundKind && decision.roundKind !== "custom") round.kind = decision.roundKind;
}

function refreshGrillMetrics(grill: WorkflowGrillState): void {
  grill.decisionCount = grill.decisions.length;
  grill.askRounds = grill.roundLog.length;
  grill.rounds = grill.askRounds;
  grill.prdRevisionCount = grill.roundLog.filter((round) => round.prdUpdated).length;
  grill.blockingOpenDecisions = countBlockingOpen(grill.decisions);
}

function businessRoundLog(grill: WorkflowGrillState): WorkflowGrillRound[] {
  return grill.roundLog.filter((round) => round.decisionIds.some((id) => !isFinalConfirmationDecisionId(id)));
}

function prdRevisionBlockerBetweenRounds(task: WorkflowTaskJson, businessRounds: WorkflowGrillRound[], prd: PrdKernel): WorkflowBlocker | null {
  const grill = ensureGrillState(task);
  const seenPriorDecisionIds: string[] = [];
  for (const round of businessRounds) {
    const coveredBeforeRound = new Set(round.prdDecisionIdsBefore ?? []);
    const missingPrior = seenPriorDecisionIds.filter((id) => !coveredBeforeRound.has(id));
    if (missingPrior.length > 0) {
      return {
        code: "grill_prd_revision_missing_after_round",
        message: `PRD was not updated with prior grill decision id(s) before round ${round.id}: ${missingPrior.slice(0, 5).join(", ")}.`,
        severity: "blocking",
        path: prd.source.path,
      };
    }
    const roundBusinessDecisionIds = grill.decisions
      .filter((decision) => decision.roundId === round.id && decision.status === "answered" && (decision.persistTo ?? "prd") === "prd" && !isFinalConfirmationDecisionId(decision.id))
      .map((decision) => decision.id);
    seenPriorDecisionIds.push(...roundBusinessDecisionIds.filter((id) => !seenPriorDecisionIds.includes(id)));
  }
  return null;
}

function decisionsRequiringPrd(task: WorkflowTaskJson): WorkflowGrillDecision[] {
  const grill = ensureGrillState(task);
  return grill.decisions.filter((decision) =>
    decision.status === "answered"
    && (decision.persistTo ?? "prd") === "prd"
    && !isFinalConfirmationDecisionId(decision.id)
  );
}
