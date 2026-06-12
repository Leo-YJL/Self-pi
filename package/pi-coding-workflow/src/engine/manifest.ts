import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { WorkflowBlocker, WorkflowWarning } from "../types.ts";
import { assertRepoRelative, normalizeSlash, resolveInsideRoot } from "../safety/pathPolicy.ts";
import type { WorkflowTaskJson } from "./task.ts";

export type WorkflowManifestAgent = "implement" | "check";

export interface WorkflowManifestEntry {
  line: number;
  file: string;
  reason: string;
  exists: boolean;
}

export interface WorkflowManifestIssue {
  code: string;
  message: string;
  severity: "blocking" | "warning";
  path: string;
  line?: number;
}

export interface WorkflowManifestSummary {
  agent: WorkflowManifestAgent;
  path: string;
  exists: boolean;
  hash?: string;
  mtime?: string;
  bytes?: number;
  totalLines: number;
  skippedExamples: number;
  entries: WorkflowManifestEntry[];
  missingFiles: WorkflowManifestEntry[];
  issues: WorkflowManifestIssue[];
  summary: string;
}

export async function readTaskManifests(root: string, task: WorkflowTaskJson): Promise<Record<WorkflowManifestAgent, WorkflowManifestSummary>> {
  return {
    implement: await readManifest(root, task, "implement"),
    check: await readManifest(root, task, "check"),
  };
}

export async function readManifest(root: string, task: WorkflowTaskJson, agent: WorkflowManifestAgent): Promise<WorkflowManifestSummary> {
  const relPath = `.workflow/tasks/${task.id}/${agent}.jsonl`;
  const absPath = resolveInsideRoot(root, relPath);
  const missing = manifestSummary(agent, relPath, false);
  if (!existsSync(absPath)) {
    missing.issues.push({ code: "manifest_missing", message: `${relPath} is missing.`, severity: "blocking", path: relPath });
    missing.summary = `${agent} manifest missing`;
    return missing;
  }

  const content = await readFile(absPath, "utf8");
  const fileStat = await stat(absPath);
  const summary = manifestSummary(agent, relPath, true, {
    hash: createHash("sha256").update(content).digest("hex").slice(0, 16),
    mtime: fileStat.mtime.toISOString(),
    bytes: fileStat.size,
  });

  const lines = content.split(/\r?\n/);
  summary.totalLines = lines.filter((line) => line.trim()).length;
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("#")) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error: any) {
      summary.issues.push({ code: "manifest_invalid_json", message: `Invalid JSON on line ${lineNumber}: ${error.message}`, severity: "blocking", path: relPath, line: lineNumber });
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      summary.issues.push({ code: "manifest_line_not_object", message: `Manifest line ${lineNumber} must be a JSON object.`, severity: "blocking", path: relPath, line: lineNumber });
      return;
    }

    const obj = parsed as Record<string, unknown>;
    if (obj._example === true || obj.example === true || String(obj.file ?? "").includes("_example")) {
      summary.skippedExamples += 1;
      return;
    }

    const file = typeof obj.file === "string" ? normalizeSlash(obj.file.trim()) : "";
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
    if (!file || !reason) {
      summary.issues.push({ code: "manifest_missing_fields", message: `Manifest line ${lineNumber} requires string file and reason fields.`, severity: "blocking", path: relPath, line: lineNumber });
      return;
    }

    try {
      assertRepoRelative(file);
    } catch (error: any) {
      summary.issues.push({ code: "manifest_file_outside_root", message: error.message, severity: "blocking", path: relPath, line: lineNumber });
      return;
    }

    const target = resolveInsideRoot(root, file);
    const exists = existsSync(target);
    const entry: WorkflowManifestEntry = { line: lineNumber, file, reason, exists };
    summary.entries.push(entry);
    if (!exists) {
      summary.missingFiles.push(entry);
      summary.issues.push({ code: "manifest_file_missing", message: `Manifest file does not exist: ${file}`, severity: "blocking", path: relPath, line: lineNumber });
    }
  });

  if (summary.entries.length === 0) {
    summary.issues.push({ code: "manifest_empty", message: `${relPath} has no non-example entries.`, severity: "blocking", path: relPath });
  }

  summary.summary = `${agent} manifest: ${summary.entries.length} entries, ${summary.missingFiles.length} missing, ${summary.issues.length} issues`;
  return summary;
}

export function manifestIssuesToBlockers(manifest: WorkflowManifestSummary): WorkflowBlocker[] {
  return manifest.issues
    .filter((issue) => issue.severity === "blocking")
    .map((issue) => ({
      code: `${manifest.agent}_${issue.code}`,
      message: issue.line ? `${issue.message} (${manifest.path}:${issue.line})` : issue.message,
      severity: "blocking" as const,
      path: issue.path,
    }));
}

export function manifestIssuesToWarnings(manifest: WorkflowManifestSummary): WorkflowWarning[] {
  return manifest.issues
    .filter((issue) => issue.severity === "warning")
    .map((issue) => ({ code: `${manifest.agent}_${issue.code}`, message: issue.message, path: issue.path }));
}

export function manifestFiles(manifests: Partial<Record<WorkflowManifestAgent, WorkflowManifestSummary>>): string[] {
  const files = new Set<string>();
  for (const manifest of Object.values(manifests)) {
    for (const entry of manifest?.entries ?? []) files.add(entry.file);
  }
  return [...files].sort();
}

function manifestSummary(
  agent: WorkflowManifestAgent,
  path: string,
  exists: boolean,
  meta: { hash?: string; mtime?: string; bytes?: number } = {},
): WorkflowManifestSummary {
  return {
    agent,
    path,
    exists,
    ...meta,
    totalLines: 0,
    skippedExamples: 0,
    entries: [],
    missingFiles: [],
    issues: [],
    summary: `${agent} manifest ${exists ? "loaded" : "missing"}`,
  };
}
