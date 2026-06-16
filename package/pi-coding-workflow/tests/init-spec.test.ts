import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnityVersion, scanUnityProject } from "../src/init/unityScanner.ts";
import { executeInitWorkspace } from "../src/init/initWorkspace.ts";
import { createInitSpecPlan, executeInitSpecPlan, writeInitSpecPlan } from "../src/init/specPlan.ts";
import { defaultConfig, validateConfig } from "../src/engine/config.ts";
import { renderTemplate } from "../src/templates/renderTemplate.ts";
import { resolveInsideRoot } from "../src/safety/pathPolicy.ts";
import { writeJsonArtifact } from "../src/artifacts/writeToolResult.ts";
import { workflowNext } from "../src/engine/route.ts";
import { workflowRun } from "../src/engine/run.ts";
import { workflowDelegate } from "../src/engine/delegate.ts";
import { prdConfirmationHash, readPrdKernel } from "../src/engine/prd.ts";
import { readManifest } from "../src/engine/manifest.ts";
import { confirmPrdFinal } from "../src/engine/prdConfirm.ts";
import { buildWorkflowCompactionSummary } from "../src/engine/compaction.ts";

async function fakeUnityProject() {
  const root = await mkdtemp(join(tmpdir(), "pcw-unity-"));
  await mkdir(join(root, "Assets/Scenes"), { recursive: true });
  await mkdir(join(root, "Assets/Scripts/Bootstrap"), { recursive: true });
  await mkdir(join(root, "Packages"), { recursive: true });
  await mkdir(join(root, "ProjectSettings"), { recursive: true });
  await writeFile(join(root, "ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 2021.3.58f1\n", "utf8");
  await writeFile(join(root, "Packages/manifest.json"), JSON.stringify({ dependencies: { "com.unity.render-pipelines.universal": "12.1.16", "com.unity.test-framework": "1.1.33" } }, null, 2), "utf8");
  await writeFile(join(root, "Assets/Scenes/Launch.unity"), "%YAML 1.1\n", "utf8");
  await writeFile(join(root, "Assets/Scripts/Bootstrap/GameBootstrap.cs"), "class GameBootstrap { void Start() { DontDestroyOnLoad(this); } }\n", "utf8");
  await writeFile(join(root, "Assets/Scripts/Game.Runtime.asmdef"), JSON.stringify({ name: "Game.Runtime", references: [] }), "utf8");
  return root;
}

function prdMarkdown(title: string, options: { todo?: boolean; openQuestions?: string; finalConfirmed?: boolean; finishComplete?: boolean; decisionIds?: string[] } = {}): string {
  const todo = options.todo ? "TODO" : "Deliver the requested package workflow slice.";
  const openQuestions = options.openQuestions ?? "None.";
  const finalConfirmed = options.finalConfirmed ?? true;
  const checked = options.finishComplete ? "x" : " ";
  const decisionIds = options.decisionIds ?? [];
  const decisionLog = decisionIds.length > 0 ? `\n## Grill Decision Log\n${decisionIds.map((id) => `- ${id}`).join("\n")}\n` : "";
  const body = `# ${title}

## Execution Contract
- Flow Level: complex
- Outcome: ${todo}
- Final Confirmation: ${finalConfirmed ? "confirmed" : "pending"}

## Goal
Ship deterministic workflow package preflight behavior.

## Requirements
- R1: Parse PRD kernel.
- R2: Validate manifests.
${decisionLog}
## Acceptance Criteria
- [${checked}] PRD gates are enforced.
- [${checked}] Manifest files are validated.

## Validation Plan
- [${checked}] npm test

## Definition of Done
- [${checked}] Implementation matches this PRD.

## Open Questions
${openQuestions}

## Out of Scope
- Git finalizer execution.
`;
  const confirmation = finalConfirmed
    ? `- Status: confirmed\n- Confirmed PRD Hash: ${prdConfirmationHash(body)}\n`
    : "- Status: pending\n";
  return `${body}\n## Final Confirmation Before Implementation\n${confirmation}`;
}

async function seedManifestFiles(root: string) {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "src/main.ts"), "export const ok = true;\n", "utf8");
  await writeFile(join(root, "tests/main.test.ts"), "export const checked = true;\n", "utf8");
}

async function seedTaskPreflight(root: string, taskId: string, options: Parameters<typeof prdMarkdown>[1] = {}) {
  await seedManifestFiles(root);
  const taskDir = join(root, ".workflow/tasks", taskId);
  const decisionIds = options.decisionIds ?? ["test.scope-confirmed", "test.runtime-confirmed", "test.validation-confirmed"];
  await writeFile(join(taskDir, "prd.md"), prdMarkdown("Ready Task", { ...options, decisionIds }), "utf8");
  await writeFile(join(taskDir, "implement.jsonl"), `${JSON.stringify({ file: "src/main.ts", reason: "Implementation target" })}\n`, "utf8");
  await writeFile(join(taskDir, "check.jsonl"), `${JSON.stringify({ file: "tests/main.test.ts", reason: "Validation target" })}\n`, "utf8");

  const finalConfirmed = options.finalConfirmed ?? true;
  const canFinalizeGrill = !options.todo && finalConfirmed && isNeutralOpenQuestions(options.openQuestions ?? "None.");
  if (canFinalizeGrill) {
    for (const [decisionId, roundKind] of [[decisionIds[0], "scope"], [decisionIds[1], "runtime"], [decisionIds[2], "validation"]] as const) {
      const decision = await workflowRun(root, {
        action: "record_grill_decision",
        mode: "execute",
        task: taskId,
        decisionId,
        decisionSeverity: "blocking",
        decisionSource: "user",
        decisionSummary: `Test fixture confirms ${roundKind} readiness.`,
        persistTo: "prd",
        roundKind,
      });
      if (!decision.ok) throw new Error(`seedTaskPreflight record_grill_decision failed: ${decision.summary}`);
    }

    const finalized = await workflowRun(root, {
      action: "finalize_grill",
      mode: "execute",
      task: taskId,
      userConfirmed: true,
      decisionSource: "user",
      notes: "Test fixture finalizes Stage 1 grill after PRD final confirmation.",
    });
    if (!finalized.ok) throw new Error(`seedTaskPreflight finalize_grill failed: ${finalized.summary}`);
  }
}

