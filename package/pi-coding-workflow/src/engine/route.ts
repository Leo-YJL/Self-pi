import { existsSync } from "node:fs";
import type { DetailMode, WorkflowContextSummary, WorkflowNextInput, WorkflowNextOutput, WorkflowOmittedArtifact, WorkflowResultMeta } from "../types.ts";
import { readConfig } from "./config.ts";
import { listRootTasks, tryReadTask, type WorkflowTaskJson } from "./task.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";
import { buildContextBundle, type WorkflowContextBundle } from "./contextBundle.ts";
import { contextBudgetPolicy, estimateTokens, omitted, tokenBudget, truncateText } from "./contextBudget.ts";
import { computeWorkflowNextCacheKey, readWorkflowNextCache, writeWorkflowNextCache } from "./cache.ts";
import { writeJsonArtifact } from "../artifacts/writeToolResult.ts";
import { readWorkflowTelemetrySummary, writeWorkflowTelemetry } from "./telemetry.ts";
import { buildAdaptiveControl, compactAdaptiveControl } from "./adaptive.ts";
import { isGrillFinalized } from "./grill.ts";
import { readGitPorcelain } from "./gitPorcelain.ts";

export async function workflowNext(root: string, input: WorkflowNextInput = {}): Promise<WorkflowNextOutput> {
  const startedAt = Date.now();
  const config = await readConfig(root);
  const hasWorkflow = existsSync(resolveInsideRoot(root, ".workflow"));
  const includeContext = input.includeContext ?? "lite";
  const allTasks = hasWorkflow ? await listRootTasks(root) : [];
  const requestedTask = hasWorkflow && input.task ? await tryReadTask(root, input.task) : null;
  const activeTask = requestedTask ?? selectActiveTask(allTasks);
  let output: WorkflowNextOutput;

  if (!hasWorkflow) {
    output = finalizeNext({
      ok: true,
      status: "no_task",
      nextAction: "ask_user",
      blockedBy: [],
      warnings: [{ code: "workflow_dir_missing", message: "No .workflow directory found. Run /workflow-init first." }],
      context: includeContext === "none" ? undefined : emptyContext(includeContext, "Workflow not initialized.", ["workflow:init"], input.detail),
      cache: { stableKey: "workflow-next:v2:no-workflow", cacheFriendly: true, hit: false },
    }, startedAt);
  } else if (input.task && !requestedTask) {
    output = finalizeNext({
      ok: false,
      status: "no_task",
      nextAction: "blocked",
      recommendedTool: { name: "workflow_next", arguments: {} },
      blockedBy: [{ code: "task_not_found", message: `Workflow task not found: ${input.task}`, severity: "blocking", path: `.workflow/tasks/${input.task}/task.json` }],
      warnings: config ? [] : [{ code: "workflow_config_missing", message: "No .workflow/config.json found. Run /workflow-init first." }],
      context: includeContext === "none" ? undefined : emptyContext(includeContext, `Workflow task not found: ${input.task}`, ["tasks:active:none"], input.detail),
      cache: { stableKey: "workflow-next:v2:task-not-found", cacheFriendly: false, hit: false },
    }, startedAt);
  } else if (!activeTask) {
    output = finalizeNext({
      ok: true,
      status: "no_task",
      nextAction: "no_task_grill",
      recommendedTool: { name: "workflow_run", arguments: { action: "create_from_grill", mode: "dry_run", profile: config?.project.profile ?? "generic" } },
      blockedBy: [],
      warnings: config ? [] : [{ code: "workflow_config_missing", message: "No .workflow/config.json found. Run /workflow-init first." }],
      context: includeContext === "none" ? undefined : emptyContext(includeContext, config ? `Workflow profile: ${config.project.profile}; no active task.` : "Workflow not initialized.", ["workflow:config", "tasks:active:none"], input.detail),
      cache: { stableKey: "workflow-next:v2:no-task", cacheFriendly: true, hit: false },
    }, startedAt);
  } else {
    output = finalizeNext(await routeForTask(root, config?.project.profile ?? "generic", activeTask, input), startedAt);
  }

  if (hasWorkflow && !input.task) output = attachTaskCandidates(output, allTasks);
  await writeWorkflowTelemetry(root, "workflow_next", output);
  return output;
}

