import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkflowNextOutput, WorkflowRunOutput } from "../types.ts";
import { normalizeSlash, resolveInsideRoot } from "../safety/pathPolicy.ts";

const TELEMETRY_SCHEMA_VERSION = 1;
const PACKAGE_VERSION = "0.1.0";
const MAX_TELEMETRY_FILE_BYTES = 512 * 1024;

export type WorkflowTelemetryEventName = "workflow_next" | "workflow_run";

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

export async function writeWorkflowTelemetry(root: string, event: WorkflowTelemetryEventName, output: WorkflowNextOutput | WorkflowRunOutput): Promise<WorkflowTelemetryWriteResult> {
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

function toTelemetryEvent(event: WorkflowTelemetryEventName, output: WorkflowNextOutput | WorkflowRunOutput): WorkflowTelemetryEvent {
  const run = "action" in output ? output : undefined;
  const next = "recommendedTool" in output ? output : undefined;
  const artifactRefs = run?.artifacts?.map((artifact) => artifact.ref) ?? (run?.artifactRef ? [run.artifactRef] : []);
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
    cacheHit: output.meta?.cacheHit ?? next?.cache?.hit ?? next?.tokenBudget?.cacheHit,
    estimatedTokens: output.meta?.estimatedTokens ?? next?.tokenBudget?.estimatedInput,
    targetTokens: output.meta?.targetTokens ?? output.meta?.maxRecommendedTokens ?? next?.tokenBudget?.maxRecommended,
    truncatedBytes: output.meta?.truncatedBytes ?? next?.tokenBudget?.truncatedBytes,
    omittedRefs,
    artifactRefs,
    blockerCodes: output.blockedBy.map((blocker) => blocker.code),
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