function isNeutralOpenQuestions(text: string): boolean {
  const normalized = text.replace(/[.。；;!！\s]+$/g, "").toLowerCase();
  return !normalized || /^(none|no blockers?|no blocking questions?|n\/a|not applicable|na|无|无阻塞|暂无|没有|不适用|无需)$/.test(normalized) || /无阻塞|暂无阻塞|no blocking/.test(normalized);
}

function blockerCodes(result: { blockedBy: Array<{ code: string }> }): string[] {
  return result.blockedBy.map((blocker) => blocker.code);
}

async function readTelemetryEvents(root: string): Promise<any[]> {
  const dir = join(root, ".workflow/.runtime/telemetry");
  const files = await readdir(dir);
  const events: any[] = [];
  for (const file of files.filter((name) => name.endsWith(".jsonl")).sort()) {
    const text = await readFile(join(dir, file), "utf8");
    events.push(...text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)));
  }
  return events;
}

test("config schema validates default config", () => {
  assert.deepEqual(validateConfig(defaultConfig("Demo", "unity")), []);
});

test("path policy blocks root escape", () => {
  assert.throws(() => resolveInsideRoot("/tmp/project", "../outside"), /escapes/);
});

test("template renderer falls back to TODO", () => {
  assert.equal(renderTemplate("Hello {{name}} {{missing}}", { name: "World" }), "Hello World TODO(init-spec)");
});

test("unity version parser", () => {
  assert.equal(parseUnityVersion("m_EditorVersion: 2021.3.58f1\n"), "2021.3.58f1");
});

test("unity scanner detects project without default Addressables", async () => {
  const root = await fakeUnityProject();
  const scan = await scanUnityProject(root);
  assert.ok(scan.confidence >= 0.9);
  assert.equal(scan.facts.unity.version, "2021.3.58f1");
  assert.equal(scan.facts.unity.packages.addressables, false);
  assert.equal(scan.facts.unity.packages.urp, true);
  assert.equal(scan.facts.unity.entryScene.path, "Assets/Scenes/Launch.unity");
  assert.ok(scan.facts.unity.bootstrap.candidates.some((c) => c.path.endsWith("GameBootstrap.cs")));
});

test("workspace init creates config and gitignore runtime entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-init-"));
  const result = await executeInitWorkspace(root, "unity");
  assert.ok(result.created?.includes(".workflow/config.json"));
  assert.match(await readFile(join(root, ".gitignore"), "utf8"), /\.workflow\/\.runtime\//);
});

test("init-spec plan execute creates Unity specs only", async () => {
  const root = await fakeUnityProject();
  await executeInitWorkspace(root, "unity");
  const plan = await createInitSpecPlan(root, "unity");
  assert.equal(plan.summary.blocked, false);
  assert.ok(plan.operations.some((op) => op.path === ".workflow/spec/modules/unity-project.md"));
  assert.ok(plan.operations.some((op) => op.path === ".workflow/spec/modules/unity-assets.md"));
  assert.ok(!plan.operations.some((op) => op.path.includes("editor-and-build")));
  await writeInitSpecPlan(root, plan);
  const executed = await executeInitSpecPlan(root, plan.planId);
  assert.equal(executed.ok, true);
  const unityProject = await readFile(join(root, ".workflow/spec/modules/unity-project.md"), "utf8");
  assert.match(unityProject, /2021\.3\.58f1/);
  assert.ok(executed.created.includes(".workflow/spec/modules/unity-assets.md"));
});

test("artifact writer returns repo-relative runtime ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-artifact-"));
  const result = await writeJsonArtifact(root, "tool-results", { ok: true }, "sample");
  assert.equal(result.artifactRef, ".workflow/.runtime/tool-results/sample.json");
  assert.match(await readFile(result.absolutePath, "utf8"), /"ok": true/);
});

