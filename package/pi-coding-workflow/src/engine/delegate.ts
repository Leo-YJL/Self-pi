import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContextMode, DelegateWritePolicy, DetailMode, WorkflowAgent, WorkflowBlocker, WorkflowDelegateInput, WorkflowDelegateOutput, WorkflowRecommendedCall, WorkflowWarning } from "../types.ts";
import { writeJsonArtifact } from "../artifacts/writeToolResult.ts";
import { normalizeSlash } from "../safety/pathPolicy.ts";
import { findActiveTask, tryReadTask, type WorkflowTaskJson } from "./task.ts";
import { workflowNext } from "./route.ts";
import { workflowRun } from "./run.ts";
import { manifestFiles, readTaskManifests } from "./manifest.ts";
import { estimateTokens, RUN_RESULT_TARGET_TOKENS, truncateText } from "./contextBudget.ts";
import { writeWorkflowTelemetry } from "./telemetry.ts";

const execFileAsync = promisify(execFile);
const DELEGATE_RESULT_TARGET_TOKENS = 1_200;

interface DelegateDefaults {
  includeContext: ContextMode;
  detail: DetailMode;
  maxTurns: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  writePolicy: DelegateWritePolicy;
}

interface DelegateSessionEvent {
  type: string;
}

interface DelegateSession {
  subscribe(listener: (event: DelegateSessionEvent) => void): () => void;
  prompt(prompt: string): Promise<void>;
  abort(): Promise<void> | void;
  dispose(): void;
  messages?: unknown[];
  state?: { messages?: unknown[] };
  agent?: { state?: { messages?: unknown[] } };
}

interface DelegateSdkSurface {
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: DelegateSession }>;
  SessionManager: { inMemory(root: string): unknown };
  defineTool: unknown;
}

const DEFAULTS: Record<WorkflowAgent, DelegateDefaults> = {
  research: { includeContext: "brief", detail: "summary", maxTurns: 4, maxToolCalls: 20, maxInputTokens: 30_000, maxOutputTokens: 4_000, writePolicy: "report_only" },
  implement: { includeContext: "task", detail: "summary", maxTurns: 8, maxToolCalls: 40, maxInputTokens: 45_000, maxOutputTokens: 6_000, writePolicy: "manifest_only" },
  check: { includeContext: "check", detail: "summary", maxTurns: 4, maxToolCalls: 25, maxInputTokens: 30_000, maxOutputTokens: 4_000, writePolicy: "report_only" },
  finish: { includeContext: "finish", detail: "summary", maxTurns: 4, maxToolCalls: 25, maxInputTokens: 30_000, maxOutputTokens: 4_000, writePolicy: "report_only" },
};

