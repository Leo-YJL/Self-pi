import type { WorkflowAdaptiveControl, WorkflowAgent, WorkflowBlocker, WorkflowDecisionCardHint, WorkflowNextOutput, WorkflowRecommendedCall, WorkflowSubagentBrief, WorkflowWarning } from "../types.ts";
import type { WorkflowContextBundle } from "./contextBundle.ts";

interface AdaptiveInput {
  bundle: WorkflowContextBundle;
  nextAction: WorkflowNextOutput["nextAction"];
  recommendedTool?: WorkflowNextOutput["recommendedTool"];
  requestedAgent?: WorkflowAgent;
}

const RESEARCH_CODES = new Set([
  "prd_open_questions_blocking",
  "open_questions_maybe_present",
]);

const USER_GATE_CODES = new Set([
  "prd_final_confirmation_missing",
  "user_confirmation_required",
  "grill_not_finalized",
  "grill_decision_log_missing",
  "grill_final_confirmation_missing",
  "grill_final_confirmation_not_user_sourced",
  "grill_blocking_decisions_unanswered",
]);

const IMPLEMENT_CODES = new Set([
  "implement_manifest_missing",
  "implement_manifest_empty",
  "implement_manifest_file_missing",
  "implement_manifest_invalid_json",
  "implement_manifest_missing_fields",
  "manifest_file_missing",
]);

const CHECK_CODES = new Set([
  "check_manifest_missing",
  "check_manifest_empty",
  "check_manifest_file_missing",
  "check_manifest_invalid_json",
  "check_manifest_missing_fields",
  "git_diff_check_failed",
  "workspace_unrelated_dirty",
]);

const FINISH_CODES = new Set([
  "prd_acceptance_criteria_missing",
  "prd_acceptance_criteria_unchecked",
  "prd_acceptance_criteria_no_checklist",
  "prd_validation_plan_missing",
  "prd_validation_plan_unchecked",
  "prd_validation_plan_no_checklist",
  "prd_definition_of_done_missing",
  "prd_definition_of_done_unchecked",
  "prd_definition_of_done_no_checklist",
]);

export function buildAdaptiveControl(input: AdaptiveInput): WorkflowAdaptiveControl {
  const codes = [...input.bundle.blockedBy.map((item) => item.code), ...input.bundle.warnings.map((item) => item.code)];
  const blockers = input.bundle.blockedBy;
  const warnings = input.bundle.warnings;
  const evidenceRefs = evidenceRefsFor(input.bundle, codes);
  const deterministicActions = deterministicActionsFor(input);
  const recommendedAgent = chooseAgent(input, codes, blockers);
  const shouldAskUser = blockers.some((blocker) => USER_GATE_CODES.has(blocker.code));
  const shouldSpawnSubagent = recommendedAgent !== "none" && recommendedAgent !== "user" && !shouldAskUser;
  const risk = riskFor(input.bundle, blockers, warnings);
  const reasons = reasonLines(input, recommendedAgent, codes, blockers, warnings);
  const decisionCardHints = shouldAskUser ? decisionCardHintsFor(input, blockers, codes) : [];
  const delegateRecommendedCall = shouldSpawnSubagent ? delegateCallFor(recommendedAgent, input) : undefined;

  return {
    strategy: shouldAskUser
      ? "ask_user"
      : deterministicActions.length > 0
        ? "deterministic_preflight"
        : shouldSpawnSubagent
          ? "subagent_brief"
          : "none",
    recommendedAgent,
    risk,
    confidence: confidenceFor(input.bundle, blockers, warnings),
    reasons,
    deterministicActions,
    subagentBriefs: shouldSpawnSubagent ? [briefFor(recommendedAgent, input, codes, evidenceRefs)] : [],
    delegateRecommendedCall,
    decisionCardHints,
    stopConditions: stopConditionsFor(input.bundle, blockers),
  };
}

export function compactAdaptiveControl(control: WorkflowAdaptiveControl): WorkflowAdaptiveControl {
  return {
    ...control,
    reasons: control.reasons.slice(0, 5),
    deterministicActions: control.deterministicActions.slice(0, 3),
    subagentBriefs: control.subagentBriefs.map((brief) => ({
      ...brief,
      contextRefs: brief.contextRefs.slice(0, 8),
      instructions: brief.instructions.slice(0, 6),
      stopConditions: brief.stopConditions.slice(0, 5),
    })).slice(0, 1),
    decisionCardHints: control.decisionCardHints?.slice(0, 3),
    stopConditions: control.stopConditions.slice(0, 6),
  };
}

