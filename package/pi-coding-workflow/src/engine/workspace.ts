import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeSlash } from "../safety/pathPolicy.ts";
import { readGitPorcelain, type GitPorcelainResult } from "./gitPorcelain.ts";

const execFileAsync = promisify(execFile);

export interface WorkspaceDirtyFile {
  path: string;
  status: string;
  scope: "in_scope" | "task" | "unrelated";
}

export interface WorkspaceSummary {
  isGit: boolean;
  dirtyCount: number;
  inScopeCount: number;
  taskFileCount: number;
  unrelatedCount: number;
  dirtyFiles: WorkspaceDirtyFile[];
  skippedReason?: string;
  summary: string;
}

export interface GitDiffCheckResult {
  passed: boolean;
  skipped: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  summary: string;
}

export async function readWorkspaceSummary(
  root: string,
  options: { inScopeFiles?: string[]; taskId?: string; porcelain?: GitPorcelainResult } = {},
): Promise<WorkspaceSummary> {
  const scopeFiles = new Set((options.inScopeFiles ?? []).map((file) => normalizeSlash(file)));
  const taskPrefix = options.taskId ? `.workflow/tasks/${options.taskId}/` : "";
  // Reuse a pre-fetched porcelain result when the caller already ran it (e.g. the
  // workflow_next route that also needs it for the cache key) to avoid a second
  // `git status --porcelain` spawn on the same call.
  const porcelain = options.porcelain ?? await readGitPorcelain(root);
  if (porcelain.kind === "not_git") {
    return { isGit: false, dirtyCount: 0, inScopeCount: 0, taskFileCount: 0, unrelatedCount: 0, dirtyFiles: [], skippedReason: "not_git_repository", summary: "git status skipped: not a git repository" };
  }
  if (porcelain.kind === "error") {
    return { isGit: false, dirtyCount: 0, inScopeCount: 0, taskFileCount: 0, unrelatedCount: 0, dirtyFiles: [], skippedReason: porcelain.errorText, summary: `git status skipped: ${porcelain.errorText ?? "unknown"}` };
  }
  const dirtyFiles = porcelain.stdout
    .split(/\r?\n/)
    .map((line) => parsePorcelainLine(line, scopeFiles, taskPrefix))
    .filter((file): file is WorkspaceDirtyFile => file !== null);
  const inScopeCount = dirtyFiles.filter((file) => file.scope === "in_scope").length;
  const taskFileCount = dirtyFiles.filter((file) => file.scope === "task").length;
  const unrelatedCount = dirtyFiles.filter((file) => file.scope === "unrelated").length;
  return {
    isGit: true,
    dirtyCount: dirtyFiles.length,
    inScopeCount,
    taskFileCount,
    unrelatedCount,
    dirtyFiles,
    summary: dirtyFiles.length === 0 ? "workspace clean" : `workspace dirty: ${dirtyFiles.length} files (${inScopeCount} in-scope, ${taskFileCount} task, ${unrelatedCount} unrelated)`,
  };
}

export async function runGitDiffCheck(root: string): Promise<GitDiffCheckResult> {
  try {
    const result = await execFileAsync("git", ["diff", "--check"], { cwd: root, timeout: 10_000 });
    return { passed: true, skipped: false, stdout: result.stdout, stderr: result.stderr, summary: "git diff --check passed" };
  } catch (error: any) {
    if (isNotGitRepository(error)) {
      return { passed: true, skipped: true, stdout: error.stdout, stderr: error.stderr, error: "not_git_repository", summary: "git diff --check skipped: not a git repository" };
    }
    return { passed: false, skipped: false, stdout: error.stdout, stderr: error.stderr, error: error.message, summary: "git diff --check failed" };
  }
}

function parsePorcelainLine(line: string, scopeFiles: Set<string>, taskPrefix: string): WorkspaceDirtyFile | null {
  if (!line.trim()) return null;
  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const normalized = normalizeSlash(rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath);
  const scope = scopeFiles.has(normalized)
    ? "in_scope"
    : taskPrefix && normalized.startsWith(taskPrefix)
      ? "task"
      : "unrelated";
  return { path: normalized, status, scope };
}

function isNotGitRepository(error: any): boolean {
  const text = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? ""}`;
  return /not a git repository/i.test(text);
}