export async function workflowDelegate(root: string, input: WorkflowDelegateInput): Promise<WorkflowDelegateOutput> {
  const startedAt = Date.now();
  const mode = input.mode ?? "dry_run";
  const agent = input.agent;
  const runId = makeRunId(agent);
  const defaults = DEFAULTS[agent];
  const task = await resolveTask(root, input.task);
  const warnings: WorkflowWarning[] = [];
  const blockers = task ? validateDelegateStage(task, agent) : [{ code: "missing_task", message: "workflow_delegate requires task or an active task.", severity: "blocking" } satisfies WorkflowBlocker];
  if (!defaults) blockers.push({ code: "unknown_agent", message: `Unknown workflow_delegate agent: ${agent}.`, severity: "blocking" });

  const includeContext = input.includeContext ?? defaults?.includeContext ?? "lite";
  const detail = input.detail ?? defaults?.detail ?? "summary";
  const maxTurns = positiveInt(input.maxTurns, defaults?.maxTurns ?? 4);
  const maxToolCalls = positiveInt(input.maxToolCalls, defaults?.maxToolCalls ?? 20);
  const maxInputTokens = positiveInt(input.maxInputTokens, defaults?.maxInputTokens ?? 30_000);
  const maxOutputTokens = positiveInt(input.maxOutputTokens, defaults?.maxOutputTokens ?? 4_000);
  const writePolicy = input.writePolicy ?? defaults?.writePolicy ?? "report_only";

  if (blockers.length > 0 || !task || !defaults) {
    return withDelegateTelemetry(root, decorateDelegateOutput({
      ok: false,
      task: task?.id,
      agent,
      mode,
      status: "blocked",
      runId,
      summary: blockers.map((blocker) => blocker.message).join("; "),
      changedFiles: [],
      evidenceRefs: [],
      metrics: emptyMetrics(),
      blockedBy: blockers,
      warnings,
    }, startedAt));
  }

  const next = await workflowNext(root, { task: task.id, agent, includeContext, detail });
  const brief = next.adaptiveControl?.subagentBriefs?.find((item) => item.agent === agent) ?? next.adaptiveControl?.subagentBriefs?.[0];
  const allowedPaths = await allowedPathsFor(root, task, writePolicy, input.allowedPaths ?? []);
  const prompt = buildDelegatePrompt({ task, agent, input, includeContext, detail, writePolicy, maxTurns, maxToolCalls, maxInputTokens, maxOutputTokens, brief, next, allowedPaths });
  const evidenceRefs = next.evidenceRefs ?? next.context?.evidenceRefs ?? [];
  const recommendedNext = recommendedNextFor(agent, task.id);

  if (mode !== "execute") {
    const artifact = await writeJsonArtifact(root, "agents", {
      kind: "pi-coding-workflow.delegate-plan",
      runId,
      task: task.id,
      agent,
      mode,
      includeContext,
      detail,
      writePolicy,
      budgets: { maxTurns, maxToolCalls, maxInputTokens, maxOutputTokens },
      allowedPaths,
      evidenceRefs,
      promptPreview: prompt.slice(0, 4_000),
      recommendedNext,
      createdAt: new Date().toISOString(),
    }, runId);
    return withDelegateTelemetry(root, decorateDelegateOutput({
      ok: true,
      task: task.id,
      agent,
      mode,
      status: "planned",
      runId,
      summary: `Dry-run workflow_delegate; would run ${agent} subagent for ${task.id} with ${writePolicy} policy, maxTurns=${maxTurns}, maxToolCalls=${maxToolCalls}.`,
      changedFiles: [],
      evidenceRefs,
      artifactRef: artifact.artifactRef,
      artifacts: [{ kind: "delegate-plan", ref: artifact.artifactRef, summary: `${agent} delegate dry-run plan` }],
      metrics: emptyMetrics(),
      blockedBy: [],
      warnings,
      recommendedNext,
    }, startedAt));
  }

  const beforeStatus = await gitStatus(root);
  const metrics = { turns: 0, toolCalls: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, truncated: false };
  let budgetExceeded = false;
  let failedError: string | undefined;
  let finalText = "";
  const transcript: unknown[] = [];

  let sdk: DelegateSdkSurface;
  let Type: any;
  try {
    sdk = await import("@earendil-works/pi-coding-agent") as unknown as DelegateSdkSurface;
    Type = (await import("typebox")).Type;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return withDelegateTelemetry(root, decorateDelegateOutput({
      ok: false,
      task: task.id,
      agent,
      mode,
      status: "failed",
      runId,
      summary: `Unable to load pi SDK for workflow_delegate execution: ${message}`,
      changedFiles: [],
      evidenceRefs,
      metrics: emptyMetrics(),
      blockedBy: [{ code: "delegate_sdk_unavailable", message: "workflow_delegate execute requires @earendil-works/pi-coding-agent to be resolvable at runtime.", severity: "blocking" }],
      warnings,
      recommendedNext,
    }, startedAt));
  }

  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: root,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPromptFor(agent),
    skillsOverride: (current: any) => ({ skills: [], diagnostics: current.diagnostics }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await resourceLoader.reload();

  const customTools = delegateWorkflowTools(root, agent, task.id, sdk.defineTool, Type);
  const { session } = await sdk.createAgentSession({
    cwd: root,
    resourceLoader,
    sessionManager: sdk.SessionManager.inMemory(root),
    customTools,
    tools: allowedToolNames(agent, writePolicy),
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_start") metrics.turns += 1;
    if (event.type === "tool_execution_start") metrics.toolCalls += 1;
    if ((input.stopOnToolBudget ?? true) && metrics.toolCalls > maxToolCalls) {
      budgetExceeded = true;
      void session.abort();
    }
    if (metrics.turns > maxTurns) {
      budgetExceeded = true;
      void session.abort();
    }
  });

  try {
    await session.prompt(prompt);
  } catch (error) {
    failedError = error instanceof Error ? error.message : String(error);
  } finally {
    unsubscribe();
  }

  const messages = sessionMessages(session);
  for (const message of messages) {
    const usage = (message as any).usage;
    if (usage) {
      metrics.estimatedInputTokens += Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0);
      metrics.estimatedOutputTokens += Number(usage.output ?? 0);
    }
  }
  finalText = lastAssistantText(messages);
  transcript.push(...messages.map(compactMessage));
  session.dispose();

  if ((input.stopOnTokenBudget ?? true) && (metrics.estimatedInputTokens > maxInputTokens || metrics.estimatedOutputTokens > maxOutputTokens)) {
    budgetExceeded = true;
  }

  const afterStatus = await gitStatus(root);
  const changedFiles = changedFilesSince(beforeStatus, afterStatus);
  const unauthorized = unauthorizedChanges(changedFiles, allowedPaths, writePolicy);
  if (unauthorized.length > 0) {
    blockers.push({ code: "delegate_unauthorized_changes", message: `Subagent changed files outside ${writePolicy} policy: ${unauthorized.slice(0, 8).join(", ")}`, severity: "blocking" });
  }
  if (failedError && !budgetExceeded) warnings.push({ code: "delegate_prompt_error", message: failedError });
  if (budgetExceeded) blockers.push({ code: "delegate_budget_exceeded", message: `Subagent exceeded budget maxTurns=${maxTurns}, maxToolCalls=${maxToolCalls}, maxInputTokens=${maxInputTokens}, maxOutputTokens=${maxOutputTokens}.`, severity: "blocking" });

  const truncatedSummary = truncateText(finalText || failedError || `${agent} delegate finished without text output.`, 2_400);
  metrics.truncated = truncatedSummary.truncatedBytes > 0;
  const status = budgetExceeded ? "budget_exceeded" : blockers.length > 0 ? "blocked" : failedError ? "failed" : "needs_parent_action";
  const ok = status === "needs_parent_action";
  const artifact = await writeJsonArtifact(root, "agents", {
    kind: "pi-coding-workflow.delegate-run",
    runId,
    task: task.id,
    agent,
    mode,
    status,
    includeContext,
    detail,
    writePolicy,
    budgets: { maxTurns, maxToolCalls, maxInputTokens, maxOutputTokens },
    metrics,
    changedFiles,
    allowedPaths,
    evidenceRefs,
    blockedBy: blockers,
    warnings,
    recommendedNext,
    finalText,
    transcript,
    createdAt: new Date().toISOString(),
  }, runId);

  return withDelegateTelemetry(root, decorateDelegateOutput({
    ok,
    task: task.id,
    agent,
    mode,
    status,
    runId,
    summary: truncatedSummary.text,
    changedFiles,
    evidenceRefs,
    artifactRef: artifact.artifactRef,
    artifacts: [{ kind: "delegate-run", ref: artifact.artifactRef, summary: `${agent} delegate ${status}` }],
    metrics,
    blockedBy: blockers,
    warnings,
    recommendedNext,
  }, startedAt));
}