test("workflow_next detects active planning and in-progress tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-route-"));
  await executeInitWorkspace(root, "unity");
  let next = await workflowNext(root, { includeContext: "brief" });
  assert.equal(next.status, "no_task");
  assert.equal(next.nextAction, "no_task_grill");

  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Route Test", level: "complex", slug: "route-test" });
  assert.equal(create.ok, true);
  assert.equal(create.task, "06-10-route-test".replace("06-10", create.task!.slice(0, 5)));

  next = await workflowNext(root, { includeContext: "brief" });
  assert.equal(next.status, "planning");
  assert.equal(next.stage, "grill");
  assert.equal(next.flowLevel, "complex");
  assert.equal(next.nextAction, "ask_user");
  assert.ok(blockerCodes(next).includes("grill_not_finalized"));
  assert.ok(blockerCodes(next).includes("prd_todo_present"));
  assert.equal(next.adaptiveControl?.strategy, "ask_user");
  assert.equal(next.adaptiveControl?.decisionCardAvailable, true);
  assert.ok(next.adaptiveControl?.decisionCardIds?.[0]?.includes("grill-next-round"));
  const nextWithCard = await workflowNext(root, { includeContext: "brief", detail: "normal" });
  assert.equal(nextWithCard.adaptiveControl?.decisionCardHints?.[0]?.header, "Grill Round");

  const blockedStartDryRun = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: create.task });
  assert.equal(blockedStartDryRun.ok, false);
  assert.ok(blockerCodes(blockedStartDryRun).includes("grill_not_finalized"));
  assert.ok(blockerCodes(blockedStartDryRun).includes("prd_todo_present"));

  await seedTaskPreflight(root, create.task!, { finishComplete: false });
  const startDryRun = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: create.task });
  assert.equal(startDryRun.ok, true);
  assert.equal(startDryRun.mutated, false);
  assert.equal(startDryRun.preflight, undefined);
  assert.match(startDryRun.preflightRef ?? "", /^\.workflow\/\.runtime\/preflight\//);
  assert.match(await readFile(join(root, startDryRun.preflightRef!), "utf8"), /pi-coding-workflow\.preflight/);
  const fullStartDryRun = await workflowRun(root, { action: "start_checked", mode: "dry_run", detail: "full", task: create.task });
  assert.ok(fullStartDryRun.preflight);
  assert.equal(fullStartDryRun.preflightRef, undefined);

  const start = await workflowRun(root, { action: "start_checked", mode: "execute", task: create.task });
  assert.equal(start.ok, true);
  assert.equal(start.status, "in_progress");

  next = await workflowNext(root, { includeContext: "brief" });
  assert.equal(next.status, "in_progress");
  assert.equal(next.stage, "execute");
  assert.equal(next.nextAction, "implement_slice");

  const finishRoute = await workflowNext(root, { agent: "finish", includeContext: "brief" });
  assert.equal(finishRoute.nextAction, "finish_dry_run");
});


test("PRD kernel, manifest helpers and workflow_next task context summarize P1 state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-p1-context-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "P1 Context", level: "complex", slug: "p1-context" });
  await seedTaskPreflight(root, create.task!, { finishComplete: true });

  const kernel = await readPrdKernel(root, { id: create.task!, title: "P1 Context", status: "planning", stage: "grill", flowLevel: "complex", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, "brief");
  assert.equal(kernel.source.exists, true);
  assert.equal(kernel.finalConfirmation.confirmed, true);
  assert.equal(kernel.openQuestions.blocking, false);
  assert.equal(kernel.sections.acceptanceCriteria.checklist.total, 2);

  const manifest = await readManifest(root, { id: create.task!, title: "P1 Context", status: "planning", stage: "grill", flowLevel: "complex", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, "implement");
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.issues.length, 0);

  const next = await workflowNext(root, { task: create.task, includeContext: "task" });
  assert.equal(next.status, "planning");
  assert.deepEqual(next.blockedBy, []);
  const details = next.context?.details as any;
  assert.equal(details.prd.finalConfirmation.confirmed, true);
  assert.equal(details.manifests.implement.entries[0].file, "src/main.ts");
});

test("workflow_next defaults to lite context with budget metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-lite-context-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Lite Context", level: "complex", slug: "lite-context" });
  await seedTaskPreflight(root, create.task!, { finishComplete: true });

  const next = await workflowNext(root, {});
  assert.equal(next.context?.mode, "lite");
  assert.equal(next.context?.summary, "");
  assert.equal(next.context?.details, undefined);
  assert.ok(next.context?.evidenceRefs?.some((ref) => ref.startsWith("prd:")));
  assert.ok(next.context?.omitted?.some((item) => item.kind === "context.details"));
  assert.ok((next.context?.tokenBudget?.estimatedInput ?? 0) <= (next.context?.tokenBudget?.maxRecommended ?? 0));
  assert.equal(next.meta?.cacheHit, false);

  const cached = await workflowNext(root, {});
  assert.equal(cached.cache?.hit, true);
  assert.equal(cached.context?.tokenBudget?.cacheHit, true);
  assert.equal(cached.meta?.cacheHit, true);
});

test("workflow_next adaptive control emits implement subagent brief and delegate recommendation after start", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-adaptive-implement-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Adaptive Implement", level: "complex", slug: "adaptive-implement" });
  await seedTaskPreflight(root, create.task!, { finishComplete: false });
  const start = await workflowRun(root, { action: "start_checked", mode: "execute", task: create.task });
  assert.equal(start.ok, true);

  const next = await workflowNext(root, { task: create.task });
  assert.equal(next.context?.mode, "lite");
  assert.equal(next.adaptiveControl?.strategy, "subagent_brief");
  assert.equal(next.adaptiveControl?.recommendedAgent, "implement");
  assert.equal(next.adaptiveControl?.subagentBriefs.length, 0);
  assert.equal(next.adaptiveControl?.reasons.length, 0);
  assert.equal(next.adaptiveControl?.stopConditions.length, 0);
  assert.equal(next.adaptiveControl?.delegateRecommendedCall?.name, "workflow_delegate");
  assert.equal(next.recommendedTool?.name, "workflow_delegate");

  const brief = await workflowNext(root, { task: create.task, includeContext: "brief" });
  assert.equal(brief.adaptiveControl?.subagentBriefs[0]?.agent, "implement");
  assert.ok(brief.adaptiveControl?.subagentBriefs[0]?.instructions.some((line) => line.includes("manifest")));

  const delegate = await workflowDelegate(root, { task: create.task, agent: "implement", mode: "dry_run" });
  assert.equal(delegate.ok, true);
  assert.equal(delegate.status, "planned");
  assert.equal(delegate.recommendedNext?.name, "workflow_run");
  assert.ok(delegate.artifactRef?.includes(".workflow/.runtime/agents/"));
});

