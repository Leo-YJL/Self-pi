import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { workflowDelegate } from "../src/engine/delegate.ts";
import { setDelegateSdkForTest, type DelegateSession, type DelegateSessionEvent } from "../src/engine/delegateSdk.ts";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);

function taskStub(): WorkflowTaskJson {
  const now = new Date().toISOString();
  return { id: "t", title: "t", status: "planning", stage: "grill", flowLevel: "standard", createdAt: now, updatedAt: now };
}

// Drive a fresh simple task through the minimum grill+manifest flow until start_checked
// preflight passes. Used by mode=auto tests to verify the execute-after-gate path.
async function prepareReadyToStartTask(root: string, slug: string): Promise<string> {
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: `Ready ${slug}`, level: "simple", slug });
  const taskId = create.task!;
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "src/auto.ts"), "export const ready = true;\n", "utf8");
  await writeFile(join(root, "tests/auto.test.ts"), "import '../src/auto.ts';\n", "utf8");
  await workflowRun(root, { action: "record_round_and_update_prd", mode: "execute", task: taskId, roundId: "round-1-scope", roundKind: "scope", decisions: [{ decisionId: "ready.scope", decisionSource: "ask_user_question", decisionSeverity: "blocking", decisionSummary: "Scope locked.", persistTo: "prd" }], prdUpdates: [
    { prdSection: "executionContract", prdContent: "- Flow Level: simple\n- Outcome: ready." },
    { prdSection: "goal", prdContent: "Ready to start." },
    { prdSection: "requirements", prdContent: "- R1: ready=true." },
    { prdSection: "acceptanceCriteria", prdContent: "- [x] ready." },
    { prdSection: "validationPlan", prdContent: "- [x] npm test" },
    { prdSection: "definitionOfDone", prdContent: "- [x] done." },
    { prdSection: "outOfScope", prdContent: "- nothing." },
    { prdSection: "openQuestions", prdContent: "None." },
  ] });
  await workflowRun(root, { action: "init_manifests", mode: "execute", task: taskId });
  await workflowRun(root, { action: "upsert_manifest_entry", mode: "execute", task: taskId, manifest: "implement", file: "src/auto.ts", reason: "auto-test impl" });
  await workflowRun(root, { action: "upsert_manifest_entry", mode: "execute", task: taskId, manifest: "check", file: "tests/auto.test.ts", reason: "auto-test check" });
  const { confirmPrdFinal } = await import("../src/engine/prdConfirm.ts");
  await confirmPrdFinal(root, { task: taskId, mode: "execute", message: "Confirmed for auto-mode test." });
  await workflowRun(root, { action: "finalize_grill", mode: "execute", task: taskId, userConfirmed: true, decisionSource: "ask_user_question", notes: "Confirmed for auto-mode test." });
  return taskId;
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

test("workflow_next without initialized workflow does not recommend checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-no-workflow-"));
  const next = await workflowNext(root, { includeContext: "lite" });
  assert.equal(next.ok, true);
  assert.equal(next.status, "no_task");
  assert.equal(next.recommendedTool, undefined);
  assert.ok(next.warnings.some((warning) => warning.code === "workflow_dir_missing"));
});

test("create task uses defaultFlowLevel and deterministic manifest actions maintain JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-manifest-actions-"));
  await executeInitWorkspace(root, "generic");
  const configPath = join(root, ".workflow/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.workflow.defaultFlowLevel = "simple";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFile(join(root, "src-main.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(root, "src-extra.ts"), "export const extra = 2;\n", "utf8");
  await writeFile(join(root, "check-extra.ts"), "export const checked = true;\n", "utf8");

  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Manifest Actions", slug: "manifest-actions" });
  assert.equal(create.status, "planning");
  const task = await readTask(root, create.task!);
  assert.equal(task.flowLevel, "simple");
  assert.equal(existsSync(join(root, ".workflow/tasks", task.id, "implement.jsonl")), true);
  assert.equal(existsSync(join(root, ".workflow/tasks", task.id, "check.jsonl")), true);

  const batchInit = await workflowRun(root, { action: "init_manifests", mode: "execute", task: task.id, implementEntries: [{ file: "src-extra.ts", reason: "Batch implementation target" }], checkEntries: [{ file: "check-extra.ts", reason: "Batch check target" }] });
  assert.equal(batchInit.ok, true);
  assert.match(await readFile(join(root, ".workflow/tasks", task.id, "implement.jsonl"), "utf8"), /src-extra\.ts/);
  assert.match(await readFile(join(root, ".workflow/tasks", task.id, "check.jsonl"), "utf8"), /check-extra\.ts/);

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
  assert.equal(PACKAGE_VERSION, "0.4.0");
});
class MockDelegateSession implements DelegateSession {
  messages: unknown[] = [];
  listeners: Array<(event: DelegateSessionEvent) => void> = [];
  aborted = false;
  runPrompt: (session: MockDelegateSession, prompt: string) => Promise<void> | void;

