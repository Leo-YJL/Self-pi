import { existsSync } from "node:fs";
import type { WorkflowNextInput, WorkflowNextOutput } from "../types.ts";
import { readConfig } from "./config.ts";
import { findActiveTask, readTask, type WorkflowTaskJson } from "./task.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";

export async function workflowNext(root: string, input: WorkflowNextInput = {}): Promise<WorkflowNextOutput> {
  const config = await readConfig(root);
  const hasWorkflow = existsSync(resolveInsideRoot(root, ".workflow"));
  const includeContext = input.includeContext ?? "brief";
  const requestedTask = input.task ? await readTask(root, input.task) : null;
  const activeTask = requestedTask ?? await findActiveTask(root);

  if (!hasWorkflow) {
    return {
      ok: true,
      status: "no_task",
      nextAction: "ask_user",
      recommendedTool: { name: "workflow_run", arguments: { action: "checkpoint", mode: "dry_run" } },
      blockedBy: [],
      warnings: [{ code: "workflow_dir_missing", message: "No .workflow directory found. Run /workflow-init first." }],
      context: includeContext === "none" ? undefined : { mode: includeContext, summary: "Workflow not initialized." },
      cache: { cacheFriendly: true },
    };
  }

  if (!activeTask) {
    return {
      ok: true,
      status: "no_task",
      nextAction: "no_task_grill",
      recommendedTool: { name: "workflow_run", arguments: { action: "create_from_grill", mode: "dry_run", profile: config?.project.profile ?? "generic" } },
      blockedBy: [],
      warnings: config ? [] : [{ code: "workflow_config_missing", message: "No .workflow/config.json found. Run /workflow-init first." }],
      context: includeContext === "none" ? undefined : { mode: includeContext, summary: config ? `Workflow profile: ${config.project.profile}; no active task.` : "Workflow not initialized." },
      cache: { cacheFriendly: true },
    };
  }

  return routeForTask(config?.project.profile ?? "generic", activeTask, input);
}

function routeForTask(profile: string, task: WorkflowTaskJson, input: WorkflowNextInput): WorkflowNextOutput {
  const includeContext = input.includeContext ?? "brief";
  const next = nextActionForTask(task, input.agent);
  return {
    ok: true,
    status: task.status,
    task: task.id,
    stage: task.stage,
    flowLevel: task.flowLevel,
    nextAction: next.nextAction,
    recommendedTool: next.recommendedTool,
    blockedBy: [],
    warnings: [],
    context: includeContext === "none" ? undefined : { mode: includeContext, summary: `Workflow profile: ${profile}; active task ${task.id}; status=${task.status}; stage=${task.stage}; flow=${task.flowLevel}.` },
    cache: { cacheFriendly: true, taskKey: `${task.id}:${task.status}:${task.stage}:${task.flowLevel}` },
  };
}

function nextActionForTask(task: WorkflowTaskJson, agent: WorkflowNextInput["agent"]): Pick<WorkflowNextOutput, "nextAction" | "recommendedTool"> {
  if (task.status === "planning") {
    return { nextAction: "start_checked", recommendedTool: { name: "workflow_run", arguments: { action: "start_checked", mode: "dry_run", task: task.id } } };
  }
  if (task.status === "in_progress") {
    if (agent === "finish") {
      return { nextAction: "finish_dry_run", recommendedTool: { name: "workflow_run", arguments: { action: "finish_run", mode: "dry_run", task: task.id } } };
    }
    if (agent === "check") {
      return { nextAction: "checkpoint", recommendedTool: { name: "workflow_run", arguments: { action: "checkpoint", mode: "dry_run", task: task.id, phase: "after-check" } } };
    }
    return { nextAction: "implement_slice", recommendedTool: { name: "workflow_run", arguments: { action: "checkpoint", mode: "dry_run", task: task.id, phase: "after-implementation" } } };
  }
  return { nextAction: "none", recommendedTool: { name: "workflow_run", arguments: { action: "archive", mode: "dry_run", task: task.id } } };
}