function decisionCardHintsFor(input: AdaptiveInput, blockers: WorkflowBlocker[], codes: string[]): WorkflowDecisionCardHint[] {
  const task = input.bundle.task;
  const blockerCodes = blockers.map((blocker) => blocker.code);
  const needsGrill = blockerCodes.some((code) => code.startsWith("grill_"));
  const needsPrdConfirmation = blockerCodes.includes("prd_final_confirmation_missing") || blockerCodes.includes("user_confirmation_required");
  const needsOpenQuestion = blockerCodes.includes("prd_open_questions_blocking") || codes.includes("open_questions_maybe_present");

  if (needsGrill) {
    return [{
      decisionId: `${task.id}.grill-next-round`,
      severity: "blocking",
      persistTo: "prd",
      header: "Grill Round",
      question: `Which next Stage 1 grill round should be resolved for task ${task.id}?`,
      context: `Task is ${task.status}/${task.stage}/${task.flowLevel}; start_checked remains blocked until business grill rounds are recorded, written into PRD, then final confirmation is recorded after reviewing the latest PRD.`,
      ambiguity: "If the agent jumps straight to final confirmation, standard/complex tasks may skip scope/runtime/validation decisions or fail to write decisions into PRD.",
      recommendation: "Ask one focused business grill round, write the resulting decision ids into the PRD Grill Decision Log, then rerun workflow_next before the next round.",
      why: "Multi-round grill keeps user decisions, PRD revisions and final confirmation auditable instead of compressing all choices into one ask.",
      options: [
        { label: "Scope round", value: "scope_round", recommended: true, description: "Clarify in-scope, out-of-scope and acceptance boundaries.", consequence: "Record decisions with roundKind=scope, update PRD, then continue." },
        { label: "Runtime round", value: "runtime_round", description: "Clarify runtime behavior, fallback, errors or environment differences.", consequence: "Record decisions with roundKind=runtime and update PRD before final confirmation." },
        { label: "Validation round", value: "validation_round", description: "Clarify checks, manual validation limits and Definition of Done.", consequence: "Record decisions with roundKind=validation and update PRD before final confirmation." },
      ],
    }];
  }

  if (needsOpenQuestion) {
    return [{
      decisionId: `${task.id}.open-question`,
      severity: "blocking",
      persistTo: "prd",
      header: "Question",
      question: `Which PRD open question must be resolved before task ${task.id} starts?`,
      context: `The PRD still has blocking open questions: ${input.bundle.prd.openQuestions.summary}`,
      ambiguity: "Starting now would force the agent to choose an implementation contract without user confirmation.",
      recommendation: "Resolve the blocking question with one concrete option and write it into the PRD Decisions section.",
      why: "Resolving one blocking branch at a time keeps grill short and prevents broad speculative analysis.",
      options: [
        { label: "Use recommendation", value: "use_recommendation", recommended: true, description: "Accept the safest implementation recommendation after the agent states it concisely.", consequence: "The answer becomes a PRD decision." },
        { label: "Choose alternative", value: "choose_alternative", description: "Pick another explicit behavior or boundary.", consequence: "The PRD and manifests may need adjustment." },
      ],
    }];
  }

  if (needsPrdConfirmation) {
    return [{
      decisionId: `${task.id}.final-confirmation`,
      severity: "blocking",
      persistTo: "prd",
      header: "Confirm",
      question: `Do you confirm task ${task.id} can proceed to implementation?`,
      context: "The PRD final confirmation gate is missing or not recognized.",
      ambiguity: "Without final confirmation, start_checked must remain blocked even if the PRD appears complete.",
      recommendation: "Confirm only after reviewing scope, risks and validation limits.",
      why: "This gives the workflow a user-sourced gate instead of relying on an LLM-authored confirmation line.",
      options: [
        { label: "Confirm", value: "confirm", recommended: true, description: "Proceed with the current PRD.", consequence: "Record final confirmation and then finalize_grill." },
        { label: "Revise PRD", value: "revise", description: "Pause to change scope, acceptance criteria or validation plan.", consequence: "Keep task in planning/grill." },
      ],
    }];
  }

  return [];
}

function delegateCallFor(agent: Exclude<WorkflowAdaptiveControl["recommendedAgent"], "none" | "user">, input: AdaptiveInput): WorkflowRecommendedCall {
  const includeContext = agent === "finish" ? "finish" : agent === "check" ? "check" : agent === "research" ? "brief" : "task";
  const writePolicy = agent === "implement" ? "manifest_only" : "report_only";
  return {
    name: "workflow_delegate",
    arguments: {
      task: input.bundle.task.id,
      agent,
      mode: "dry_run",
      includeContext,
      detail: "summary",
      writePolicy,
    },
  };
}

