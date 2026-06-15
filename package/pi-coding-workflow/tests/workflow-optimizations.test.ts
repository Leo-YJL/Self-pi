import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { executeInitWorkspace } from "../src/init/initWorkspace.ts";
import { workflowRun } from "../src/engine/run.ts";
import { workflowNext } from "../src/engine/route.ts";
import { buildPrdKernelFromMarkdown } from "../src/engine/prd.ts";
import { readTask, writeTask, type WorkflowTaskJson } from "../src/engine/task.ts";
import { PACKAGE_VERSION } from "../src/version.ts";
import { writeWorkflowTelemetry } from "../src/engine/telemetry.ts";

const require = createRequire(import.meta.url);

function taskStub(): WorkflowTaskJson {
  const now = new Date().toISOString();
  return { id: "t", title: "t", status: "planning", stage: "grill", flowLevel: "standard", createdAt: now, updatedAt: now };
}

test("invalid explicit task ids return structured blockers instead of throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-invalid-task-"));
  await executeInitWorkspace(root, "generic");

  const single = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: "missing-task" });
  assert.equal(single.ok, false);
  assert.equal(single.blockedBy[0]?.code, "missing_task");

  const batch = await workflowRun(root, { action: "batch", mode: "dry_run", task: "missing-task", actions: [{ action: "start_checked" }] });
  assert.equal(batch.ok, false);
  assert.equal(batch.action, "batch");
  assert.equal(batch.results?.length, 1);

  const next = await workflowNext(root, { task: "missing-task" });
  assert.equal(next.ok, false);
  assert.equal(next.blockedBy[0]?.code, "task_not_found");
});

test("create task uses defaultFlowLevel and deterministic manifest actions maintain JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-manifest-actions-"));
  await executeInitWorkspace(root, "generic");
  const configPath = join(root, ".workflow/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.workflow.defaultFlowLevel = "simple";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(join(root, "src-main.ts"), "export const value = 1;\n", "utf8");

  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Manifest Actions", slug: "manifest-actions" });
  assert.equal(create.status, "planning");
  const task = await readTask(root, create.task!);
  assert.equal(task.flowLevel, "simple");
  assert.equal(existsSync(join(root, ".workflow/tasks", task.id, "implement.jsonl")), true);
  assert.equal(existsSync(join(root, ".workflow/tasks", task.id, "check.jsonl")), true);

  const upsert = await workflowRun(root, { action: "upsert_manifest_entry", mode: "execute", task: task.id, manifest: "implement", file: "src-main.ts", reason: "Implementation target" });
  assert.equal(upsert.ok, true);
  const text = await readFile(join(root, ".workflow/tasks", task.id, "implement.jsonl"), "utf8");
  assert.match(text, /"file":"src-main\.ts"/);
  assert.match(text, /"reason":"Implementation target"/);

  const remove = await workflowRun(root, { action: "remove_manifest_entry", mode: "execute", task: task.id, manifest: "implement", file: "src-main.ts" });
  assert.equal(remove.ok, true);
  const removedText = await readFile(join(root, ".workflow/tasks", task.id, "implement.jsonl"), "utf8");
  assert.doesNotMatch(removedText, /src-main\.ts/);
});

test("PRD final confirmation parser is field driven and rejects negative confirmation text", () => {
  for (const body of [
    "- Status: pending\n- Evidence: 确认一下",
    "还没确认，需要 review",
    "未最终确认，需要 review",
  ]) {
    const kernel = buildPrdKernelFromMarkdown(taskStub(), ".workflow/tasks/t/prd.md", `# T\n\n## Final Confirmation\n${body}\n`, "compact");
    assert.equal(kernel.finalConfirmation.confirmed, false, body);
  }

  const confirmed = buildPrdKernelFromMarkdown(taskStub(), ".workflow/tasks/t/prd.md", "# T\n\n## Final Confirmation\n- Status: confirmed\n- Evidence: reviewed\n", "compact");
  assert.equal(confirmed.finalConfirmation.confirmed, true);
});

test("workflow_next warns on multiple planning tasks and exposes candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-multiple-active-"));
  await executeInitWorkspace(root, "generic");
  await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "One", level: "simple", slug: "one" });
  await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Two", level: "simple", slug: "two" });

  const next = await workflowNext(root, { includeContext: "lite" });
  assert.ok(next.warnings.some((warning) => warning.code === "multiple_planning_tasks"));
  assert.ok((next.taskCandidates?.length ?? 0) >= 2);
});

test("reopen and archive close completed task lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-archive-reopen-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Archive Reopen", level: "simple", slug: "archive-reopen" });
  const task = await readTask(root, create.task!);
  task.status = "completed";
  task.stage = "finish";
  await writeTask(root, task);

  const reopen = await workflowRun(root, { action: "reopen", mode: "execute", task: task.id, userConfirmed: true, message: "Need follow-up fix." });
  assert.equal(reopen.ok, true);
  const reopened = await readTask(root, task.id);
  assert.equal(reopened.status, "in_progress");
  assert.equal(reopened.stage, "execute");

  reopened.status = "completed";
  reopened.stage = "finish";
  await writeTask(root, reopened);
  const archive = await workflowRun(root, { action: "archive", mode: "execute", task: task.id, userConfirmed: true });
  assert.equal(archive.ok, true);
  assert.equal(existsSync(join(root, ".workflow/tasks/archive", task.id, "task.json")), true);
});

test("telemetry writer rotates files after the daily JSONL exceeds the size limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-telemetry-rotate-"));
  await executeInitWorkspace(root, "generic");
  const d = new Date();
  const day = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const telemetryDir = join(root, ".workflow/.runtime/telemetry");
  await mkdir(telemetryDir, { recursive: true });
  await writeFile(join(telemetryDir, `workflow-${day}.jsonl`), "x".repeat(513 * 1024), "utf8");

  const result = await writeWorkflowTelemetry(root, "workflow_run", { ok: true, mutated: false, action: "checkpoint", mode: "dry_run", blockedBy: [], warnings: [], summary: "ok" });
  assert.equal(result.ok, true);
  assert.match(result.artifactRef ?? "", new RegExp(`workflow-${day}-01\\.jsonl$`));
});

test("runtime package version follows package.json", () => {
  const pkg = require("../package.json") as { version: string };
  assert.equal(PACKAGE_VERSION, pkg.version);
  assert.equal(PACKAGE_VERSION, "0.2.0");
});
