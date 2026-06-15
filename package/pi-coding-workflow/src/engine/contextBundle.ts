import type { ContextMode, DetailMode, WorkflowAgent, WorkflowBlocker, WorkflowWarning } from "../types.ts";
import { evaluatePrdChecklistGate, prdGateToBlocker, readPrdKernel, type PrdKernel, type PrdViewMode } from "./prd.ts";
import { manifestFiles, manifestIssuesToWarnings, readTaskManifests, type WorkflowManifestSummary } from "./manifest.ts";
import { readWorkspaceSummary, type WorkspaceSummary } from "./workspace.ts";
import type { WorkflowTaskJson } from "./task.ts";
import { computeStartBlockers } from "./startGate.ts";

export interface WorkflowContextBundle {
  mode: ContextMode;
  agent?: WorkflowAgent;
  profile: string;
  task: { id: string; title: string; status: string; stage: string; flowLevel: string };
  prd: PrdKernel;
  manifests: Record<"implement" | "check", WorkflowManifestSummary>;
  workspace: WorkspaceSummary;
  recommendedNext: string;
  blockedBy: WorkflowBlocker[];
  warnings: WorkflowWarning[];
  summary: string;
}

export async function buildContextBundle(
  root: string,
  task: WorkflowTaskJson,
  options: { mode?: ContextMode; agent?: WorkflowAgent; profile?: string; detail?: DetailMode } = {},
): Promise<WorkflowContextBundle> {
  const mode = options.mode ?? "brief";
  const prdMode = prdModeForContext(mode, options.detail);
  const prd = await readPrdKernel(root, task, prdMode);
  const manifests = await readTaskManifests(root, task);
  const workspace = await readWorkspaceSummary(root, { inScopeFiles: manifestFiles(manifests), taskId: task.id });
  const blockedBy = contextBlockers(task, prd, manifests, options.agent);
  const warnings = contextWarnings(prd, manifests, workspace);
  const recommendedNext = recommendedNextFor(task, options.agent);
  return {
    mode,
    agent: options.agent,
    profile: options.profile ?? "generic",
    task: { id: task.id, title: task.title, status: task.status, stage: task.stage, flowLevel: task.flowLevel },
    prd,
    manifests,
    workspace,
    recommendedNext,
    blockedBy,
    warnings,
    summary: summarizeBundle(task, prd, manifests, workspace, blockedBy, recommendedNext),
  };
}

function prdModeForContext(mode: ContextMode, detail?: DetailMode): PrdViewMode {
  if (detail === "full" || detail === "normal") return "full";
  if (mode === "lite" || mode === "brief" || detail === "lite" || detail === "summary") return "compact";
  return "brief";
}

function contextBlockers(
  task: WorkflowTaskJson,
  prd: PrdKernel,
  manifests: Record<"implement" | "check", WorkflowManifestSummary>,
  agent?: WorkflowAgent,
): WorkflowBlocker[] {
  const blockers: WorkflowBlocker[] = [];
  if (!prd.source.exists) {
    blockers.push({ code: "prd_missing", message: `${prd.source.path} is missing.`, severity: "blocking", path: prd.source.path });
  }

  if (task.status === "planning") {
    blockers.push(...computeStartBlockers(task, prd, manifests));
  }

  if (task.status === "in_progress" && agent === "finish") {
    const gates = [
      evaluatePrdChecklistGate(prd, "acceptanceCriteria", { requireChecklist: true, allowNA: true }),
      evaluatePrdChecklistGate(prd, "validationPlan", { requireChecklist: true, allowNA: true, allowLimitation: true }),
      evaluatePrdChecklistGate(prd, "definitionOfDone", { requireChecklist: true, allowNA: true }),
    ];
    for (const gate of gates) {
      const blocker = prdGateToBlocker(gate);
      if (blocker) blockers.push(blocker);
    }
  }

  return blockers;
}

function contextWarnings(
  prd: PrdKernel,
  manifests: Record<"implement" | "check", WorkflowManifestSummary>,
  workspace: WorkspaceSummary,
): WorkflowWarning[] {
  const warnings: WorkflowWarning[] = [];
  if (prd.quality.uncheckedChecklistCount > 0) {
    warnings.push({ code: "prd_unchecked_checklists_present", message: `PRD has ${prd.quality.uncheckedChecklistCount} unchecked checklist items.`, path: prd.source.path });
  }
  warnings.push(...manifestIssuesToWarnings(manifests.implement), ...manifestIssuesToWarnings(manifests.check));
  if (workspace.isGit && workspace.unrelatedCount > 0) {
    warnings.push({ code: "workspace_unrelated_dirty", message: `${workspace.unrelatedCount} dirty files are outside manifest/task scope.` });
  }
  return warnings;
}

function recommendedNextFor(task: WorkflowTaskJson, agent?: WorkflowAgent): string {
  if (task.status === "planning") return "Run workflow_run start_checked in dry_run mode, fix blockers, then execute.";
  if (task.status === "in_progress" && agent === "finish") return "Run workflow_run finish_run in dry_run mode, complete finish gates, then execute with a message.";
  if (task.status === "in_progress" && agent === "check") return "Run workflow_run checkpoint with phase=after-check.";
  if (task.status === "in_progress") return "Implement the next manifest-backed slice, then run workflow_run checkpoint.";
  if (task.status === "completed") return "Task is completed; archive only with explicit user confirmation.";
  return "Create or select a workflow task.";
}

function summarizeBundle(
  task: WorkflowTaskJson,
  prd: PrdKernel,
  manifests: Record<"implement" | "check", WorkflowManifestSummary>,
  workspace: WorkspaceSummary,
  blockedBy: WorkflowBlocker[],
  recommendedNext: string,
): string {
  const parts = [
    `Workflow active task ${task.id} (${task.status}/${task.stage}/${task.flowLevel})`,
    prd.source.exists ? `PRD ${prd.source.hash ?? "no-hash"}: ${prd.title}` : "PRD missing",
    `manifest implement=${manifests.implement.entries.length} check=${manifests.check.entries.length}`,
    workspace.summary,
  ];
  if (blockedBy.length > 0) parts.push(`blockers=${blockedBy.map((blocker) => blocker.code).slice(0, 6).join(",")}`);
  parts.push(`next=${recommendedNext}`);
  return parts.join("; ");
}
