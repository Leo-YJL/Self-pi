import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkflowDelegateOutput, WorkflowNextOutput, WorkflowRunOutput, WorkflowWarning } from "../types.ts";
import { normalizeSlash, resolveInsideRoot } from "../safety/pathPolicy.ts";
import { PACKAGE_VERSION } from "../version.ts";

const TELEMETRY_SCHEMA_VERSION = 1;
const MAX_TELEMETRY_FILE_BYTES = 512 * 1024;

export type WorkflowTelemetryEventName = "workflow_next" | "workflow_run" | "workflow_delegate";

export interface WorkflowTelemetryEvent {
  schemaVersion: 1;
  kind: "pi-coding-workflow.telemetry";
  package: { name: "pi-coding-workflow"; version: string };
  event: WorkflowTelemetryEventName;
  createdAt: string;
  ok: boolean;
  task?: string;
  status?: string;
  stage?: string;
  action?: string;
  mode?: string;
  nextAction?: string;
  contextMode?: string;
  cacheHit?: boolean;
  estimatedTokens?: number;
  targetTokens?: number;
  truncatedBytes?: number;
  omittedRefs: string[];
  artifactRefs: string[];
  blockerCodes: string[];
  warningCodes: string[];
  transaction?: { id?: string; state?: string; plannedActions?: number; rollbackHints?: number; artifactRef?: string };
  durationMs?: number;
}

export interface WorkflowTelemetryWriteResult {
  ok: boolean;
  artifactRef?: string;
  bytes?: number;
  skippedReason?: string;
  error?: string;
}

export interface WorkflowTelemetrySummary {
  task?: string;
  workflowNextCount: number;
  workflowNextSignalCount: number;
  workflowNextLiteCount: number;
  workflowRunCount: number;
  workflowDelegateCount: number;
  estimatedTokens: number;
  warnings: WorkflowWarning[];
}

const WARN_WORKFLOW_NEXT_COUNT = 12;
const WARN_WORKFLOW_NEXT_SIGNAL_SUGGESTED_COUNT = 5;
const WARN_WORKFLOW_RUN_COUNT = 24;
const WARN_WORKFLOW_DELEGATE_COUNT = 8;
const WARN_ESTIMATED_TOKENS = 80_000;

export async function readWorkflowTelemetrySummary(root: string, task?: string): Promise<WorkflowTelemetrySummary> {
  const events = await readRecentTelemetryEvents(root, task);
  const workflowNextEvents = events.filter((event) => event.event === "workflow_next");
  const workflowNextCount = workflowNextEvents.length;
  const workflowNextSignalCount = workflowNextEvents.filter((event) => event.contextMode === "signal").length;
  const workflowNextLiteCount = workflowNextEvents.filter((event) => event.contextMode === "lite").length;
  const workflowRunCount = events.filter((event) => event.event === "workflow_run").length;
  const workflowDelegateCount = events.filter((event) => event.event === "workflow_delegate").length;
  const estimatedTokens = events.reduce((sum, event) => sum + (Number.isFinite(event.estimatedTokens) ? event.estimatedTokens ?? 0 : 0), 0);
  const warnings: WorkflowWarning[] = [];
  if (workflowNextCount >= WARN_WORKFLOW_NEXT_COUNT) warnings.push({ code: "workflow_next_repeated", message: `workflow_next has been called ${workflowNextCount} time(s) for ${task ?? "this workspace"}; consider batching deterministic steps or using cached evidence refs.` });
  if (workflowNextLiteCount >= WARN_WORKFLOW_NEXT_SIGNAL_SUGGESTED_COUNT && workflowNextSignalCount === 0) warnings.push({ code: "workflow_next_signal_suggested", message: `workflow_next has used lite context ${workflowNextLiteCount} time(s) with no signal calls for ${task ?? "this workspace"}; prefer includeContext=signal for routing and request richer context only when refs are insufficient.` });
  if (workflowRunCount >= WARN_WORKFLOW_RUN_COUNT) warnings.push({ code: "workflow_run_repeated", message: `workflow_run has been called ${workflowRunCount} time(s) for ${task ?? "this workspace"}; consider combining deterministic actions with batch.` });
  if (workflowDelegateCount >= WARN_WORKFLOW_DELEGATE_COUNT) warnings.push({ code: "workflow_delegate_repeated", message: `workflow_delegate has been called ${workflowDelegateCount} time(s) for ${task ?? "this workspace"}; narrow the delegate objective or continue manually from the artifact summary.` });
  if (estimatedTokens >= WARN_ESTIMATED_TOKENS) warnings.push({ code: "workflow_estimated_tokens_high", message: `Workflow telemetry estimated ${estimatedTokens} tokens for ${task ?? "this workspace"}; consider compaction or a fresh task/session.` });
  return { task, workflowNextCount, workflowNextSignalCount, workflowNextLiteCount, workflowRunCount, workflowDelegateCount, estimatedTokens, warnings };
}