test("workflow_next adaptive control prefers deterministic finish preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-adaptive-finish-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Adaptive Finish", level: "standard", slug: "adaptive-finish" });
  await seedTaskPreflight(root, create.task!, { finishComplete: true });
  const start = await workflowRun(root, { action: "start_checked", mode: "execute", task: create.task });
  assert.equal(start.ok, true);

  const next = await workflowNext(root, { task: create.task, agent: "finish" });
  assert.equal(next.adaptiveControl?.strategy, "deterministic_preflight");
  assert.equal(next.adaptiveControl?.recommendedAgent, "finish");
  assert.equal(next.adaptiveControl?.deterministicActions[0]?.arguments.action, "finish_run");
});

test("workflow-prd-confirm engine records final confirmation without LLM", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-prd-confirm-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Confirm PRD", level: "complex", slug: "confirm-prd" });
  const confirmDecisionIds = ["confirm-prd.scope", "confirm-prd.runtime", "confirm-prd.validation"];
  await seedTaskPreflight(root, create.task!, { finalConfirmed: false, finishComplete: true, decisionIds: confirmDecisionIds });

  const blockedStart = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: create.task });
  assert.ok(blockerCodes(blockedStart).includes("prd_final_confirmation_missing"));

  const dryRun = await confirmPrdFinal(root, { task: create.task, mode: "dry_run", message: "User approved implementation." });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.mutated, false);
  assert.match(dryRun.preview ?? "", /Status: confirmed/);

  const executed = await confirmPrdFinal(root, { task: create.task, mode: "execute", message: "User approved implementation." });
  assert.equal(executed.ok, true);
  assert.equal(executed.mutated, true);

  const kernel = await readPrdKernel(root, { id: create.task!, title: "Confirm PRD", status: "planning", stage: "grill", flowLevel: "complex", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, "compact");
  assert.equal(kernel.finalConfirmation.confirmed, true);

  for (const [decisionId, roundKind] of [[confirmDecisionIds[0], "scope"], [confirmDecisionIds[1], "runtime"], [confirmDecisionIds[2], "validation"]] as const) {
    const decision = await workflowRun(root, {
      action: "record_grill_decision",
      mode: "execute",
      task: create.task,
      decisionId,
      decisionSeverity: "blocking",
      decisionSource: "ask_user_question",
      decisionSummary: `User approved ${roundKind} after reviewing the PRD.`,
      roundKind,
    });
    assert.equal(decision.ok, true);
  }
  const finalize = await workflowRun(root, { action: "finalize_grill", mode: "execute", task: create.task, userConfirmed: true, decisionSource: "ask_user_question", notes: "User approved implementation." });
  assert.equal(finalize.ok, true);

  const start = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: create.task });
  assert.equal(start.ok, true);
});

test("start preflight requires finalized Stage 1 grill", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-grill-gate-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Grill Gate", level: "standard", slug: "grill-gate" });
  await seedManifestFiles(root);
  const taskDir = join(root, ".workflow/tasks", create.task!);
  const grillGateDecisionIds = ["grill-gate.scope", "grill-gate.runtime", "grill-gate.validation"];
  await writeFile(join(taskDir, "prd.md"), prdMarkdown("Grill Gate", { finishComplete: true, decisionIds: grillGateDecisionIds }), "utf8");
  await writeFile(join(taskDir, "implement.jsonl"), `${JSON.stringify({ file: "src/main.ts", reason: "Implementation target" })}\n`, "utf8");
  await writeFile(join(taskDir, "check.jsonl"), `${JSON.stringify({ file: "tests/main.test.ts", reason: "Validation target" })}\n`, "utf8");

  const blocked = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: create.task });
  assert.equal(blocked.ok, false);
  assert.ok(blockerCodes(blocked).includes("grill_not_finalized"));

  for (const [decisionId, roundKind] of [[grillGateDecisionIds[0], "scope"], [grillGateDecisionIds[1], "runtime"], [grillGateDecisionIds[2], "validation"]] as const) {
    const decision = await workflowRun(root, { action: "record_grill_decision", mode: "execute", task: create.task, decisionId, decisionSource: "user", decisionSeverity: "blocking", decisionSummary: `User confirmed ${roundKind}.`, roundKind });
    assert.equal(decision.ok, true);
  }
  const finalize = await workflowRun(root, { action: "finalize_grill", mode: "execute", task: create.task, userConfirmed: true, decisionSource: "user", notes: "User confirmed the PRD can start." });
  assert.equal(finalize.ok, true);

  const start = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: create.task });
  assert.equal(start.ok, true);
});

test("finalize_grill requires multiple business rounds for standard tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-grill-rounds-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Round Gate", level: "standard", slug: "round-gate" });
  await seedManifestFiles(root);
  const taskDir = join(root, ".workflow/tasks", create.task!);
  const decisionIds = ["round.scope", "round.runtime"];
  await writeFile(join(taskDir, "prd.md"), prdMarkdown("Round Gate", { finishComplete: true, decisionIds }), "utf8");
  await writeFile(join(taskDir, "implement.jsonl"), `${JSON.stringify({ file: "src/main.ts", reason: "Implementation target" })}\n`, "utf8");
  await writeFile(join(taskDir, "check.jsonl"), `${JSON.stringify({ file: "tests/main.test.ts", reason: "Validation target" })}\n`, "utf8");

  const batch = await workflowRun(root, {
    action: "batch",
    mode: "execute",
    task: create.task,
    actions: [
      { action: "record_grill_decision", decisionId: decisionIds[0], decisionSource: "user", decisionSeverity: "blocking", decisionSummary: "Scope approved.", roundKind: "scope" },
      { action: "record_grill_decision", decisionId: decisionIds[1], decisionSource: "user", decisionSeverity: "blocking", decisionSummary: "Runtime approved.", roundKind: "runtime" },
    ],
  });
  assert.equal(batch.ok, true);

  const finalize = await workflowRun(root, { action: "finalize_grill", mode: "execute", task: create.task, userConfirmed: true, decisionSource: "user", notes: "User confirmed PRD." });
  assert.equal(finalize.ok, false);
  assert.ok(blockerCodes(finalize).includes("grill_min_rounds_not_met"));
});