  constructor(runPrompt: (session: MockDelegateSession, prompt: string) => Promise<void> | void) {
    this.runPrompt = runPrompt;
  }

  subscribe(listener: (event: DelegateSessionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  emit(event: DelegateSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async prompt(prompt: string): Promise<void> {
    await this.runPrompt(this, prompt);
  }

  abort(): void {
    this.aborted = true;
  }

  dispose(): void {}
}

function installMockDelegateSdk(runPrompt: (session: MockDelegateSession, prompt: string, cwd: string) => Promise<void> | void): void {
  setDelegateSdkForTest({
    sdk: {
      DefaultResourceLoader: class {
        constructor(_options: Record<string, unknown>) {}
        async reload(): Promise<void> {}
      },
      createAgentSession: async (options: Record<string, unknown>) => {
        const cwd = String(options.cwd ?? "");
        return { session: new MockDelegateSession((session, prompt) => runPrompt(session, prompt, cwd)) };
      },
      SessionManager: { inMemory: (root: string) => ({ root }) },
      defineTool: (tool: unknown) => tool,
    },
    Type: {
      Object: (value: unknown) => value,
      Optional: (value: unknown) => value,
      String: () => "string",
    },
  });
}

async function createInProgressTask(root: string): Promise<string> {
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Delegate Task", level: "simple", slug: `delegate-${Math.random().toString(16).slice(2)}` });
  const task = await readTask(root, create.task!);
  task.status = "in_progress";
  task.stage = "execute";
  await writeTask(root, task);
  return task.id;
}

test("workflow_delegate execute succeeds with injected SDK", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-delegate-success-"));
  await executeInitWorkspace(root, "generic");
  const task = await createInProgressTask(root);
  installMockDelegateSdk((session) => {
    session.emit({ type: "turn_start" });
    session.messages.push({ role: "assistant", content: "Delegate completed; parent should run checkpoint.", usage: { input: 10, output: 5 } });
  });
  try {
    const result = await workflowDelegate(root, { task, agent: "implement", mode: "execute", maxTurns: 3, maxToolCalls: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.status, "needs_parent_action");
    assert.match(result.summary, /Delegate completed/);
    assert.ok(result.artifactRef);
  } finally {
    setDelegateSdkForTest(undefined);
  }
});

test("workflow_delegate execute blocks unauthorized changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-delegate-unauth-"));
  await executeInitWorkspace(root, "generic");
  await execFileAsync("git", ["-C", root, "init"]);
  const task = await createInProgressTask(root);
  installMockDelegateSdk(async (session, _prompt, cwd) => {
    await writeFile(join(cwd, "unauthorized.txt"), "changed by delegate\n", "utf8");
    session.messages.push({ role: "assistant", content: "Changed a file." });
  });
  try {
    const result = await workflowDelegate(root, { task, agent: "implement", mode: "execute", writePolicy: "manifest_only" });
    assert.equal(result.ok, false);
    assert.ok(result.blockedBy.some((blocker) => blocker.code === "delegate_unauthorized_changes"));
    assert.ok(result.changedFiles.includes("unauthorized.txt"));
  } finally {
    setDelegateSdkForTest(undefined);
  }
});

test("workflow_delegate execute reports budget exceeded", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-delegate-budget-"));
  await executeInitWorkspace(root, "generic");
  const task = await createInProgressTask(root);
  installMockDelegateSdk((session) => {
    session.emit({ type: "tool_execution_start" });
    session.emit({ type: "tool_execution_start" });
    session.messages.push({ role: "assistant", content: "Budget test." });
  });
  try {
    const result = await workflowDelegate(root, { task, agent: "implement", mode: "execute", maxToolCalls: 1, maxTurns: 5 });
    assert.equal(result.ok, false);
    assert.equal(result.status, "budget_exceeded");
    assert.ok(result.blockedBy.some((blocker) => blocker.code === "delegate_budget_exceeded"));
  } finally {
    setDelegateSdkForTest(undefined);
  }
});