async function routeForTask(root: string, profile: string, task: WorkflowTaskJson, input: WorkflowNextInput): Promise<WorkflowNextOutput> {
  const includeContext = input.includeContext ?? "lite";
  const next = nextActionForTask(task, input.agent);
  // Fetch `git status --porcelain` once per call — both the cache key fingerprint
  // and the workspace summary inside the context bundle need it. Without this share
  // a cache-miss path would spawn `git` twice (cost ~30–80ms on Windows).
  const needsPorcelain = isWorkflowNextCacheable(includeContext, input.detail) || includeContext !== "none";
  const porcelain = needsPorcelain ? await readGitPorcelain(root) : undefined;
  const workflowCacheKey = isWorkflowNextCacheable(includeContext, input.detail)
    ? await computeWorkflowNextCacheKey(root, task, { profile, includeContext, detail: input.detail, agent: input.agent }, porcelain)
    : undefined;
  if (workflowCacheKey) {
    const cached = await readWorkflowNextCache(root, workflowCacheKey);
    if (cached) return cached;
  }

  const bundle = includeContext === "none" ? null : await buildContextBundle(root, task, { mode: includeContext, agent: input.agent, profile, detail: input.detail, porcelain });
  const telemetrySummary = await readWorkflowTelemetrySummary(root, task.id);
  const includeDecisionCards = input.detail === "normal" || input.detail === "full";
  const adaptiveControl = bundle ? compactAdaptiveControl(buildAdaptiveControl({ bundle, nextAction: next.nextAction, recommendedTool: next.recommendedTool, requestedAgent: input.agent }), { signal: includeContext === "signal", lite: includeContext === "lite", includeDecisionCards }) : undefined;
  const context = bundle ? await contextFromBundle(root, bundle, input.detail, adaptiveControl) : undefined;
  const recommendedTool = adaptiveControl?.strategy === "deterministic_preflight" && adaptiveControl.deterministicActions[0]
    ? adaptiveControl.deterministicActions[0]
    : adaptiveControl?.strategy === "subagent_brief" && adaptiveControl.delegateRecommendedCall ? adaptiveControl.delegateRecommendedCall : next.recommendedTool;
  const output: WorkflowNextOutput = {
    ok: true,
    status: task.status,
    task: task.id,
    stage: task.stage,
    flowLevel: task.flowLevel,
    nextAction: next.nextAction,
    recommendedTool,
    blockedBy: shouldInlineBlockers(includeContext, input.detail) ? bundle?.blockedBy ?? [] : [],
    warnings: [...(bundle?.warnings ?? []), ...telemetrySummary.warnings],
    context,
    // evidenceRefs / omitted / tokenBudget are canonically embedded inside `context.*`.
    // Top-level mirrors used to duplicate the same payload (~100 tokens / call); they
    // are no longer populated. `finalizeNext` and downstream consumers fall back to
    // `context.*`. Types remain optional for backward compatibility with old caches.
    adaptiveControl,
    blockedCodes: bundle?.blockedBy.map((blocker) => blocker.code) ?? [],
    warningCodes: [...(bundle?.warnings ?? []), ...telemetrySummary.warnings].map((warning) => warning.code),
    strategy: adaptiveControl?.strategy,
    recommendedAgent: adaptiveControl?.recommendedAgent,
    detailRef: context?.detailRef,
    cache: {
      stableKey: "workflow-next:v2",
      cacheFriendly: true,
      hit: false,
      taskKey: `${task.id}:${task.status}:${task.stage}:${task.flowLevel}`,
      dynamicKey: bundle?.prd.source.hash ? `${bundle.prd.source.hash}:${bundle.manifests.implement.hash ?? ""}:${bundle.manifests.check.hash ?? ""}` : undefined,
      cacheKey: workflowCacheKey ?? (bundle?.prd.source.hash ? `${task.id}:${task.status}:${task.stage}:${includeContext}:${input.detail ?? "summary"}:${bundle.prd.source.hash}:${bundle.manifests.implement.hash ?? ""}:${bundle.manifests.check.hash ?? ""}` : undefined),
    },
  };
  if (workflowCacheKey) await writeWorkflowNextCache(root, workflowCacheKey, output);
  return output;
}

function selectActiveTask(tasks: WorkflowTaskJson[]): WorkflowTaskJson | null {
  return tasks.find((task) => task.status === "in_progress")
    ?? tasks.find((task) => task.status === "planning")
    ?? null;
}

