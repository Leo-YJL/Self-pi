import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { workflowNext } from "./engine/route.ts";
import { workflowRun } from "./engine/run.ts";
import { workflowDelegate } from "./engine/delegate.ts";
import { executeInitWorkspace, planInitWorkspace } from "./init/initWorkspace.ts";
import { initSpecDryRun, initSpecExecute } from "./init/initSpec.ts";
import { parseArgs, parseAnswers } from "./commands/args.ts";
import { confirmPrdFinal } from "./engine/prdConfirm.ts";
import { buildWorkflowCompactionSummary } from "./engine/compaction.ts";

const PROFILE_VALUES = ["generic", "unity"] as const;
const SINGLE_ACTION_VALUES = ["create_from_grill", "create_child", "record_grill_decision", "record_round_and_update_prd", "append_prd_decisions", "update_prd_section", "init_manifests", "upsert_manifest_entry", "remove_manifest_entry", "sync_manifest_from_diff", "list_tasks", "finalize_grill", "start_checked", "checkpoint", "finish_run", "archive", "reopen"] as const;
const ACTION_VALUES = [...SINGLE_ACTION_VALUES, "batch"] as const;
const FLOW_VALUES = ["simple", "standard", "complex", "goal"] as const;
const CONTEXT_VALUES = ["none", "signal", "lite", "brief", "task", "check", "finish"] as const;
const DETAIL_VALUES = ["lite", "summary", "normal", "full"] as const;
const RUN_DETAIL_VALUES = ["lite", "summary", "full"] as const;
const DELEGATE_WRITE_POLICY_VALUES = ["report_only", "task_files_only", "manifest_only"] as const;
const GRILL_DECISION_SEVERITY_VALUES = ["blocking", "non_blocking"] as const;
const GRILL_DECISION_STATUS_VALUES = ["answered", "unanswered", "skipped"] as const;
const GRILL_DECISION_SOURCE_VALUES = ["ask_user_question", "user", "command", "fast_path", "agent"] as const;
const GRILL_PERSIST_VALUES = ["prd", "spec", "none"] as const;
const GRILL_ROUND_KIND_VALUES = ["scope", "runtime", "validation", "final_confirmation", "custom"] as const;
const PRD_SECTION_VALUES = ["executionContract", "goal", "requirements", "acceptanceCriteria", "validationPlan", "openQuestions", "finalConfirmation", "outOfScope", "definitionOfDone", "grillResult", "architectureImpact"] as const;
const PRD_UPDATE_MODE_VALUES = ["replace", "append"] as const;
const TASK_STATUS_FILTER_VALUES = ["planning", "in_progress", "completed", "no_task", "active", "all"] as const;
const MANIFEST_AGENT_VALUES = ["implement", "check"] as const;
const MANIFEST_ENTRY_MODE_VALUES = ["append", "replace"] as const;

const WorkflowRoundDecisionSchema = Type.Object({
  decisionId: Type.String(),
  decisionSummary: Type.String(),
  decisionSeverity: Type.Optional(StringEnum(GRILL_DECISION_SEVERITY_VALUES)),
  decisionStatus: Type.Optional(StringEnum(GRILL_DECISION_STATUS_VALUES)),
  decisionSource: Type.Optional(StringEnum(GRILL_DECISION_SOURCE_VALUES)),
  persistTo: Type.Optional(StringEnum(GRILL_PERSIST_VALUES)),
  roundId: Type.Optional(Type.String()),
  roundKind: Type.Optional(StringEnum(GRILL_ROUND_KIND_VALUES)),
});

const WorkflowPrdSectionUpdateSchema = Type.Object({
  prdSection: StringEnum(PRD_SECTION_VALUES),
  prdContent: Type.String(),
  prdUpdateMode: Type.Optional(StringEnum(PRD_UPDATE_MODE_VALUES)),
});

const WorkflowManifestEntrySchema = Type.Object({
  file: Type.String(),
  reason: Type.String(),
});

