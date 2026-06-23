import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { WorkflowBlocker, WorkflowWarning } from "../types.ts";
import { assertRepoRelative, normalizeSlash, resolveInsideRoot } from "../safety/pathPolicy.ts";
import type { WorkflowTaskJson } from "./task.ts";

export type WorkflowManifestAgent = "implement" | "check";

export interface WorkflowManifestEntryInput {
  file: string;
  reason: string;
}

export interface WorkflowManifestWriteResult {
  path: string;
  changed: boolean;
  summary: string;
  entries: WorkflowManifestEntryInput[];
}

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

export async function initTaskManifests(
  root: string,
  task: WorkflowTaskJson,
  options: { implementEntries?: WorkflowManifestEntryInput[]; checkEntries?: WorkflowManifestEntryInput[]; overwrite?: boolean } = {},
): Promise<Record<WorkflowManifestAgent, WorkflowManifestWriteResult>> {
  return {
    implement: await writeManifest(root, task, "implement", options.implementEntries ?? [], { initialize: true, overwrite: options.overwrite ?? false }),
    check: await writeManifest(root, task, "check", options.checkEntries ?? [], { initialize: true, overwrite: options.overwrite ?? false }),
  };
}

export async function upsertManifestEntry(root: string, task: WorkflowTaskJson, agent: WorkflowManifestAgent, entry: WorkflowManifestEntryInput): Promise<WorkflowManifestWriteResult> {
  const result = await upsertManifestEntries(root, task, agent, [entry]);
  const normalized = normalizeManifestInput(entry);
  return {
    ...result,
    entries: [normalized],
    summary: `${agent} manifest ${result.summary.includes("updated") ? "updated" : "added"} ${normalized.file}${result.summary.includes("removed duplicate entries") ? " and removed duplicate entries" : ""}.`,
  };
}

export async function upsertManifestEntries(root: string, task: WorkflowTaskJson, agent: WorkflowManifestAgent, entries: WorkflowManifestEntryInput[]): Promise<WorkflowManifestWriteResult> {
  const normalizedEntries = entries.map(normalizeManifestInput);
  const desiredByFile = new Map<string, WorkflowManifestEntryInput>();
  for (const entry of normalizedEntries) desiredByFile.set(entry.file, entry);

  const relPath = manifestRelPath(task, agent);
  const absPath = resolveInsideRoot(root, relPath);
  const existing = existsSync(absPath) ? await readFile(absPath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const nextLines: string[] = [];
  const updatedFiles = new Set<string>();
  let skippedDuplicate = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseManifestObject(line);
    if (!parsed || isExampleObject(parsed)) {
      nextLines.push(line);
      continue;
    }
    const file = typeof parsed.file === "string" ? normalizeSlash(parsed.file.trim()) : "";
    if (updatedFiles.has(file)) {
      skippedDuplicate = true;
      continue;
    }
    const desired = desiredByFile.get(file);
    if (desired) {
      if (!updatedFiles.has(file)) {
        nextLines.push(serializeManifestEntry(desired));
        updatedFiles.add(file);
        desiredByFile.delete(file);
      } else {
        skippedDuplicate = true;
      }
      continue;
    }
    nextLines.push(line);
  }

  const addedEntries = [...desiredByFile.values()];
  nextLines.push(...addedEntries.map(serializeManifestEntry));
  const next = `${nextLines.join("\n").replace(/\s+$/g, "")}\n`;
  const changed = next !== `${existing.replace(/\s+$/g, "")}\n`;
  if (changed) {
    await mkdir(resolveInsideRoot(root, `.workflow/tasks/${task.id}`), { recursive: true });
    await writeFile(absPath, next, "utf8");
  }

  const updatedCount = updatedFiles.size;
  const addedCount = addedEntries.length;
  const summaryParts = [
    updatedCount > 0 ? `updated ${updatedCount}` : undefined,
    addedCount > 0 ? `added ${addedCount}` : undefined,
  ].filter(Boolean).join(" and ") || "already matched";
  return {
    path: relPath,
    changed,
    entries: [...new Map(normalizedEntries.map((entry) => [entry.file, entry])).values()],
    summary: `${agent} manifest ${summaryParts} entr${normalizedEntries.length === 1 ? "y" : "ies"}${skippedDuplicate ? " and removed duplicate entries" : ""}.`,
  };
}

