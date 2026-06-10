import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { workflowNext } from "./engine/route.ts";
import { workflowRun } from "./engine/run.ts";
import { executeInitWorkspace, planInitWorkspace } from "./init/initWorkspace.ts";
import { initSpecDryRun, initSpecExecute } from "./init/initSpec.ts";
import { parseArgs, parseAnswers } from "./commands/args.ts";

const PROFILE_VALUES = ["generic", "unity"] as const;
const ACTION_VALUES = ["create_from_grill", "create_child", "start_checked", "checkpoint", "finish_run", "archive"] as const;
const FLOW_VALUES = ["simple", "standard", "complex", "goal"] as const;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "workflow_next",
    label: "Workflow Next",
    description: "Read-only workflow router and compact context summary.",
    promptSnippet: "Read-only workflow router for next action and compact context.",
    promptGuidelines: ["Use workflow_next before workflow stage actions; workflow_next is read-only."],
    parameters: Type.Object({
      task: Type.Optional(Type.String()),
      agent: Type.Optional(StringEnum(["research", "implement", "check", "finish"] as const)),
      includeContext: Type.Optional(StringEnum(["none", "brief", "task", "check", "finish"] as const)),
      detail: Type.Optional(StringEnum(["summary", "normal"] as const)),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await workflowNext(ctx.cwd, params as any);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], details: output };
    },
  });

  pi.registerTool({
    name: "workflow_run",
    label: "Workflow Run",
    description: "Controlled workflow stage actuator. Dry-run by default for risky actions.",
    promptSnippet: "Controlled workflow stage actuator for create/start/checkpoint/finish actions.",
    promptGuidelines: ["Use workflow_run only after workflow_next recommends an action; prefer dry_run before execute for risky operations."],
    parameters: Type.Object({
      action: StringEnum(ACTION_VALUES),
      task: Type.Optional(Type.String()),
      mode: Type.Optional(StringEnum(["dry_run", "execute"] as const)),
      title: Type.Optional(Type.String()),
      level: Type.Optional(StringEnum(FLOW_VALUES)),
      slug: Type.Optional(Type.String()),
      parentTask: Type.Optional(Type.String()),
      phase: Type.Optional(StringEnum(["after-implementation", "after-check", "custom"] as const)),
      profile: Type.Optional(StringEnum(PROFILE_VALUES)),
      notes: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      userConfirmed: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const output = await workflowRun(ctx.cwd, params as any);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], details: output };
    },
  });

  pi.registerCommand("workflow-init", {
    description: "Initialize base .workflow structure (--dry-run or --execute).",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const profile = parsed.profile === "unity" ? "unity" : "generic";
      const result = parsed.execute ? await executeInitWorkspace(ctx.cwd, profile) : await planInitWorkspace(ctx.cwd, profile);
      ctx.ui.notify(JSON.stringify(result, null, 2), result.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("workflow-init-spec", {
    description: "Generate or execute a plan-based spec initialization (--profile generic|unity --dry-run, or --execute --plan <id>).",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const profile = parsed.profile === "unity" ? "unity" : "generic";
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
}