test("finalize_grill rejects final confirmation mixed with business decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-grill-mixed-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Mixed Gate", level: "simple", slug: "mixed-gate" });
  await seedManifestFiles(root);
  const taskDir = join(root, ".workflow/tasks", create.task!);
  await writeFile(join(taskDir, "prd.md"), prdMarkdown("Mixed Gate", { finishComplete: true, decisionIds: ["mixed.scope"] }), "utf8");
  await writeFile(join(taskDir, "implement.jsonl"), `${JSON.stringify({ file: "src/main.ts", reason: "Implementation target" })}\n`, "utf8");
  await writeFile(join(taskDir, "check.jsonl"), `${JSON.stringify({ file: "tests/main.test.ts", reason: "Validation target" })}\n`, "utf8");

  const batch = await workflowRun(root, {
    action: "batch",
    mode: "execute",
    task: create.task,
    actions: [
      { action: "record_grill_decision", decisionId: "mixed.scope", decisionSource: "user", decisionSeverity: "blocking", decisionSummary: "Scope approved.", roundKind: "scope" },
      { action: "record_grill_decision", decisionId: "mixed.stage1-final-confirm", decisionSource: "user", decisionSeverity: "blocking", decisionSummary: "Final confirm mixed into same ask.", roundKind: "final_confirmation" },
    ],
  });
  assert.equal(batch.ok, true);

  const finalize = await workflowRun(root, { action: "finalize_grill", mode: "execute", task: create.task, userConfirmed: true, decisionSource: "user", notes: "User confirmed PRD." });
  assert.equal(finalize.ok, false);
  assert.ok(blockerCodes(finalize).includes("grill_final_confirmation_mixed_with_business_round"));
});

test("finalize_grill requires PRD update between business grill rounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-grill-prd-between-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Between Gate", level: "standard", slug: "between-gate" });
  await seedManifestFiles(root);
  const taskDir = join(root, ".workflow/tasks", create.task!);
  const decisionIds = ["between.scope", "between.runtime"];
  await writeFile(join(taskDir, "prd.md"), prdMarkdown("Between Gate", { finishComplete: true, decisionIds: [] }), "utf8");
  await writeFile(join(taskDir, "implement.jsonl"), `${JSON.stringify({ file: "src/main.ts", reason: "Implementation target" })}\n`, "utf8");
  await writeFile(join(taskDir, "check.jsonl"), `${JSON.stringify({ file: "tests/main.test.ts", reason: "Validation target" })}\n`, "utf8");

  const scope = await workflowRun(root, { action: "record_grill_decision", mode: "execute", task: create.task, decisionId: decisionIds[0], decisionSource: "user", decisionSeverity: "blocking", decisionSummary: "Scope approved.", roundKind: "scope" });
  assert.equal(scope.ok, true);
  const runtime = await workflowRun(root, { action: "record_grill_decision", mode: "execute", task: create.task, decisionId: decisionIds[1], decisionSource: "user", decisionSeverity: "blocking", decisionSummary: "Runtime approved.", roundKind: "runtime" });
  assert.equal(runtime.ok, true);

  await writeFile(join(taskDir, "prd.md"), prdMarkdown("Between Gate", { finishComplete: true, decisionIds }), "utf8");
  const finalize = await workflowRun(root, { action: "finalize_grill", mode: "execute", task: create.task, userConfirmed: true, decisionSource: "user", notes: "User confirmed PRD." });
  assert.equal(finalize.ok, false);
  assert.ok(blockerCodes(finalize).includes("grill_prd_revision_missing_after_round"));
});

test("finalize_grill requires business decisions to be written into PRD", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-grill-prd-log-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "PRD Log Gate", level: "complex", slug: "prd-log-gate" });
  await seedManifestFiles(root);
  const taskDir = join(root, ".workflow/tasks", create.task!);
  await writeFile(join(taskDir, "prd.md"), prdMarkdown("PRD Log Gate", { finishComplete: true, decisionIds: ["log.scope", "log.validation"] }), "utf8");
  await writeFile(join(taskDir, "implement.jsonl"), `${JSON.stringify({ file: "src/main.ts", reason: "Implementation target" })}\n`, "utf8");
  await writeFile(join(taskDir, "check.jsonl"), `${JSON.stringify({ file: "tests/main.test.ts", reason: "Validation target" })}\n`, "utf8");
  for (const [decisionId, roundKind] of [["log.scope", "scope"], ["log.runtime", "runtime"], ["log.validation", "validation"]] as const) {
    const decision = await workflowRun(root, { action: "record_grill_decision", mode: "execute", task: create.task, decisionId, decisionSource: "user", decisionSeverity: "blocking", decisionSummary: `Approved ${roundKind}.`, roundKind });
    assert.equal(decision.ok, true);
  }

  const finalize = await workflowRun(root, { action: "finalize_grill", mode: "execute", task: create.task, userConfirmed: true, decisionSource: "user", notes: "User confirmed PRD." });
  assert.equal(finalize.ok, false);
  assert.ok(blockerCodes(finalize).includes("prd_missing_grill_decision"));
});