export async function removeManifestEntry(root: string, task: WorkflowTaskJson, agent: WorkflowManifestAgent, file: string): Promise<WorkflowManifestWriteResult> {
  const normalizedFile = normalizeManifestFile(file);
  const relPath = manifestRelPath(task, agent);
  const absPath = resolveInsideRoot(root, relPath);
  if (!existsSync(absPath)) return { path: relPath, changed: false, entries: [], summary: `${agent} manifest is missing; no entry removed.` };

  const existing = await readFile(absPath, "utf8");
  const lines = existing.split(/\r?\n/);
  const nextLines: string[] = [];
  const removed: WorkflowManifestEntryInput[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseManifestObject(line);
    if (!parsed || isExampleObject(parsed)) {
      nextLines.push(line);
      continue;
    }
    const parsedFile = typeof parsed.file === "string" ? normalizeSlash(parsed.file.trim()) : "";
    if (parsedFile === normalizedFile) {
      removed.push({ file: normalizedFile, reason: typeof parsed.reason === "string" ? parsed.reason : "" });
      continue;
    }
    nextLines.push(line);
  }

  const next = `${nextLines.join("\n").replace(/\s+$/g, "")}\n`;
  const changed = next !== `${existing.replace(/\s+$/g, "")}\n`;
  if (changed) await writeFile(absPath, next, "utf8");
  return { path: relPath, changed, entries: removed, summary: removed.length > 0 ? `Removed ${removed.length} ${agent} manifest entr${removed.length === 1 ? "y" : "ies"} for ${normalizedFile}.` : `No ${agent} manifest entry matched ${normalizedFile}.` };
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

async function writeManifest(
  root: string,
  task: WorkflowTaskJson,
  agent: WorkflowManifestAgent,
  entries: WorkflowManifestEntryInput[],
  options: { initialize: boolean; overwrite: boolean },
): Promise<WorkflowManifestWriteResult> {
  const normalizedEntries = entries.map(normalizeManifestInput);
  const relPath = manifestRelPath(task, agent);
  const absPath = resolveInsideRoot(root, relPath);
  const existing = existsSync(absPath) ? await readFile(absPath, "utf8") : "";
  if (existing && options.initialize && !options.overwrite) {
    return { path: relPath, changed: false, entries: normalizedEntries, summary: `${agent} manifest already exists.` };
  }

  const lines = [serializeManifestExample(agent), ...normalizedEntries.map(serializeManifestEntry)];
  const next = `${lines.join("\n")}\n`;
  const changed = next !== existing;
  if (changed) {
    await mkdir(resolveInsideRoot(root, `.workflow/tasks/${task.id}`), { recursive: true });
    await writeFile(absPath, next, "utf8");
  }
  return { path: relPath, changed, entries: normalizedEntries, summary: `${agent} manifest ${existing && options.overwrite ? "reset" : "initialized"} with ${normalizedEntries.length} entr${normalizedEntries.length === 1 ? "y" : "ies"}.` };
}

function manifestRelPath(task: WorkflowTaskJson, agent: WorkflowManifestAgent): string {
  return `.workflow/tasks/${task.id}/${agent}.jsonl`;
}

function normalizeManifestInput(entry: WorkflowManifestEntryInput): WorkflowManifestEntryInput {
  const file = normalizeManifestFile(entry.file);
  const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
  if (!reason) throw new Error("manifest entry requires reason.");
  return { file, reason };
}

function normalizeManifestFile(file: string): string {
  const normalized = normalizeSlash(String(file ?? "").trim());
  assertRepoRelative(normalized);
  return normalized;
}

function serializeManifestExample(agent: WorkflowManifestAgent): string {
  const example = agent === "implement"
    ? { _example: true, file: "src/example.ts", reason: "Implementation target example; replace with actual file." }
    : { _example: true, file: "tests/example.test.ts", reason: "Validation target example; replace with actual file." };
  return JSON.stringify(example);
}

function serializeManifestEntry(entry: WorkflowManifestEntryInput): string {
  return JSON.stringify({ file: entry.file, reason: entry.reason });
}

function parseManifestObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isExampleObject(obj: Record<string, unknown>): boolean {
  return obj._example === true || obj.example === true || String(obj.file ?? "").includes("_example");
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
