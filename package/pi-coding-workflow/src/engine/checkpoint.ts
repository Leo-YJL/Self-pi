import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeJsonArtifact } from "../artifacts/writeToolResult.ts";
const execFileAsync = promisify(execFile);

export async function checkpoint(root: string, phase = "custom", notes?: string): Promise<{ passed: boolean; summary: string; artifactRef: string; details: unknown }> {
  const checks: Array<{ name: string; passed: boolean; stdout?: string; stderr?: string; error?: string }> = [];
  try {
    const result = await execFileAsync("git", ["diff", "--check"], { cwd: root, timeout: 10_000 });
    checks.push({ name: "git diff --check", passed: true, stdout: result.stdout, stderr: result.stderr });
  } catch (error: any) {
    const isNotGit = String(error.stderr ?? error.message).includes("not a git repository");
    checks.push({ name: "git diff --check", passed: isNotGit, stdout: error.stdout, stderr: error.stderr, error: isNotGit ? "skipped: not a git repository" : error.message });
  }
  const passed = checks.every((check) => check.passed);
  const artifact = await writeJsonArtifact(root, "checkpoints", { phase, notes, checks, createdAt: new Date().toISOString() });
  return { passed, summary: passed ? "checkpoint passed" : "checkpoint failed", artifactRef: artifact.artifactRef, details: { checks } };
}
