import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DetailMode, WorkflowAgent, WorkflowNextOutput } from "../types.ts";
import { PACKAGE_VERSION } from "../version.ts";
import type { WorkflowTaskJson } from "./task.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";
import { readGitPorcelain, type GitPorcelainResult } from "./gitPorcelain.ts";

const CACHE_SCHEMA_VERSION = 3;
const MAX_CACHE_ENTRIES = 25;

interface CacheFile {
  schemaVersion: 3;
  package: { name: "pi-coding-workflow"; version: string };
  entries: Record<string, WorkflowNextCacheEntry>;
}

interface WorkflowNextCacheEntry {
  key: string;
  createdAt: string;
  lastHitAt?: string;
  hitCount: number;
  output: WorkflowNextOutput;
}

export interface WorkflowNextCacheKeyInput {
  profile: string;
  includeContext: string;
  detail?: DetailMode;
  agent?: WorkflowAgent;
}

export async function computeWorkflowNextCacheKey(
  root: string,
  task: WorkflowTaskJson,
  input: WorkflowNextCacheKeyInput,
  porcelain?: GitPorcelainResult,
): Promise<string> {
  const material = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    packageVersion: PACKAGE_VERSION,
    task: {
      id: task.id,
      status: task.status,
      stage: task.stage,
      flowLevel: task.flowLevel,
      updatedAt: task.updatedAt,
    },
    input,
    files: {
      task: await fileFingerprint(root, `.workflow/tasks/${task.id}/task.json`),
      prd: await fileFingerprint(root, `.workflow/tasks/${task.id}/prd.md`),
      implement: await fileFingerprint(root, `.workflow/tasks/${task.id}/implement.jsonl`),
      check: await fileFingerprint(root, `.workflow/tasks/${task.id}/check.jsonl`),
      config: await fileFingerprint(root, ".workflow/config.json"),
    },
    workspace: workspaceFingerprintFromPorcelain(porcelain ?? await readGitPorcelain(root)),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export async function readWorkflowNextCache(root: string, key: string): Promise<WorkflowNextOutput | null> {
  const cache = await readCacheFile(root);
  const entry = cache.entries[key];
  if (!entry) return null;
  entry.hitCount += 1;
  entry.lastHitAt = new Date().toISOString();
  await writeCacheFile(root, pruneCache(cache));
  return markWorkflowNextCacheHit(entry.output, key);
}

export async function writeWorkflowNextCache(root: string, key: string, output: WorkflowNextOutput): Promise<void> {
  const cache = await readCacheFile(root);
  cache.entries[key] = {
    key,
    createdAt: new Date().toISOString(),
    hitCount: 0,
    output: markWorkflowNextCacheMiss(output, key),
  };
  await writeCacheFile(root, pruneCache(cache));
}

function markWorkflowNextCacheHit(output: WorkflowNextOutput, key: string): WorkflowNextOutput {
  return {
    ...output,
    cache: { ...(output.cache ?? { cacheFriendly: true }), cacheKey: key, hit: true, cacheFriendly: true },
    tokenBudget: output.tokenBudget ? { ...output.tokenBudget, cacheHit: true } : output.tokenBudget,
    context: output.context ? {
      ...output.context,
      tokenBudget: output.context.tokenBudget ? { ...output.context.tokenBudget, cacheHit: true } : output.context.tokenBudget,
    } : output.context,
    meta: output.meta ? { ...output.meta, cacheHit: true } : output.meta,
  };
}

function markWorkflowNextCacheMiss(output: WorkflowNextOutput, key: string): WorkflowNextOutput {
  return {
    ...output,
    cache: { ...(output.cache ?? { cacheFriendly: true }), cacheKey: key, hit: false, cacheFriendly: true },
    tokenBudget: output.tokenBudget ? { ...output.tokenBudget, cacheHit: false } : output.tokenBudget,
    context: output.context ? {
      ...output.context,
      tokenBudget: output.context.tokenBudget ? { ...output.context.tokenBudget, cacheHit: false } : output.context.tokenBudget,
    } : output.context,
    meta: output.meta ? { ...output.meta, cacheHit: false } : output.meta,
  };
}

async function fileFingerprint(root: string, relPath: string): Promise<{ exists: boolean; path: string; size?: number; mtimeMs?: number }> {
  const abs = resolveInsideRoot(root, relPath);
  if (!existsSync(abs)) return { exists: false, path: relPath };
  const s = await stat(abs);
  return { exists: true, path: relPath, size: s.size, mtimeMs: Math.trunc(s.mtimeMs) };
}

function workspaceFingerprintFromPorcelain(porcelain: GitPorcelainResult): { kind: "git" | "not_git" | "error"; hash: string; dirtyCount?: number } {
  if (porcelain.kind === "not_git") return { kind: "not_git", hash: "not_git" };
  if (porcelain.kind === "error") return { kind: "error", hash: createHash("sha256").update(porcelain.errorText ?? "").digest("hex").slice(0, 16) };
  const lines = porcelain.stdout.split(/\r?\n/).filter(Boolean).filter((line) => !line.includes(".workflow/.runtime/"));
  return { kind: "git", hash: createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16), dirtyCount: lines.length };
}

async function readCacheFile(root: string): Promise<CacheFile> {
  const path = cachePath(root);
  if (!existsSync(path)) return emptyCacheFile();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CacheFile;
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return emptyCacheFile();
    return { ...emptyCacheFile(), ...parsed, entries: parsed.entries ?? {} };
  } catch {
    return emptyCacheFile();
  }
}

async function writeCacheFile(root: string, cache: CacheFile): Promise<void> {
  const path = cachePath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function emptyCacheFile(): CacheFile {
  return { schemaVersion: CACHE_SCHEMA_VERSION, package: { name: "pi-coding-workflow", version: PACKAGE_VERSION }, entries: {} };
}

function cachePath(root: string): string {
  return resolveInsideRoot(root, ".workflow/.runtime/cache/pi-workflow/context-cache.json");
}

function pruneCache(cache: CacheFile): CacheFile {
  const entries = Object.values(cache.entries)
    .sort((a, b) => Date.parse(b.lastHitAt ?? b.createdAt) - Date.parse(a.lastHitAt ?? a.createdAt))
    .slice(0, MAX_CACHE_ENTRIES);
  return { ...cache, entries: Object.fromEntries(entries.map((entry) => [entry.key, entry])) };
}