test("finalize_grill rejects stale PRD final confirmation hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-grill-stale-prd-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Stale PRD", level: "complex", slug: "stale-prd" });
  await seedManifestFiles(root);
  const taskDir = join(root, ".workflow/tasks", create.task!);
  const decisionIds = ["stale.scope", "stale.runtime", "stale.validation"];
  await writeFile(join(taskDir, "prd.md"), `${prdMarkdown("Stale PRD", { finishComplete: true, decisionIds })}\n\n## Late Change\nThis edit happened after confirmation.\n`, "utf8");
  await writeFile(join(taskDir, "implement.jsonl"), `${JSON.stringify({ file: "src/main.ts", reason: "Implementation target" })}\n`, "utf8");
  await writeFile(join(taskDir, "check.jsonl"), `${JSON.stringify({ file: "tests/main.test.ts", reason: "Validation target" })}\n`, "utf8");
  for (const [decisionId, roundKind] of [[decisionIds[0], "scope"], [decisionIds[1], "runtime"], [decisionIds[2], "validation"]] as const) {
    const decision = await workflowRun(root, { action: "record_grill_decision", mode: "execute", task: create.task, decisionId, decisionSource: "user", decisionSeverity: "blocking", decisionSummary: `Approved ${roundKind}.`, roundKind });
    assert.equal(decision.ok, true);
  }

  const finalize = await workflowRun(root, { action: "finalize_grill", mode: "execute", task: create.task, userConfirmed: true, decisionSource: "user", notes: "User confirmed PRD." });
  assert.equal(finalize.ok, false);
  assert.ok(blockerCodes(finalize).includes("prd_changed_after_final_confirmation"));
});

test("update_prd_section replaces and appends deterministic PRD sections", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-update-prd-section-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Update PRD", level: "standard", slug: "update-prd" });

  const dryRun = await workflowRun(root, { action: "update_prd_section", mode: "dry_run", task: create.task, prdSection: "requirements", prdContent: "- R1: Deterministic PRD updates." });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.mutated, false);

  const replaced = await workflowRun(root, { action: "update_prd_section", mode: "execute", task: create.task, prdSection: "requirements", prdContent: "- R1: Deterministic PRD updates." });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.mutated, true);

  const appended = await workflowRun(root, { action: "update_prd_section", mode: "execute", task: create.task, prdSection: "requirements", prdUpdateMode: "append", prdContent: "- R2: Append mode preserves previous requirements." });
  assert.equal(appended.ok, true);
  const prd = await readFile(join(root, ".workflow/tasks", create.task!, "prd.md"), "utf8");
  assert.match(prd, /R1: Deterministic PRD updates/);
  assert.match(prd, /R2: Append mode preserves previous requirements/);
});

test("record_round_and_update_prd records decisions, updates PRD and enables finalize", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-record-round-prd-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Composite Round", level: "standard", slug: "composite-round" });

  const dryRun = await workflowRun(root, {
    action: "record_round_and_update_prd",
    mode: "dry_run",
    task: create.task,
    roundId: "round-1-scope",
    roundKind: "scope",
    decisions: [
      { decisionId: "composite.scope", decisionSource: "ask_user_question", decisionSeverity: "blocking", decisionSummary: "Scope approved for composite action.", persistTo: "prd" },
    ],
    prdUpdates: [
      { prdSection: "requirements", prdContent: "- R1: Composite action records and writes PRD in one call." },
    ],
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.mutated, false);

  const scope = await workflowRun(root, {
    action: "record_round_and_update_prd",
    mode: "execute",
    task: create.task,
    roundId: "round-1-scope",
    roundKind: "scope",
    decisions: [
      { decisionId: "composite.scope", decisionSource: "ask_user_question", decisionSeverity: "blocking", decisionSummary: "Scope approved for composite action.", persistTo: "prd" },
    ],
    prdUpdates: [
      { prdSection: "executionContract", prdContent: "- Flow Level: standard\n- Outcome: Composite round PRD is implementation-ready." },
      { prdSection: "goal", prdContent: "Use one workflow_run call per business round for deterministic PRD intake." },
      { prdSection: "requirements", prdContent: "- R1: Composite action records decisions and updates PRD sections in one call." },
      { prdSection: "openQuestions", prdContent: "None." },
    ],
  });
  assert.equal(scope.ok, true);
  assert.equal(scope.mutated, true);

  const runtime = await workflowRun(root, {
    action: "record_round_and_update_prd",
    mode: "execute",
    task: create.task,
    roundId: "round-2-runtime",
    roundKind: "runtime",
    decisions: [
      { decisionId: "composite.runtime", decisionSource: "ask_user_question", decisionSeverity: "blocking", decisionSummary: "Runtime behavior approved for composite action.", persistTo: "prd" },
    ],
    prdUpdates: [
      { prdSection: "acceptanceCriteria", prdContent: "- [ ] Composite action output lists recorded decisions and changed PRD sections." },
      { prdSection: "validationPlan", prdContent: "- [ ] npm test" },
      { prdSection: "definitionOfDone", prdContent: "- [ ] PRD decision log includes both composite decisions." },
      { prdSection: "outOfScope", prdContent: "- Final PRD confirmation remains a separate command." },
      { prdSection: "architectureImpact", prdContent: "Workflow engine adds a composite action under workflow_run; no new top-level tool." },
    ],
  });
  assert.equal(runtime.ok, true);

  const prd = await readFile(join(root, ".workflow/tasks", create.task!, "prd.md"), "utf8");
  assert.match(prd, /composite\.scope/);
  assert.match(prd, /composite\.runtime/);
  assert.match(prd, /Composite action records decisions/);

  const confirmed = await confirmPrdFinal(root, { task: create.task, mode: "execute", message: "User approved composite round PRD." });
  assert.equal(confirmed.ok, true);
  const finalize = await workflowRun(root, { action: "finalize_grill", mode: "execute", task: create.task, userConfirmed: true, decisionSource: "ask_user_question", notes: "User confirmed PRD." });
  assert.equal(finalize.ok, true);
});