async function resolveTask(root: string, id?: string): Promise<WorkflowTaskJson | null> {
  if (id) return tryReadTask(root, id);
  return findActiveTask(root);
}

function validateDelegateStage(task: WorkflowTaskJson, agent: WorkflowAgent): WorkflowBlocker[] {
  if (agent === "research" && task.status !== "planning") return [{ code: "delegate_stage_mismatch", message: "research delegate requires a planning task.", severity: "blocking", path: `.workflow/tasks/${task.id}/task.json` }];
  if ((agent === "implement" || agent === "check" || agent === "finish") && task.status !== "in_progress") return [{ code: "delegate_stage_mismatch", message: `${agent} delegate requires an in_progress task.`, severity: "blocking", path: `.workflow/tasks/${task.id}/task.json` }];
  return [];
}

async function allowedPathsFor(root: string, task: WorkflowTaskJson, policy: DelegateWritePolicy, explicit: string[]): Promise<string[]> {
  const normalizedExplicit = explicit.map(normalizeAllowedPath);
  const taskDir = `.workflow/tasks/${task.id}/`;
  if (policy === "report_only") return normalizedExplicit;
  if (policy === "task_files_only") return [...new Set([taskDir, ...normalizedExplicit])];
  const manifests = await readTaskManifests(root, task);
  return [...new Set([...manifestFiles(manifests).map(normalizeAllowedPath), taskDir, ...normalizedExplicit])];
}