test("workflow_next honors config context.defaultMode when includeContext is omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-default-mode-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Default Mode", level: "standard", slug: "default-mode" });
  const configPath = join(root, ".workflow/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.context.defaultMode = "signal";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const implicit = await workflowNext(root, { task: create.task });
  assert.equal(implicit.context?.mode, "signal");
  assert.ok(implicit.detailRef?.includes(".workflow/.runtime/context/"));

  const explicit = await workflowNext(root, { task: create.task, includeContext: "lite" });
  assert.equal(explicit.context?.mode, "lite");
});

test("workflow_next signal mode returns compact routing fields and a detail ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-signal-next-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Signal Next", level: "standard", slug: "signal-next" });

  const next = await workflowNext(root, { task: create.task, includeContext: "signal" });
  const bytes = Buffer.byteLength(JSON.stringify(next), "utf8");
  assert.equal(next.context?.mode, "signal");
  assert.equal(next.context?.summary, "");
  assert.ok(next.detailRef?.includes(".workflow/.runtime/context/"));
  assert.deepEqual(next.blockedBy, []);
  assert.ok(next.blockedCodes?.includes("grill_not_finalized"));
  assert.equal(next.strategy, "ask_user");
  assert.equal(next.context?.adaptiveControl, undefined);
  assert.ok(bytes < 5000, `signal output too large: ${bytes} bytes`);

  const artifact = JSON.parse(await readFile(join(root, next.detailRef!), "utf8"));
  assert.equal(artifact.kind, "pi-coding-workflow.context");
  assert.ok(artifact.prd?.source);
  assert.ok(artifact.manifests?.implement);
  assert.ok(artifact.adaptiveControl?.strategy);
  assert.ok(artifact.blockedBy?.some((blocker: any) => blocker.code === "grill_not_finalized"));

  const lite = await workflowNext(root, { task: create.task, includeContext: "lite" });
  assert.equal(lite.context?.summary, "");
  assert.deepEqual(lite.blockedBy, []);
  assert.ok(lite.blockedCodes?.includes("grill_not_finalized"));

  const detailedLite = await workflowNext(root, { task: create.task, includeContext: "lite", detail: "normal" });
  assert.ok(detailedLite.blockedBy.some((blocker) => blocker.code === "grill_not_finalized"));
});

test("sync_manifest_from_diff dry-run reports execute requirements and validates entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-sync-manifest-"));
  await executeInitWorkspace(root, "generic");
  await writeFile(join(root, "changed.ts"), "export const changed = true;\n", "utf8");
  await execFileAsync("git", ["-C", root, "init"]);
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Sync Manifest", level: "simple", slug: "sync-manifest" });

  const missing = await workflowRun(root, { action: "sync_manifest_from_diff", mode: "dry_run", task: create.task, detail: "full" });
  assert.equal(missing.ok, true);
  assert.deepEqual((missing.preflight as any).missingForExecute, ["manifest", "entries"]);

  const invalid = await workflowRun(root, { action: "sync_manifest_from_diff", mode: "dry_run", task: create.task, detail: "full", manifest: "implement", implementEntries: [{ file: "../outside.ts", reason: "bad" }] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.blockedBy[0]?.code, "manifest_file_outside_root");
});

test("list_tasks supports status filters and default limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-list-tasks-"));
  await executeInitWorkspace(root, "generic");
  for (let i = 0; i < 15; i++) {
    await workflowRun(root, { action: "create_from_grill", mode: "execute", title: `Task ${i}`, level: "simple", slug: `list-${i}` });
  }

  const listed = await workflowRun(root, { action: "list_tasks", mode: "dry_run", detail: "full" });
  assert.equal(listed.ok, true);
  assert.equal(listed.tasks?.length, 12);
  assert.equal((listed.preflight as any).total, 15);
  assert.equal((listed.preflight as any).tasks, undefined);

  const completedTask = await readTask(root, listed.tasks![0].id);
  completedTask.status = "completed";
  completedTask.stage = "finish";
  await writeTask(root, completedTask);
  const completed = await workflowRun(root, { action: "list_tasks", mode: "dry_run", detail: "full", status: "completed", limit: 5 });
  assert.equal(completed.tasks?.length, 1);
  assert.equal(completed.tasks?.[0].status, "completed");
});