function chooseAgent(input: AdaptiveInput, codes: string[], blockers: WorkflowBlocker[]): WorkflowAdaptiveControl["recommendedAgent"] {
  if (blockers.some((blocker) => USER_GATE_CODES.has(blocker.code))) return "user";
  if (codes.some((code) => RESEARCH_CODES.has(code))) return "research";
  if (codes.some((code) => CHECK_CODES.has(code))) return "check";
  if (codes.some((code) => IMPLEMENT_CODES.has(code))) return "implement";
  if (codes.some((code) => FINISH_CODES.has(code))) return "finish";

  if (input.requestedAgent) return input.requestedAgent;
  if (input.bundle.task.status === "planning") return "research";
  if (input.bundle.task.status === "in_progress" && input.nextAction === "finish_dry_run") return "finish";
  if (input.bundle.task.status === "in_progress" && input.nextAction === "checkpoint") return "check";
  if (input.bundle.task.status === "in_progress") return "implement";
  return "none";
}

function deterministicActionsFor(input: AdaptiveInput): WorkflowRecommendedCall[] {
  const actions: WorkflowRecommendedCall[] = [];
  const task = input.bundle.task.id;
  const blockerCodes = input.bundle.blockedBy.map((blocker) => blocker.code);
  const manifestBlocker = blockerCodes.find((code) => code.includes("manifest"));
  if (input.bundle.task.status === "planning" && manifestBlocker) {
    const action = manifestBlocker.endsWith("manifest_missing") || manifestBlocker.endsWith("manifest_empty") ? "init_manifests" : "sync_manifest_from_diff";
    actions.push({ name: "workflow_run", arguments: { action, mode: "dry_run", task } });
  }
  if (input.bundle.task.status === "planning" && input.bundle.blockedBy.length === 0) {
    actions.push({ name: "workflow_run", arguments: { action: "start_checked", mode: "dry_run", task } });
  }
  if (input.bundle.task.status === "in_progress" && input.requestedAgent === "finish") {
    actions.push({ name: "workflow_run", arguments: { action: "finish_run", mode: "dry_run", task } });
  }
  if (input.bundle.task.status === "in_progress" && input.requestedAgent === "check") {
    actions.push({ name: "workflow_run", arguments: { action: "checkpoint", mode: "dry_run", task, phase: "after-check" } });
  }
  if (input.recommendedTool && input.nextAction !== "implement_slice" && input.bundle.blockedBy.length === 0 && actions.length === 0) {
    actions.push({ name: input.recommendedTool.name, arguments: input.recommendedTool.arguments as Record<string, unknown> });
  }
  return actions;
}

function briefFor(agent: Exclude<WorkflowAdaptiveControl["recommendedAgent"], "none" | "user">, input: AdaptiveInput, codes: string[], evidenceRefs: string[]): WorkflowSubagentBrief {
  const task = input.bundle.task;
  const blockers = input.bundle.blockedBy.map((blocker) => `${blocker.code}: ${blocker.message}`);
  const warnings = input.bundle.warnings.map((warning) => `${warning.code}: ${warning.message}`);
  const baseConstraints = [
    "Use workflow_next first if the provided evidenceRefs are insufficient.",
    "Do not mutate unrelated dirty files.",
    "Do not bypass workflow_run preflight gates.",
    "Keep durable facts in .workflow/spec/** when the task establishes reusable project knowledge.",
  ];

  if (agent === "research") {
    return {
      agent,
      goal: `Resolve planning uncertainty for ${task.id} without changing source files.`,
      triggerCodes: codes.filter((code) => RESEARCH_CODES.has(code) || code.includes("prd")),
      contextRefs: evidenceRefs,
      instructions: [
        ...baseConstraints,
        "Inspect PRD open questions and relevant spec files only as needed.",
        "Return concrete decisions or ask the user if a human choice is required.",
        "Prefer updating the PRD through normal file edits, then rerun workflow_next.",
      ],
      stopConditions: ["Blocking open questions are resolved or converted to explicit user decisions.", "PRD has no TODO/TBD blockers.", "Final confirmation is ready for /workflow-prd-confirm."],
      expectedOutput: "A short decision list and exact PRD/spec updates needed before start_checked.",
    };
  }

  if (agent === "check") {
    return {
      agent,
      goal: `Check task ${task.id} against PRD, manifests and current diff.`,
      triggerCodes: codes.filter((code) => CHECK_CODES.has(code) || code.includes("check") || code.includes("git")),
      contextRefs: evidenceRefs,
      instructions: [
        ...baseConstraints,
        "Run deterministic checks first (manifest validation, git diff --check, configured project tests when known).",
        "Classify failures as task-related, unrelated workspace dirt, or environment limitation.",
        "Record validation limits in PRD/check notes instead of inventing pass evidence.",
      ],
      stopConditions: ["No check manifest blockers remain.", "git diff --check passes or limitation is explicit.", "Unrelated dirty files are preserved."],
      expectedOutput: "A concise check report with blocker fixes and the next workflow_run checkpoint/finish recommendation.",
    };
  }

  if (agent === "finish") {
    return {
      agent,
      goal: `Close finish gates for ${task.id}.`,
      triggerCodes: codes.filter((code) => FINISH_CODES.has(code) || code.includes("finish") || code.includes("prd_")),
      contextRefs: evidenceRefs,
      instructions: [
        ...baseConstraints,
        "Verify acceptance criteria, validation plan and Definition of Done checklists against actual evidence.",
        "Do not mark unchecked items complete unless evidence exists; record limitations explicitly.",
        "After fixes, run workflow_run finish_run dry_run before execute.",
      ],
      stopConditions: ["Acceptance criteria are checked or explicitly N/A.", "Validation plan is checked or limitation is recorded.", "Definition of Done is checked."],
      expectedOutput: "A finish-readiness summary and exact checklist updates, followed by finish_run dry-run recommendation.",
    };
  }

  return {
    agent: "implement",
    goal: `Implement the next manifest-backed slice for ${task.id}.`,
    triggerCodes: codes.filter((code) => IMPLEMENT_CODES.has(code) || code.includes("implement")),
    contextRefs: evidenceRefs,
    instructions: [
      ...baseConstraints,
      "Read only the files named by implement/check manifests unless evidence is insufficient.",
      "Make the smallest source changes needed for the current PRD slice.",
      "Update implement/check manifests with workflow_run init_manifests/upsert_manifest_entry/remove_manifest_entry if planned files change; do not hand-write JSONL unless the deterministic action is unavailable.",
      "After implementation, run workflow_run checkpoint with phase=after-implementation.",
    ],
    stopConditions: ["Manifest-backed source changes are complete.", "No unrelated files were modified.", "A checkpoint dry-run has been recommended or executed."],
    expectedOutput: "A concise implementation summary, changed files, validation performed/limited, and next checkpoint call.",
  };
}

