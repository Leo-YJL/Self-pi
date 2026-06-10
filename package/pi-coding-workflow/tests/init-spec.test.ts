import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  assert.equal(next.nextAction, "start_checked");

  const startDryRun = await workflowRun(root, { action: "start_checked", mode: "dry_run", task: create.task });
  assert.equal(startDryRun.ok, true);
  assert.equal(startDryRun.mutated, false);

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