test("append_prd_decisions writes grill log and enables multi-round finalize", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-append-prd-decisions-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Append Decisions", level: "complex", slug: "append-decisions" });
  await seedManifestFiles(root);
  const taskDir = join(root, ".workflow/tasks", create.task!);
  await writeFile(join(taskDir, "prd.md"), prdMarkdown("Append Decisions", { finishComplete: true, finalConfirmed: false, decisionIds: [] }), "utf8");
  await writeFile(join(taskDir, "implement.jsonl"), `${JSON.stringify({ file: "src/main.ts", reason: "Implementation target" })}\n`, "utf8");
  await writeFile(join(taskDir, "check.jsonl"), `${JSON.stringify({ file: "tests/main.test.ts", reason: "Validation target" })}\n`, "utf8");

  for (const [decisionId, roundKind] of [["append.scope", "scope"], ["append.runtime", "runtime"], ["append.validation", "validation"]] as const) {
    const decision = await workflowRun(root, { action: "record_grill_decision", mode: "execute", task: create.task, decisionId, decisionSource: "user", decisionSeverity: "blocking", decisionSummary: `Approved ${roundKind}.`, roundKind });
    assert.equal(decision.ok, true);
    const dryRun = await workflowRun(root, { action: "append_prd_decisions", mode: "dry_run", task: create.task });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.mutated, false);
    const appended = await workflowRun(root, { action: "append_prd_decisions", mode: "execute", task: create.task });
    assert.equal(appended.ok, true);
    assert.match(await readFile(join(taskDir, "prd.md"), "utf8"), new RegExp(decisionId.replace(".", "\\.")));
  }

  const confirmed = await confirmPrdFinal(root, { task: create.task, mode: "execute", message: "User approved append decisions PRD." });
  assert.equal(confirmed.ok, true);
  const finalize = await workflowRun(root, { action: "finalize_grill", mode: "execute", task: create.task, userConfirmed: true, decisionSource: "user", notes: "User confirmed PRD." });
  assert.equal(finalize.ok, true);
  const start = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: create.task });
  assert.equal(start.ok, true);
});

test("workflow_run batch returns envelope metadata and next recommendation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-batch-"));
  await executeInitWorkspace(root, "generic");

  const result = await workflowRun(root, {
    action: "batch",
    mode: "dry_run",
    actions: [
      { action: "create_from_grill", title: "Batch Task", level: "standard", slug: "batch-task" },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "batch");
  assert.equal(result.results?.length, 1);
  assert.equal(result.results?.[0].action, "create_from_grill");
  assert.equal(result.results?.[0].meta, undefined);
  assert.ok(result.transaction?.artifactRef?.includes(".workflow/.runtime/transactions/"));
  assert.match(await readFile(join(root, result.transaction!.artifactRef!), "utf8"), /resultsSummary/);
  assert.equal(result.nextRecommendedCall?.name, "workflow_next");
  assert.ok((result.meta?.estimatedTokens ?? 0) > 0);
});