function normalizeAllowedPath(path: string): string {
  return normalizeSlash(path).replace(/^\.\//, "");
}

function unauthorizedChanges(changedFiles: string[], allowedPaths: string[], policy: DelegateWritePolicy): string[] {
  if (policy === "report_only") return changedFiles;
  return changedFiles.filter((file) => !allowedPaths.some((allowed) => pathMatches(file, allowed)));
}

function pathMatches(file: string, allowed: string): boolean {
  const f = normalizeAllowedPath(file);
  const a = normalizeAllowedPath(allowed);
  if (!a) return false;
  if (a.endsWith("/")) return f.startsWith(a);
  return f === a || f.startsWith(`${a}/`);
}

async function gitStatus(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "status", "--short"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    return stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return [];
  }
}

function changedFilesSince(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before);
  const changed = after.filter((line) => !beforeSet.has(line));
  return changed.map((line) => normalizeAllowedPath(line.slice(3).replace(/.* -> /, ""))).filter(Boolean);
}

function allowedToolNames(agent: WorkflowAgent, policy: DelegateWritePolicy): string[] {
  const workflow = ["workflow_next", "workflow_run"];
  if (agent === "research") return ["read", "grep", "find", "ls", ...workflow];
  if (agent === "implement" && policy === "manifest_only") return ["read", "grep", "find", "ls", "edit", "write", "bash", ...workflow];
  if (policy === "task_files_only") return ["read", "grep", "find", "ls", "edit", "write", ...workflow];
  return ["read", "grep", "find", "ls", "bash", ...workflow];
}

function delegateWorkflowTools(root: string, agent: WorkflowAgent, taskId: string, defineTool: any, Type: any) {
  const workflowNextTool = defineTool({
    name: "workflow_next",
    label: "Workflow Next",
    description: "Read-only workflow router for the delegated task.",
    parameters: Type.Object({
      task: Type.Optional(Type.String()),
      agent: Type.Optional(Type.String()),
      includeContext: Type.Optional(Type.String()),
      detail: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId: string, params: any) => {
      const output = await workflowNext(root, { task: params.task ?? taskId, agent: params.agent ?? agent, includeContext: params.includeContext, detail: params.detail });
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
    },
  });

  const workflowRunTool = defineTool({
    name: "workflow_run",
    label: "Workflow Run Dry-Run",
    description: "Workflow preflight dry-run helper. Execute mutations are blocked inside delegates.",
    parameters: Type.Object({
      action: Type.String(),
      task: Type.Optional(Type.String()),
      mode: Type.Optional(Type.String()),
      phase: Type.Optional(Type.String()),
      detail: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId: string, params: any) => {
      if (params.mode === "execute") {
        const blocked = { ok: false, blockedBy: [{ code: "delegate_workflow_run_execute_blocked", message: "workflow_delegate subagents may only call workflow_run in dry_run mode." }] };
        return { content: [{ type: "text" as const, text: JSON.stringify(blocked) }], details: blocked, isError: true } as any;
      }
      const output = await workflowRun(root, { ...params, task: params.task ?? taskId, mode: "dry_run" });
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: output };
    },
  });

  return [workflowNextTool, workflowRunTool];
}

function buildDelegatePrompt(input: { task: WorkflowTaskJson; agent: WorkflowAgent; input: WorkflowDelegateInput; includeContext: ContextMode; detail: DetailMode; writePolicy: DelegateWritePolicy; maxTurns: number; maxToolCalls: number; maxInputTokens: number; maxOutputTokens: number; brief: unknown; next: unknown; allowedPaths: string[] }): string {
  const { task, agent } = input;
  return [
    `You are a bounded ${agent} subagent for pi-coding-workflow task ${task.id}.`,
    "",
    "You are a worker, not the workflow authority. Do not claim the task is complete unless workflow_run preflight evidence supports it.",
    "Do not ask the user directly. If a human decision is needed, report needs_user in your final summary.",
    "Do not spawn or request another subagent.",
    "Use workflow_run only in dry_run mode. Never run finalize_grill, finish_run execute, archive, or final confirmation.",
    "",
    `Objective: ${input.input.objective ?? defaultObjective(agent)}`,
    `Task: ${task.title} (${task.status}/${task.stage}/${task.flowLevel})`,
    `Context mode: ${input.includeContext}; detail: ${input.detail}`,
    `Write policy: ${input.writePolicy}`,
    `Allowed paths: ${input.allowedPaths.length ? input.allowedPaths.join(", ") : "none"}`,
    `Budgets: maxTurns=${input.maxTurns}; maxToolCalls=${input.maxToolCalls}; maxInputTokens=${input.maxInputTokens}; maxOutputTokens=${input.maxOutputTokens}`,
    "",
    "Workflow brief:",
    JSON.stringify(input.brief ?? input.next, null, 2).slice(0, 12_000),
    "",
    "Required final response format:",
    "- Status: completed | blocked | needs_user | needs_parent_action | failed",
    "- Summary: 3-8 bullets",
    "- Changed files: list or None",
    "- Evidence refs: list refs or commands used",
    "- Blockers: list exact blocker codes/messages or None",
    "- Recommended next workflow call: workflow_run/workflow_next arguments, or None",
  ].join("\n");
}

function defaultObjective(agent: WorkflowAgent): string {
  if (agent === "research") return "Resolve planning uncertainty and return concrete PRD/spec decisions or user questions.";
  if (agent === "implement") return "Implement the next manifest-backed slice with the smallest allowed changes.";
  if (agent === "check") return "Check the current diff and validation evidence against the PRD and manifests.";
  return "Verify finish gates and recommend whether finish_run dry-run is ready.";
}

function systemPromptFor(agent: WorkflowAgent): string {
  return `You are a concise, bounded ${agent} subagent inside pi-coding-workflow. Follow the provided workflow brief, respect budgets and path policy, and return only a compact report.`;
}

function recommendedNextFor(agent: WorkflowAgent, task: string): WorkflowRecommendedCall {
  if (agent === "research") return { name: "workflow_next", arguments: { task, includeContext: "lite" } };
  if (agent === "implement") return { name: "workflow_run", arguments: { action: "checkpoint", mode: "dry_run", task, phase: "after-implementation" } };
  if (agent === "check") return { name: "workflow_run", arguments: { action: "checkpoint", mode: "dry_run", task, phase: "after-check" } };
  return { name: "workflow_run", arguments: { action: "finish_run", mode: "dry_run", task } };
}

function sessionMessages(session: DelegateSession): unknown[] {
  return session.messages ?? session.state?.messages ?? session.agent?.state?.messages ?? [];
}

function lastAssistantText(messages: any[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n").trim();
      if (text) return text;
    }
  }
  return "";
}

