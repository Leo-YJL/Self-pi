import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { workflowNext } from "./engine/route.ts";
import { workflowRun } from "./engine/run.ts";
import { executeInitWorkspace, planInitWorkspace } from "./init/initWorkspace.ts";
import { initSpecDryRun, initSpecExecute } from "./init/initSpec.ts";
import { parseArgs, parseAnswers } from "./commands/args.ts";
import { confirmPrdFinal } from "./engine/prdConfirm.ts";
import { buildWorkflowCompactionSummary } from "./engine/compaction.ts";

const PROFILE_VALUES = ["generic", "unity"] as const;
const SINGLE_ACTION_VALUES = ["create_from_grill", "create_child", "record_grill_decision", "append_prd_decisions", "update_prd_section", "finalize_grill", "start_checked", "checkpoint", "finish_run", "archive"] as const;
const ACTION_VALUES = [...SINGLE_ACTION_VALUES, "batch"] as const;
const FLOW_VALUES = ["simple", "standard", "complex", "goal"] as const;
const CONTEXT_VALUES = ["none", "lite", "brief", "task", "check", "finish"] as const;
const DETAIL_VALUES = ["lite", "summary", "normal", "full"] as const;
const RUN_DETAIL_VALUES = ["lite", "summary", "full"] as const;
const GRILL_DECISION_SEVERITY_VALUES = ["blocking", "non_blocking"] as const;
const GRILL_DECISION_STATUS_VALUES = ["answered", "unanswered", "skipped"] as const;
const GRILL_DECISION_SOURCE_VALUES = ["ask_user_question", "user", "command", "fast_path", "agent"] as const;
const GRILL_PERSIST_VALUES = ["prd", "spec", "none"] as const;
const GRILL_ROUND_KIND_VALUES = ["scope", "runtime", "validation", "final_confirmation", "custom"] as const;
const PRD_SECTION_VALUES = ["executionContract", "goal", "requirements", "acceptanceCriteria", "validationPlan", "openQuestions", "finalConfirmation", "outOfScope", "definitionOfDone", "grillResult", "architectureImpact"] as const;
const PRD_UPDATE_MODE_VALUES = ["replace", "append"] as const;

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
    description: "Semantic read-only workflow router. Does not mutate source/tasks/config; may update runtime cache. Defaults to lite context with evidence refs, omitted refs and token budget metadata.",
    promptSnippet: "Semantic read-only workflow router for next action and lite context.",
    promptGuidelines: ["Use workflow_next before workflow stage actions; workflow_next does not mutate source/tasks/config and defaults to includeContext=lite."],
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
    name: "workflow_run",
    label: "Workflow Run",
    description: "Controlled workflow stage actuator. Dry-run by default; supports action=batch with actions[] for deterministic transactions.",
    promptSnippet: "Controlled workflow stage actuator for create/start/checkpoint/finish/batch actions.",
    promptGuidelines: ["Use workflow_run only after workflow_next recommends an action; prefer dry_run before execute for risky operations, and use action=batch to combine deterministic steps."],
    parameters: Type.Object({
      action: StringEnum(ACTION_VALUES),
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

function appendWorkflowEntry(pi: ExtensionAPI, kind: "workflow_next" | "workflow_run", output: any): void {
  try {
    pi.appendEntry("pi-coding-workflow", {
      kind,
      task: output.task,
      status: output.status,
      stage: output.stage,
      flowLevel: output.flowLevel,
      action: output.action,
      mode: output.mode,
      nextAction: output.nextAction,
      recommendedTool: output.recommendedTool,
      nextRecommendedCall: output.nextRecommendedCall,
      evidenceRefs: output.evidenceRefs ?? output.context?.evidenceRefs,
      omittedRefs: output.omitted?.map((item: any) => item.ref) ?? output.context?.omitted?.map((item: any) => item.ref),
      artifactRefs: output.artifacts?.map((artifact: any) => artifact.ref) ?? (output.artifactRef ? [output.artifactRef] : []),
      tokenBudget: output.tokenBudget ?? output.context?.tokenBudget,
      meta: output.meta,
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Session persistence is an optimization. Tool execution should not fail if appendEntry is unavailable.
  }
}