test("workflow_next signal mode reuses the same detailRef artifact when content is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-signal-dedup-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Signal Dedup", level: "standard", slug: "signal-dedup" });

  const first = await workflowNext(root, { task: create.task, includeContext: "signal" });
  assert.ok(first.detailRef);
  // Deterministic id includes task + prd/manifest hashes; same payload reuses the same file.
  assert.match(first.detailRef!, /\/signal-/);
  const firstStat = await (await import("node:fs/promises")).stat(join(root, first.detailRef!));

  // Wait a tick to ensure mtime would differ if a rewrite happened.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await workflowNext(root, { task: create.task, includeContext: "signal" });
  assert.equal(second.detailRef, first.detailRef);
  const secondStat = await (await import("node:fs/promises")).stat(join(root, second.detailRef!));
  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs, "artifact should not be rewritten when payload is unchanged");

  // Mutating the PRD must produce a different deterministic id (different hashes).
  const prdPath = join(root, ".workflow/tasks", create.task!, "prd.md");
  const prdBefore = await readFile(prdPath, "utf8");
  await writeFile(prdPath, prdBefore + "\n\n<!-- mutate -->\n", "utf8");
  const third = await workflowNext(root, { task: create.task, includeContext: "signal" });
  assert.notEqual(third.detailRef, first.detailRef, "different content must produce a different artifact ref");
});

test("telemetry signal_suggested warning fires after a few lite calls without any signal call", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-signal-suggested-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Signal Suggested", level: "standard", slug: "signal-suggested" });
  const taskId = create.task!;

  // workflow_next reads telemetry BEFORE writing the current call's event, so the 6th
  // call is the first to observe >= 5 prior lite events. detail=normal bypasses the
  // per-call cache so the warning is re-evaluated on every call.
  for (let i = 0; i < 5; i++) await workflowNext(root, { task: taskId, includeContext: "lite", detail: "normal" });
  const observed = await workflowNext(root, { task: taskId, includeContext: "lite", detail: "normal" });
  assert.ok(observed.warnings.some((warning) => warning.code === "workflow_next_signal_suggested"), "expected workflow_next_signal_suggested after >= 5 prior lite calls without any signal call");

  // After a single signal call, the suggestion goes away (signalCount > 0 disables the rule).
  await workflowNext(root, { task: taskId, includeContext: "signal", detail: "normal" });
  const afterSignal = await workflowNext(root, { task: taskId, includeContext: "lite", detail: "normal" });
  assert.equal(afterSignal.warnings.some((warning) => warning.code === "workflow_next_signal_suggested"), false, "signal call should clear the suggestion");
});

test("workflow_run mode=auto on a gate-checked action runs preflight then executes when gates pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-auto-pass-"));
  await executeInitWorkspace(root, "generic");

  // create_from_grill is in the auto whitelist; auto must mutate just like execute would.
  const created = await workflowRun(root, { action: "create_from_grill", mode: "auto", title: "Auto Pass", level: "simple", slug: "auto-pass" });
  assert.equal(created.ok, true);
  assert.equal(created.mutated, true, "auto on whitelisted create_from_grill should mutate");
  assert.equal(created.mode, "execute", "output mode should reflect normalized execute path");
  assert.equal(created.status, "planning");
  assert.ok(existsSync(join(root, ".workflow/tasks", created.task!, "task.json")));

  // Setup a fully ready task to exercise start_checked auto on a passing gate.
  const ready = await prepareReadyToStartTask(root, "auto-start");

  const started = await workflowRun(root, { action: "start_checked", mode: "auto", task: ready });
  assert.equal(started.ok, true);
  assert.equal(started.mutated, true, "auto on start_checked with passing preflight should commit");
  assert.equal(started.status, "in_progress");
  assert.equal(started.stage, "execute");

  const persisted = await readTask(root, ready);
  assert.equal(persisted.status, "in_progress", "task.json must be updated on disk");
});

test("workflow_run mode=auto on a gate-checked action returns blockers without mutating when gates fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-auto-fail-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Auto Fail", level: "standard", slug: "auto-fail" });
  const taskId = create.task!;
  const beforeTask = await readTask(root, taskId);

  // start_checked on a planning/grill task that has not been finalized must fail preflight.
  const blocked = await workflowRun(root, { action: "start_checked", mode: "auto", task: taskId });
  assert.equal(blocked.ok, false, "auto must surface preflight failures as blockers");
  assert.equal(blocked.mutated, false, "auto must NOT mutate when preflight fails");
  assert.ok(blocked.blockedBy.length > 0, "blockedBy should list the failing gates");

  const afterTask = await readTask(root, taskId);
  assert.equal(afterTask.status, beforeTask.status, "task status must remain unchanged after blocked auto");
  assert.equal(afterTask.stage, beforeTask.stage, "task stage must remain unchanged after blocked auto");
});