function attachTaskCandidates(output: WorkflowNextOutput, tasks: WorkflowTaskJson[]): WorkflowNextOutput {
  const active = tasks.filter((task) => task.status === "in_progress" || task.status === "planning");
  if (active.length === 0) return output;
  const inProgress = active.filter((task) => task.status === "in_progress");
  const planning = active.filter((task) => task.status === "planning");
  const warnings = [...output.warnings];
  if (inProgress.length > 1) warnings.unshift({ code: "multiple_in_progress_tasks", message: `Multiple in-progress workflow tasks exist; pass task explicitly. Candidates: ${inProgress.map((task) => task.id).slice(0, 8).join(", ")}` });
  else if (inProgress.length === 0 && planning.length > 1) warnings.unshift({ code: "multiple_planning_tasks", message: `Multiple planning workflow tasks exist; pass task explicitly. Candidates: ${planning.map((task) => task.id).slice(0, 8).join(", ")}` });
  return {
    ...output,
    warnings,
    taskCandidates: active.slice(0, 12).map((task) => ({ id: task.id, title: task.title, status: task.status, stage: task.stage, flowLevel: task.flowLevel, updatedAt: task.updatedAt })),
  };
}

function isWorkflowNextCacheable(includeContext: WorkflowNextInput["includeContext"], detail: WorkflowNextInput["detail"]): boolean {
  if (!includeContext || includeContext === "lite" || includeContext === "brief" || includeContext === "signal") return detail !== "full" && detail !== "normal";
  return false;
}

function shouldInlineBlockers(includeContext: WorkflowNextInput["includeContext"], detail: WorkflowNextInput["detail"]): boolean {
  if (detail === "normal" || detail === "full") return true;
  return includeContext !== "lite" && includeContext !== "signal";
}

function emptyContext(mode: WorkflowContextSummary["mode"], summaryText: string, evidenceRefs: string[], detail: DetailMode = "summary"): WorkflowContextSummary {
  const policy = contextBudgetPolicy(mode, detail);
  const truncated = truncateText(summaryText, policy.maxSummaryChars || summaryText.length);
  const context = { mode, summary: truncated.text, evidenceRefs };
  return {
    ...context,
    omitted: [],
    tokenBudget: tokenBudget(context, policy.maxRecommendedTokens, { truncatedBytes: truncated.truncatedBytes, omitted: [] }),
  };
}

async function contextFromBundle(root: string, bundle: WorkflowContextBundle, detail: DetailMode = "summary", adaptiveControl?: WorkflowContextSummary["adaptiveControl"]): Promise<WorkflowContextSummary> {
  const policy = contextBudgetPolicy(bundle.mode, detail);
  const evidenceRefs = evidenceRefsFor(bundle);
  const omittedItems: WorkflowOmittedArtifact[] = [];
  const includeInlineSummary = bundle.mode !== "signal" && bundle.mode !== "lite";
  const truncatedSummary = includeInlineSummary ? truncateText(bundle.summary, policy.maxSummaryChars || bundle.summary.length) : { text: "", truncatedBytes: 0 };
  let truncatedBytes = truncatedSummary.truncatedBytes;
  let details: unknown;
  let detailRef: string | undefined;

  if (bundle.mode === "signal") {
    const payload = {
      kind: "pi-coding-workflow.context",
      schemaVersion: 1,
      mode: bundle.mode,
      task: bundle.task,
      prd: bundle.prd,
      manifests: {
        implement: compactManifest(bundle.manifests.implement),
        check: compactManifest(bundle.manifests.check),
      },
      workspace: bundle.workspace,
      blockedBy: bundle.blockedBy,
      warnings: bundle.warnings,
      adaptiveControl,
      createdAt: new Date().toISOString(),
    };
    // Deterministic id keyed on task + prd/manifest hashes: identical content reuses
    // the same artifact file instead of writing a near-duplicate on every signal call.
    const prdHash = bundle.prd.source.hash ?? "missing";
    const implHash = bundle.manifests.implement.hash ?? "missing";
    const checkHash = bundle.manifests.check.hash ?? "missing";
    const artifact = await writeJsonArtifact(root, "context", payload, `signal-${bundle.task.id}-${prdHash}-${implHash}-${checkHash}`);
    detailRef = artifact.artifactRef;
  } else if (policy.includeDetails) {
    details = detailedContext(bundle);
    const detailsTokens = estimateTokens(details);
    if (detailsTokens > policy.maxRecommendedTokens) {
      omittedItems.push(omitted("context.details", "workflow_next.details", details, `Details exceeded ${policy.maxRecommendedTokens} token budget; returning brief details.`));
      details = briefDetails(bundle);
    }
  } else {
    omittedItems.push(omitted("context.details", "workflow_next.details", detailedContext(bundle), `${bundle.mode} mode returns evidence refs instead of full details.`));
  }

  const summary = includeInlineSummary ? truncatedSummary.text : "";
  const valueForBudget = { summary, evidenceRefs, details, detailRef };
  return {
    mode: bundle.mode,
    summary,
    prdHash: bundle.prd.source.hash,
    evidenceRefs,
    omitted: omittedItems,
    tokenBudget: tokenBudget(valueForBudget, policy.maxRecommendedTokens, { truncatedBytes, omitted: omittedItems }),
    details,
    detailRef,
  };
}

