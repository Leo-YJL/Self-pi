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
    const text = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message ?? ""}`;
    const isNotGit = /not a git repository/i.test(text);
    checks.push({ name: "git diff --check", passed: isNotGit, stdout: error.stdout, stderr: error.stderr, error: isNotGit ? "skipped: not a git repository" : error.message });
  }
  const passed = checks.every((check) => check.passed);
  const summary = passed ? "checkpoint passed" : "checkpoint failed";
  const artifact = await writeJsonArtifact(root, "checkpoints", {
    schemaVersion: 1,
    kind: "pi-coding-workflow.checkpoint",
    package: { name: "pi-coding-workflow", version: "0.1.0" },
    phase,
    notes,
    passed,
    summary,
    checks,
    createdAt: new Date().toISOString(),
  });
  return { passed, summary, artifactRef: artifact.artifactRef, details: { checks } };
}