test("workflow_run mode=auto on a non-whitelisted action falls back to dry_run preview semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-auto-fallback-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Auto Fallback", level: "simple", slug: "auto-fallback" });
  const taskId = create.task!;
  const prdPath = join(root, ".workflow/tasks", taskId, "prd.md");
  const before = await readFile(prdPath, "utf8");

  // update_prd_section is intentionally NOT in the auto whitelist: PRD writes deserve a dry_run preview.
  const result = await workflowRun(root, { action: "update_prd_section", mode: "auto", task: taskId, prdSection: "openQuestions", prdContent: "Auto fallback test", prdUpdateMode: "replace" });
  assert.equal(result.ok, true);
  assert.equal(result.mutated, false, "auto on non-whitelisted action must NOT write");
  assert.equal(result.mode, "dry_run", "auto on non-whitelisted action must report dry_run mode");

  const after = await readFile(prdPath, "utf8");
  assert.equal(after, before, "PRD must remain unchanged when auto falls back to dry_run");
});

test("workflow_run mode=auto inside batch resolves per child action", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-auto-batch-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Auto Batch", level: "simple", slug: "auto-batch" });
  const taskId = create.task!;

  // Batch in execute mode with two auto children: init_manifests is whitelisted -> executes;
  // upsert_manifest_entry is whitelisted too -> executes. Both should mutate.
  const result = await workflowRun(root, { action: "batch", mode: "execute", actions: [
    { action: "init_manifests", mode: "auto", task: taskId },
    { action: "upsert_manifest_entry", mode: "auto", task: taskId, manifest: "implement", file: "src/auto.ts", reason: "auto batch test" },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.mutated, true, "batch with whitelisted auto children should commit");
  assert.equal(result.results?.length, 2);
  assert.ok(result.results?.every((child) => child.mode === "execute"), "each whitelisted auto child should be normalized to execute");
});

test("workflow_next does not duplicate evidenceRefs/omitted/tokenBudget at the top level", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-dedup-top-fields-"));
  await executeInitWorkspace(root, "generic");
  const taskId = await prepareReadyToStartTask(root, "dedup-fields");

  // lite mode is the canonical path that historically mirrored these fields. After the
  // dedup the canonical location is `context.*`; top-level mirrors must be absent so we
  // do not pay ~100 tokens per call serializing the same payload twice.
  const next = await workflowNext(root, { task: taskId, includeContext: "lite" });
  assert.equal(next.ok, true);
  assert.ok(next.context, "lite mode must still build a context block");
  assert.ok(next.context.evidenceRefs && next.context.evidenceRefs.length > 0, "context.evidenceRefs is the canonical location");
  assert.equal((next as any).evidenceRefs, undefined, "top-level evidenceRefs should not be populated");
  assert.equal((next as any).omitted, undefined, "top-level omitted should not be populated");
  assert.equal((next as any).tokenBudget, undefined, "top-level tokenBudget should not be populated");
});

test("workflow_run dry_run produces a deterministic preflight artifact id (no rewrite on identical reruns)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-preflight-dedup-"));
  await executeInitWorkspace(root, "generic");
  const taskId = await prepareReadyToStartTask(root, "preflight-dedup");

  const first = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: taskId });
  assert.equal(first.ok, true);
  const ref1 = first.preflightRef;
  assert.ok(ref1 && ref1.startsWith(".workflow/.runtime/preflight/"), "preflightRef should point to a runtime artifact");
  const abs1 = join(root, ref1!);
  assert.ok(existsSync(abs1), "preflight artifact file should exist");
  const stat1 = (await import("node:fs/promises")).stat;
  const mtime1 = (await stat1(abs1)).mtimeMs;

  // Same task, same workspace state, same action → identical preflight payload → same id.
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: taskId });
  assert.equal(second.preflightRef, ref1, "preflight artifact id must be deterministic across identical calls");
  const mtime2 = (await stat1(abs1)).mtimeMs;
  assert.equal(mtime2, mtime1, "writeJsonArtifact should skip rewriting an existing preflight file");
});

test("workflow_run dry_run skips preflight artifact for trivial payloads (list_tasks pagination)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-preflight-skip-"));
  await executeInitWorkspace(root, "generic");

  const result = await workflowRun(root, { action: "list_tasks", mode: "dry_run" });
  assert.equal(result.ok, true);
  assert.equal(result.preflightRef, undefined, "trivial preflight payloads should not produce a preflightRef");
  assert.ok(!(result.artifacts ?? []).some((artifact) => artifact.kind === "preflight"), "no preflight artifact should be attached for list_tasks");
  assert.ok(!existsSync(join(root, ".workflow/.runtime/preflight")), "preflight directory should not be created for trivial payloads");
});