function detailedContext(bundle: WorkflowContextBundle): unknown {
  return {
    task: bundle.task,
    prd: bundle.prd,
    manifests: {
      implement: compactManifest(bundle.manifests.implement),
      check: compactManifest(bundle.manifests.check),
    },
    workspace: bundle.workspace,
    recommendedNext: bundle.recommendedNext,
  };
}

function briefDetails(bundle: WorkflowContextBundle): unknown {
  return {
    task: bundle.task,
    prd: {
      title: bundle.prd.title,
      source: bundle.prd.source,
      openQuestions: bundle.prd.openQuestions,
      finalConfirmation: bundle.prd.finalConfirmation,
      quality: bundle.prd.quality,
      summary: bundle.prd.summary,
    },
    manifests: {
      implement: manifestBrief(bundle.manifests.implement),
      check: manifestBrief(bundle.manifests.check),
    },
    workspace: {
      isGit: bundle.workspace.isGit,
      dirtyCount: bundle.workspace.dirtyCount,
      inScopeCount: bundle.workspace.inScopeCount,
      taskFileCount: bundle.workspace.taskFileCount,
      unrelatedCount: bundle.workspace.unrelatedCount,
      summary: bundle.workspace.summary,
    },
    recommendedNext: bundle.recommendedNext,
  };
}

function compactManifest(manifest: WorkflowContextBundle["manifests"]["implement"]): unknown {
  return {
    agent: manifest.agent,
    path: manifest.path,
    exists: manifest.exists,
    hash: manifest.hash,
    entries: manifest.entries,
    missingFiles: manifest.missingFiles,
    issues: manifest.issues,
    summary: manifest.summary,
  };
}

function manifestBrief(manifest: WorkflowContextBundle["manifests"]["implement"]): unknown {
  return {
    agent: manifest.agent,
    path: manifest.path,
    exists: manifest.exists,
    hash: manifest.hash,
    entryCount: manifest.entries.length,
    missingCount: manifest.missingFiles.length,
    issueCount: manifest.issues.length,
    summary: manifest.summary,
  };
}

function evidenceRefsFor(bundle: WorkflowContextBundle): string[] {
  const refs = [
    `task:${bundle.task.id}`,
    `prd:${bundle.prd.source.hash ?? "missing"}`,
    `manifest:implement:${bundle.manifests.implement.hash ?? "missing"}`,
    `manifest:check:${bundle.manifests.check.hash ?? "missing"}`,
    "workspace:git-status",
  ];
  if (bundle.blockedBy.length > 0) refs.push(...bundle.blockedBy.slice(0, 6).map((blocker) => `blocker:${blocker.code}`));
  return refs;
}

function finalizeNext(output: WorkflowNextOutput, startedAt: number): WorkflowNextOutput {
  const omittedRefs = output.omitted?.map((item) => item.ref) ?? output.context?.omitted?.map((item) => item.ref) ?? [];
  const truncatedBytes = output.tokenBudget?.truncatedBytes ?? output.context?.tokenBudget?.truncatedBytes ?? 0;
  const estimatedTokens = output.tokenBudget?.estimatedInput ?? output.context?.tokenBudget?.estimatedInput ?? estimateTokens({
    status: output.status,
    task: output.task,
    nextAction: output.nextAction,
    blockedBy: output.blockedBy,
    warnings: output.warnings,
  });
  const meta: WorkflowResultMeta = {
    estimatedTokens,
    targetTokens: output.context?.tokenBudget?.maxRecommended,
    maxRecommendedTokens: output.context?.tokenBudget?.maxRecommended,
    truncatedBytes,
    omittedRefs,
    durationMs: Date.now() - startedAt,
    cacheHit: output.cache?.hit ?? output.context?.tokenBudget?.cacheHit ?? false,
  };
  return {
    ...output,
    // Top-level evidenceRefs/omitted/tokenBudget were deduplicated in v0.4.0; consumers
    // read these from `output.context.*`. We only re-attach `adaptiveControl` because it
    // is computed at the route level (not embedded in context for non-signal modes).
    adaptiveControl: output.adaptiveControl ?? output.context?.adaptiveControl,
    meta,
  };
}

function nextActionForTask(task: WorkflowTaskJson, agent: WorkflowNextInput["agent"]): Pick<WorkflowNextOutput, "nextAction" | "recommendedTool"> {
  if (task.status === "planning") {
    if (!isGrillFinalized(task)) {
      return { nextAction: "ask_user" };
    }
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