function compactMessage(message: any): unknown {
  const role = message.role;
  const usage = message.usage;
  const content = Array.isArray(message.content)
    ? message.content.map((block: any) => block?.type === "text" ? { type: "text", text: truncateText(block.text ?? "", 1_000).text } : { type: block?.type, name: block?.name })
    : truncateText(String(message.content ?? ""), 1_000).text;
  return { role, usage, content };
}

function makeRunId(agent: WorkflowAgent): string {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}`;
  return `delegate-${agent}-${stamp}-${randomBytes(3).toString("hex")}`;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function emptyMetrics(): WorkflowDelegateOutput["metrics"] {
  return { turns: 0, toolCalls: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, truncated: false };
}

async function withDelegateTelemetry(root: string, output: WorkflowDelegateOutput): Promise<WorkflowDelegateOutput> {
  await writeWorkflowTelemetry(root, "workflow_delegate", output);
  return output;
}

function decorateDelegateOutput(output: WorkflowDelegateOutput, startedAt: number): WorkflowDelegateOutput {
  const compactForBudget = {
    ok: output.ok,
    task: output.task,
    agent: output.agent,
    mode: output.mode,
    status: output.status,
    summary: output.summary,
    changedFiles: output.changedFiles,
    artifactRef: output.artifactRef,
    blockedBy: output.blockedBy,
    warnings: output.warnings,
    recommendedNext: output.recommendedNext,
  };
  return {
    ...output,
    meta: {
      estimatedTokens: estimateTokens(compactForBudget),
      targetTokens: DELEGATE_RESULT_TARGET_TOKENS,
      maxRecommendedTokens: RUN_RESULT_TARGET_TOKENS,
      truncatedBytes: 0,
      omittedRefs: output.artifactRef ? [output.artifactRef] : [],
      durationMs: Date.now() - startedAt,
      cacheHit: false,
    },
  };
}