export async function writeWorkflowTelemetry(root: string, event: WorkflowTelemetryEventName, output: WorkflowNextOutput | WorkflowRunOutput | WorkflowDelegateOutput): Promise<WorkflowTelemetryWriteResult> {
  try {
    if (!existsSync(resolveInsideRoot(root, ".workflow"))) {
      return { ok: false, skippedReason: "workflow_dir_missing" };
    }

    const telemetryEvent = toTelemetryEvent(event, output);
    const artifactRef = await chooseTelemetryFile(root);
    const absolutePath = resolveInsideRoot(root, artifactRef);
    await mkdir(dirname(absolutePath), { recursive: true });
    const line = `${JSON.stringify(telemetryEvent)}\n`;
    await appendFile(absolutePath, line, "utf8");
    return { ok: true, artifactRef, bytes: Buffer.byteLength(line, "utf8") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readRecentTelemetryEvents(root: string, task?: string): Promise<WorkflowTelemetryEvent[]> {
  try {
    const dir = ".workflow/.runtime/telemetry";
    const absDir = resolveInsideRoot(root, dir);
    if (!existsSync(absDir)) return [];
    const entries = await readdir(absDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => normalizeSlash(`${dir}/${entry.name}`))
      .sort()
      .slice(-6);
    const events: WorkflowTelemetryEvent[] = [];
    for (const file of files) {
      const text = await readFile(resolveInsideRoot(root, file), "utf8");
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        try {
          const event = JSON.parse(line) as WorkflowTelemetryEvent;
          if (event.kind !== "pi-coding-workflow.telemetry") continue;
          if (task && event.task !== task) continue;
          events.push(event);
        } catch {
          // Ignore malformed runtime telemetry lines.
        }
      }
    }
    return events;
  } catch {
    return [];
  }
}

function toTelemetryEvent(event: WorkflowTelemetryEventName, output: WorkflowNextOutput | WorkflowRunOutput | WorkflowDelegateOutput): WorkflowTelemetryEvent {
  const run = "action" in output ? output : undefined;
  const next = "recommendedTool" in output ? output : undefined;
  const delegate = "runId" in output ? output : undefined;
  const artifactRefs = run?.artifacts?.map((artifact) => artifact.ref) ?? delegate?.artifacts?.map((artifact) => artifact.ref) ?? (run?.artifactRef ? [run.artifactRef] : delegate?.artifactRef ? [delegate.artifactRef] : []);
  const omittedRefs = output.meta?.omittedRefs
    ?? next?.omitted?.map((item) => item.ref)
    ?? next?.context?.omitted?.map((item) => item.ref)
    ?? [];

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    kind: "pi-coding-workflow.telemetry",
    package: { name: "pi-coding-workflow", version: PACKAGE_VERSION },
    event,
    createdAt: new Date().toISOString(),
    ok: output.ok,
    task: output.task,
    status: output.status,
    stage: output.stage,
    action: run?.action,
    mode: run?.mode,
    nextAction: output.nextAction,
    contextMode: next?.context?.mode,
    cacheHit: output.meta?.cacheHit ?? next?.cache?.hit ?? next?.tokenBudget?.cacheHit,
    estimatedTokens: output.meta?.estimatedTokens ?? next?.tokenBudget?.estimatedInput,
    targetTokens: output.meta?.targetTokens ?? output.meta?.maxRecommendedTokens ?? next?.tokenBudget?.maxRecommended,
    truncatedBytes: output.meta?.truncatedBytes ?? next?.tokenBudget?.truncatedBytes,
    omittedRefs,
    artifactRefs,
    blockerCodes: next?.blockedCodes ?? output.blockedBy.map((blocker) => blocker.code),
    warningCodes: output.warnings.map((warning) => warning.code),
    transaction: run?.transaction ? {
      id: run.transaction.id,
      state: run.transaction.state,
      plannedActions: run.transaction.plannedActions.length,
      rollbackHints: run.transaction.rollbackHints.length,
      artifactRef: run.transaction.artifactRef,
    } : undefined,
    durationMs: output.meta?.durationMs,
  };
}

async function chooseTelemetryFile(root: string): Promise<string> {
  const day = utcDay();
  const dir = ".workflow/.runtime/telemetry";
  const base = `${dir}/workflow-${day}.jsonl`;
  if (await hasRoom(root, base)) return base;

  const existing = await telemetryFilesForDay(root, dir, day);
  for (let i = 1; i <= existing.length + 1; i++) {
    const candidate = `${dir}/workflow-${day}-${String(i).padStart(2, "0")}.jsonl`;
    if (await hasRoom(root, candidate)) return candidate;
  }
  return `${dir}/workflow-${day}-${String(existing.length + 2).padStart(2, "0")}.jsonl`;
}

async function hasRoom(root: string, relPath: string): Promise<boolean> {
  const abs = resolveInsideRoot(root, relPath);
  if (!existsSync(abs)) return true;
  const s = await stat(abs);
  return s.size < MAX_TELEMETRY_FILE_BYTES;
}

async function telemetryFilesForDay(root: string, relDir: string, day: string): Promise<string[]> {
  const absDir = resolveInsideRoot(root, relDir);
  if (!existsSync(absDir)) return [];
  const entries = await readdir(absDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`workflow-${day}`) && entry.name.endsWith(".jsonl"))
    .map((entry) => normalizeSlash(`${relDir}/${entry.name}`))
    .sort();
}

function utcDay(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