function evidenceRefsFor(bundle: WorkflowContextBundle, codes: string[]): string[] {
  const refs = [
    `task:${bundle.task.id}`,
    `prd:${bundle.prd.source.hash ?? "missing"}`,
    `manifest:implement:${bundle.manifests.implement.hash ?? "missing"}`,
    `manifest:check:${bundle.manifests.check.hash ?? "missing"}`,
    "workspace:git-status",
  ];
  refs.push(...codes.slice(0, 8).map((code) => `signal:${code}`));
  return [...new Set(refs)];
}

function reasonLines(input: AdaptiveInput, agent: WorkflowAdaptiveControl["recommendedAgent"], codes: string[], blockers: WorkflowBlocker[], warnings: WorkflowWarning[]): string[] {
  const reasons = [`Task ${input.bundle.task.id} is ${input.bundle.task.status}/${input.bundle.task.stage}; route=${input.nextAction}; recommendedAgent=${agent}.`];
  if (blockers.length > 0) reasons.push(`Blocking signals: ${blockers.map((blocker) => blocker.code).slice(0, 6).join(", ")}.`);
  if (warnings.length > 0) reasons.push(`Warning signals: ${warnings.map((warning) => warning.code).slice(0, 6).join(", ")}.`);
  if (codes.includes("workspace_unrelated_dirty")) reasons.push("Unrelated workspace dirt requires check discipline before broad edits or finish.");
  if (agent === "user") reasons.push("A human gate is required; use Pi command/UI instead of LLM relay when possible.");
  return reasons;
}

function stopConditionsFor(bundle: WorkflowContextBundle, blockers: WorkflowBlocker[]): string[] {
  const result = blockers.map((blocker) => `Resolve blocker ${blocker.code}.`);
  if (bundle.task.status === "planning") result.push("workflow_run start_checked dry-run passes before execute.");
  if (bundle.task.status === "in_progress") result.push("workflow_run checkpoint or finish_run dry-run is run before final execute.");
  return result.length > 0 ? result : ["No adaptive stop condition beyond the recommended workflow_run preflight."];
}

function riskFor(bundle: WorkflowContextBundle, blockers: WorkflowBlocker[], warnings: WorkflowWarning[]): WorkflowAdaptiveControl["risk"] {
  if (blockers.some((blocker) => blocker.severity === "blocking")) return "high";
  if (bundle.task.flowLevel === "complex" || bundle.task.flowLevel === "goal") return warnings.length > 0 ? "high" : "medium";
  if (warnings.length > 0) return "medium";
  return "low";
}

function confidenceFor(bundle: WorkflowContextBundle, blockers: WorkflowBlocker[], warnings: WorkflowWarning[]): number {
  let confidence = 0.72;
  if (bundle.prd.source.exists) confidence += 0.08;
  if (bundle.manifests.implement.exists && bundle.manifests.check.exists) confidence += 0.08;
  if (blockers.length > 0) confidence -= 0.1;
  if (warnings.length > 2) confidence -= 0.05;
  return Math.max(0.35, Math.min(0.95, Number(confidence.toFixed(2))));
}