const WorkflowRunBatchItemSchema = Type.Object({
  action: StringEnum(SINGLE_ACTION_VALUES),
  task: Type.Optional(Type.String()),
  mode: Type.Optional(StringEnum(["dry_run", "execute"] as const)),
  detail: Type.Optional(StringEnum(RUN_DETAIL_VALUES)),
  title: Type.Optional(Type.String()),
  level: Type.Optional(StringEnum(FLOW_VALUES)),
  slug: Type.Optional(Type.String()),
  parentTask: Type.Optional(Type.String()),
  phase: Type.Optional(StringEnum(["after-implementation", "after-check", "custom"] as const)),
  profile: Type.Optional(StringEnum(PROFILE_VALUES)),
  notes: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  userConfirmed: Type.Optional(Type.Boolean()),
  decisionId: Type.Optional(Type.String()),
  decisionSeverity: Type.Optional(StringEnum(GRILL_DECISION_SEVERITY_VALUES)),
  decisionStatus: Type.Optional(StringEnum(GRILL_DECISION_STATUS_VALUES)),
  decisionSource: Type.Optional(StringEnum(GRILL_DECISION_SOURCE_VALUES)),
  decisionSummary: Type.Optional(Type.String()),
  persistTo: Type.Optional(StringEnum(GRILL_PERSIST_VALUES)),
  roundId: Type.Optional(Type.String()),
  roundKind: Type.Optional(StringEnum(GRILL_ROUND_KIND_VALUES)),
  questionCount: Type.Optional(Type.Number()),
  prdSection: Type.Optional(StringEnum(PRD_SECTION_VALUES)),
  prdContent: Type.Optional(Type.String()),
  prdUpdateMode: Type.Optional(StringEnum(PRD_UPDATE_MODE_VALUES)),
  decisions: Type.Optional(Type.Array(WorkflowRoundDecisionSchema)),
  prdUpdates: Type.Optional(Type.Array(WorkflowPrdSectionUpdateSchema)),
  appendPrdDecisions: Type.Optional(Type.Boolean()),
  manifest: Type.Optional(StringEnum(MANIFEST_AGENT_VALUES)),
  file: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  entryMode: Type.Optional(StringEnum(MANIFEST_ENTRY_MODE_VALUES)),
  implementEntries: Type.Optional(Type.Array(WorkflowManifestEntrySchema)),
  checkEntries: Type.Optional(Type.Array(WorkflowManifestEntrySchema)),
  overwrite: Type.Optional(Type.Boolean()),
  status: Type.Optional(StringEnum(TASK_STATUS_FILTER_VALUES)),
  taskStatus: Type.Optional(StringEnum(TASK_STATUS_FILTER_VALUES)),
  limit: Type.Optional(Type.Number()),
  includeArchived: Type.Optional(Type.Boolean()),
});

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event: any) => {
    const built = buildWorkflowCompactionSummary({ branchEntries: event.branchEntries, preparation: event.preparation });
    if (!built) return undefined;
    return {
      compaction: {
        summary: built.summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: built.details,
      },
    };
  });

  pi.registerTool({
    name: "workflow_next",
    label: "Workflow Next",
    description: "Semantic read-only workflow router. Does not mutate source/tasks/config; may update runtime cache. Defaults to lite context and supports signal mode for very low-token routing.",
    promptSnippet: "Semantic read-only workflow router for next action, signal/lite context and evidence refs.",
    promptGuidelines: ["Use workflow_next before workflow stage actions; prefer includeContext=signal for routing and request lite/task/check/finish only when refs are insufficient."],
    parameters: Type.Object({
      task: Type.Optional(Type.String()),
      agent: Type.Optional(StringEnum(["research", "implement", "check", "finish"] as const)),
      includeContext: Type.Optional(StringEnum(CONTEXT_VALUES)),
      detail: Type.Optional(StringEnum(DETAIL_VALUES)),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await workflowNext(ctx.cwd, params as any);
      appendWorkflowEntry(pi, "workflow_next", output);
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  });

  pi.registerTool({
    name: "workflow_delegate",
    label: "Workflow Delegate",
    description: "Bounded subagent runner for workflow research/implement/check/finish work. Uses isolated in-memory context, tool budgets, path policy, and returns compact artifact-backed summaries.",
    promptSnippet: "Run a bounded workflow subagent when workflow_next adaptiveControl recommends delegation.",
    promptGuidelines: ["Use workflow_delegate only when workflow_next recommends adaptiveControl.strategy=subagent_brief; run dry_run first for planning, execute for bounded delegated work, then use workflow_run for deterministic preflight/state changes."],
    parameters: Type.Object({
      task: Type.Optional(Type.String()),
      agent: StringEnum(["research", "implement", "check", "finish"] as const),
      mode: Type.Optional(StringEnum(["dry_run", "execute"] as const)),
      objective: Type.Optional(Type.String()),
      includeContext: Type.Optional(StringEnum(CONTEXT_VALUES)),
      detail: Type.Optional(StringEnum(DETAIL_VALUES)),
      maxTurns: Type.Optional(Type.Number()),
      maxToolCalls: Type.Optional(Type.Number()),
      maxInputTokens: Type.Optional(Type.Number()),
      maxOutputTokens: Type.Optional(Type.Number()),
      writePolicy: Type.Optional(StringEnum(DELEGATE_WRITE_POLICY_VALUES)),
      allowedPaths: Type.Optional(Type.Array(Type.String())),
      stopOnToolBudget: Type.Optional(Type.Boolean()),
      stopOnTokenBudget: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await workflowDelegate(ctx.cwd, params as any);
      appendWorkflowEntry(pi, "workflow_delegate", output);
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  });

  pi.registerTool({
    name: "workflow_run",
    label: "Workflow Run",
    description: "Controlled workflow stage actuator. Dry-run by default; supports mode=auto for gate-checked actions and action=batch with actions[] for deterministic transactions.",
    promptSnippet: "Controlled workflow stage actuator for create/start/checkpoint/finish/batch actions; mode=auto runs gates first for safe state changes.",
    promptGuidelines: ["Use workflow_run after workflow_next recommends an action.", "Prefer mode=auto for gate-checked state actions (create_from_grill, init_manifests, upsert_manifest_entry, remove_manifest_entry, finalize_grill, start_checked, finish_run, archive, reopen): the engine runs preflight first and either commits or returns blockers without mutating, removing the dry_run+execute round-trip. mode=auto on PRD writes / batch / sync_manifest_from_diff falls back to dry_run so previews still happen.", "Use mode=dry_run only to preview PRD writes (record_round_and_update_prd, update_prd_section), to review a batch plan before committing, or when explicitly uncertain.", "Use mode=execute when you want to force a write without auto's safety net.", "Use action=batch to combine deterministic steps into one transaction."],
    parameters: Type.Object({
      action: StringEnum(ACTION_VALUES),
      task: Type.Optional(Type.String()),
      mode: Type.Optional(StringEnum(["dry_run", "execute", "auto"] as const)),
      detail: Type.Optional(StringEnum(RUN_DETAIL_VALUES)),
      title: Type.Optional(Type.String()),
      level: Type.Optional(StringEnum(FLOW_VALUES)),
      slug: Type.Optional(Type.String()),
      parentTask: Type.Optional(Type.String()),
      phase: Type.Optional(StringEnum(["after-implementation", "after-check", "custom"] as const)),
      profile: Type.Optional(StringEnum(PROFILE_VALUES)),
      notes: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      userConfirmed: Type.Optional(Type.Boolean()),
      decisionId: Type.Optional(Type.String()),
      decisionSeverity: Type.Optional(StringEnum(GRILL_DECISION_SEVERITY_VALUES)),
      decisionStatus: Type.Optional(StringEnum(GRILL_DECISION_STATUS_VALUES)),
      decisionSource: Type.Optional(StringEnum(GRILL_DECISION_SOURCE_VALUES)),
      decisionSummary: Type.Optional(Type.String()),
      persistTo: Type.Optional(StringEnum(GRILL_PERSIST_VALUES)),
      roundId: Type.Optional(Type.String()),
      roundKind: Type.Optional(StringEnum(GRILL_ROUND_KIND_VALUES)),
      questionCount: Type.Optional(Type.Number()),
      prdSection: Type.Optional(StringEnum(PRD_SECTION_VALUES)),
      prdContent: Type.Optional(Type.String()),
      prdUpdateMode: Type.Optional(StringEnum(PRD_UPDATE_MODE_VALUES)),
      decisions: Type.Optional(Type.Array(WorkflowRoundDecisionSchema)),
      prdUpdates: Type.Optional(Type.Array(WorkflowPrdSectionUpdateSchema)),
      appendPrdDecisions: Type.Optional(Type.Boolean()),
      manifest: Type.Optional(StringEnum(MANIFEST_AGENT_VALUES)),
      file: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      entryMode: Type.Optional(StringEnum(MANIFEST_ENTRY_MODE_VALUES)),
      implementEntries: Type.Optional(Type.Array(WorkflowManifestEntrySchema)),
      checkEntries: Type.Optional(Type.Array(WorkflowManifestEntrySchema)),
      overwrite: Type.Optional(Type.Boolean()),
      status: Type.Optional(StringEnum(TASK_STATUS_FILTER_VALUES)),
      taskStatus: Type.Optional(StringEnum(TASK_STATUS_FILTER_VALUES)),
      limit: Type.Optional(Type.Number()),
      includeArchived: Type.Optional(Type.Boolean()),
      actions: Type.Optional(Type.Array(WorkflowRunBatchItemSchema)),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await workflowRun(ctx.cwd, params as any);
      appendWorkflowEntry(pi, "workflow_run", output);
      return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
    },
  });

  pi.registerCommand("workflow-init", {
    description: "Initialize base .workflow structure (--dry-run or --execute).",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const profile = await selectProfile(parsed.profile, ctx);
      const result = parsed.execute ? await executeInitWorkspace(ctx.cwd, profile) : await planInitWorkspace(ctx.cwd, profile);
      ctx.ui.notify(JSON.stringify(result, null, 2), result.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("workflow-init-spec", {
    description: "Generate or execute a plan-based spec initialization (--profile generic|unity --dry-run, or --execute --plan <id>).",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const profile = await selectProfile(parsed.profile, ctx);
      let result: unknown;
      if (parsed.execute) {
        const plan = typeof parsed.plan === "string" ? parsed.plan : "";
        if (!plan) throw new Error("--execute requires --plan <plan-id>");
        result = await initSpecExecute(ctx.cwd, plan, parseAnswers(parsed), parsed.allowModify === true);
      } else {
        result = await initSpecDryRun(ctx.cwd, profile);
      }
      ctx.ui.notify(JSON.stringify(result, null, 2), "info");
    },
  });

  pi.registerCommand("workflow-prd-confirm", {
    description: "Confirm the active planning PRD final gate through Pi UI (--task <id> --message <text> --execute).",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const task = typeof parsed.task === "string" ? parsed.task : undefined;
      let message = typeof parsed.message === "string" ? parsed.message : "";
      if (!message && ctx.hasUI) {
        message = await ctx.ui.editor("PRD final confirmation evidence", "Confirmed: proceed with implementation as described in the PRD.") ?? "";
      }
      const dryRun = await confirmPrdFinal(ctx.cwd, { task, mode: "dry_run", message });
      if (!dryRun.ok) {
        ctx.ui.notify(JSON.stringify(dryRun, null, 2), "warning");
        return;
      }
      const shouldExecute = parsed.execute === true || (ctx.hasUI && await ctx.ui.confirm("Record PRD final confirmation?", dryRun.preview ?? dryRun.summary));
      const result = shouldExecute ? await confirmPrdFinal(ctx.cwd, { task, mode: "execute", message }) : dryRun;
      ctx.ui.notify(JSON.stringify(result, null, 2), result.ok ? "info" : "warning");
    },
  });
}

async function selectProfile(rawProfile: string | boolean | undefined, ctx: { hasUI?: boolean; ui: { select: (title: string, options: string[]) => Promise<string | undefined> } }): Promise<"generic" | "unity"> {
  if (rawProfile === "unity") return "unity";
  if (rawProfile === "generic") return "generic";
  if (ctx.hasUI) {
    const selected = await ctx.ui.select("Select workflow profile", ["generic", "unity"]);
    if (selected === "unity" || selected === "generic") return selected;
  }
  return "generic";
}

function appendWorkflowEntry(pi: ExtensionAPI, kind: "workflow_next" | "workflow_run" | "workflow_delegate", output: any): void {
  try {
    pi.appendEntry("pi-coding-workflow", {
      kind,
      task: output.task,
      status: output.status,
      stage: output.stage,
      flowLevel: output.flowLevel,
      action: output.action,
      agent: output.agent,
      runId: output.runId,
      mode: output.mode,
      nextAction: output.nextAction,
      recommendedTool: output.recommendedTool,
      nextRecommendedCall: output.nextRecommendedCall,
      evidenceRefs: output.evidenceRefs ?? output.context?.evidenceRefs,
      omittedRefs: output.omitted?.map((item: any) => item.ref) ?? output.context?.omitted?.map((item: any) => item.ref),
      artifactRefs: output.artifacts?.map((artifact: any) => artifact.ref) ?? (output.artifactRef ? [output.artifactRef] : []),
      changedFiles: output.changedFiles,
      tokenBudget: output.tokenBudget ?? output.context?.tokenBudget,
      meta: output.meta,
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Session persistence is an optimization. Tool execution should not fail if appendEntry is unavailable.
  }
}
