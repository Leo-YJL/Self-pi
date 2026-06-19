import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Result of `git status --porcelain`. Shared between {@link cache.ts}
 * `workspaceFingerprint` and {@link workspace.ts} `readWorkspaceSummary` so that a
 * single workflow_next cache-miss path runs `git` exactly once instead of twice.
 */
export interface GitPorcelainResult {
  kind: "git" | "not_git" | "error";
  /** Raw stdout from `git status --porcelain`, empty when kind != "git". */
  stdout: string;
  /** Concatenated diagnostic text — only populated when kind === "error". */
  errorText?: string;
}

export async function readGitPorcelain(root: string): Promise<GitPorcelainResult> {
  try {
    const result = await execFileAsync("git", ["status", "--porcelain"], { cwd: root, timeout: 10_000 });
    return { kind: "git", stdout: result.stdout };
  } catch (error: any) {
    const text = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? ""}`;
    if (/not a git repository/i.test(text)) return { kind: "not_git", stdout: "" };
    return { kind: "error", stdout: "", errorText: text };
  }
}