test("workflow_run execute batch records transaction artifact and rollback hints", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-batch-exec-"));
  await executeInitWorkspace(root, "generic");

  const result = await workflowRun(root, {
    action: "batch",
    mode: "execute",
    actions: [
      { action: "create_from_grill", title: "Batch Execute", level: "standard", slug: "batch-execute" },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.mutated, true);
  assert.equal(result.transaction?.state, "committed");
  assert.equal(result.rollbackHints?.[0]?.kind, "remove_created_task");
  assert.ok(result.transaction?.artifactRef?.includes(".workflow/.runtime/transactions/"));
  assert.match(await readFile(join(root, result.transaction!.artifactRef!), "utf8"), /Batch Execute/);
});

test("workflow compaction summary preserves active workflow state", () => {
  const built = buildWorkflowCompactionSummary({
    branchEntries: [
      { type: "custom", customType: "pi-coding-workflow", data: { kind: "workflow_next", task: "06-12-demo", status: "in_progress", stage: "execute", flowLevel: "complex", nextAction: "implement_slice", artifactRefs: [".workflow/.runtime/checkpoints/a.json"] } },
    ],
    preparation: {
      previousSummary: "Previous user goal and decisions.",
      messagesToSummarize: [
        { role: "user", content: [{ type: "text", text: "Please continue implementation." }] },
        { role: "assistant", content: [{ type: "text", text: "I will run the workflow." }] },
      ],
      fileOps: { readFiles: ["src/index.ts"], modifiedFiles: ["src/engine/run.ts"] },
    },
  });

  assert.ok(built);
  assert.match(built!.summary, /activeTask: 06-12-demo/);
  assert.match(built!.summary, /workflow_next/);
  assert.ok(built!.details.modifiedFiles.includes("src/engine/run.ts"));
});

test("workflow compaction avoids recursive previous summary growth", () => {
  const previous = `## Workflow State\n- activeTask: 06-12-old\n- status/stage: in_progress/execute\n- nextAction: implement_slice\n\n## Progress\nPrevious compaction summary excerpt:\n## Workflow State\n- activeTask: older\nPrevious compaction summary excerpt:\nolder older`;
  const built = buildWorkflowCompactionSummary({
    branchEntries: [
      { type: "custom", customType: "pi-coding-workflow", data: { kind: "workflow_next", task: "06-13-new", status: "planning", stage: "grill", nextAction: "ask_user" } },
    ],
    preparation: {
      previousSummary: previous,
      messagesToSummarize: [
        { role: "user", content: [{ type: "text", text: "Continue with a concise grill." }] },
      ],
      fileOps: { readFiles: Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`), modifiedFiles: Array.from({ length: 30 }, (_, i) => `src/mod-${i}.ts`) },
    },
  });

  assert.ok(built);
  assert.match(built!.summary, /Previous workflow checkpoint: activeTask=06-12-old/);
  assert.equal((built!.summary.match(/Previous compaction summary excerpt/g) ?? []).length, 0);
  assert.ok(built!.summary.length <= 3200 + 32);
  assert.equal(built!.details.readFiles.length, 20);
  assert.equal(built!.details.modifiedFiles.length, 20);
});

test("workflow telemetry writes schema-versioned JSONL events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-telemetry-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Telemetry", level: "standard", slug: "telemetry" });
  await workflowNext(root, { task: create.task });
  const checkpointResult = await workflowRun(root, { action: "checkpoint", mode: "dry_run", task: create.task, phase: "custom" });

  const events = await readTelemetryEvents(root);
  assert.ok(events.some((event) => event.event === "workflow_run" && event.action === "create_from_grill" && event.schemaVersion === 1));
  assert.ok(events.some((event) => event.event === "workflow_next" && event.task === create.task && event.contextMode === "lite" && typeof event.estimatedTokens === "number"));
  assert.ok(events.some((event) => event.event === "workflow_run" && event.action === "checkpoint" && event.artifactRefs.includes(checkpointResult.artifactRef)));
  const checkpoint = JSON.parse(await readFile(join(root, checkpointResult.artifactRef!), "utf8"));
  assert.equal(checkpoint.kind, "pi-coding-workflow.checkpoint");
  assert.equal(checkpoint.schemaVersion, 1);
});

test("workflow_next emits telemetry budget warnings after repeated calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-telemetry-warn-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Telemetry Warning", level: "standard", slug: "telemetry-warning" });
  let next = await workflowNext(root, { task: create.task, detail: "normal" });
  for (let i = 0; i < 12; i++) next = await workflowNext(root, { task: create.task, detail: "normal" });
  assert.ok(next.warnings.some((warning) => warning.code === "workflow_next_repeated"));
  assert.ok(next.warnings.some((warning) => warning.code === "workflow_next_signal_suggested"));
});

test("start preflight blocks missing PRD", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-p1-missing-prd-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Missing PRD", level: "complex", slug: "missing-prd" });
  await seedTaskPreflight(root, create.task!, { finishComplete: false });
  await rm(join(root, ".workflow/tasks", create.task!, "prd.md"));

  const start = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: create.task });
  assert.equal(start.ok, false);
  assert.ok(blockerCodes(start).includes("prd_missing"));
});

test("start preflight blocks PRD TODO and empty manifest skeletons", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-p1-todo-manifest-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "TODO PRD", level: "complex", slug: "todo-prd" });
  const taskDir = join(root, ".workflow/tasks", create.task!);
  await writeFile(join(taskDir, "prd.md"), prdMarkdown("TODO PRD", { todo: true, finishComplete: false }), "utf8");

  const start = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: create.task });
  assert.equal(start.ok, false);
  assert.ok(blockerCodes(start).includes("prd_todo_present"));
  assert.ok(blockerCodes(start).includes("implement_manifest_empty"));
  assert.ok(blockerCodes(start).includes("check_manifest_empty"));
});

test("start preflight blocks blocking open questions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-p1-openq-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Open Question", level: "complex", slug: "open-question" });
  await seedTaskPreflight(root, create.task!, { openQuestions: "- Which API should be used?", finishComplete: false });

  const start = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: create.task });
  assert.equal(start.ok, false);
  assert.ok(blockerCodes(start).includes("prd_open_questions_blocking"));
});

test("finish preflight blocks unchecked finish checklist without requiring message in dry-run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-p1-finish-block-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Finish Block", level: "complex", slug: "finish-block" });
  await seedTaskPreflight(root, create.task!, { finishComplete: false });
  const start = await workflowRun(root, { action: "start_checked", mode: "execute", task: create.task });
  assert.equal(start.ok, true);

  const finish = await workflowRun(root, { action: "finish_run", mode: "dry_run", task: create.task });
  assert.equal(finish.ok, false);
  assert.ok(blockerCodes(finish).includes("prd_acceptance_criteria_unchecked"));
  assert.ok(blockerCodes(finish).includes("prd_validation_plan_unchecked"));
  assert.ok(blockerCodes(finish).includes("prd_definition_of_done_unchecked"));
});

test("finish preflight passes completed checklist and execute still requires message", async () => {
  const root = await mkdtemp(join(tmpdir(), "pcw-p1-finish-pass-"));
  await executeInitWorkspace(root, "generic");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Finish Pass", level: "complex", slug: "finish-pass" });
  await seedTaskPreflight(root, create.task!, { finishComplete: true });
  const start = await workflowRun(root, { action: "start_checked", mode: "execute", task: create.task });
  assert.equal(start.ok, true);

  const finishDryRun = await workflowRun(root, { action: "finish_run", mode: "dry_run", task: create.task });
  assert.equal(finishDryRun.ok, true);

  const finishWithoutMessage = await workflowRun(root, { action: "finish_run", mode: "execute", task: create.task });
  assert.equal(finishWithoutMessage.ok, false);
  assert.ok(blockerCodes(finishWithoutMessage).includes("missing_message"));

  const finish = await workflowRun(root, { action: "finish_run", mode: "execute", task: create.task, message: "complete p1 gates" });
  assert.equal(finish.ok, true);
  assert.equal(finish.status, "completed");
});
