import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executeInitWorkspace } from "../init/initWorkspace.ts";
import { workflowNext } from "../engine/route.ts";
import { workflowRun } from "../engine/run.ts";
import { normalizeSlash } from "../safety/pathPolicy.ts";

type ReplayVariant = "as_is" | "planning" | "in_progress";

interface ReplayOptions {
  sourceRoot: string;
  outDir: string;
  limit: number;
  keepTemp: boolean;
  variants: ReplayVariant[];
  samples?: Set<string>;
}

interface TaskSample {
  id: string;
  sourceDir: string;
  sourceRel: string;
  archived: boolean;
  archiveBucket?: string;
  files: {
    taskJson: boolean;
    prd: boolean;
    implement: boolean;
    check: boolean;
    telemetry: boolean;
  };
  sourceTask?: any;
  prdBytes: number;
  implementEntries: number;
  checkEntries: number;
}

interface ReplayResult {
  id: string;
  replayId: string;
  sourceRel: string;
  archived: boolean;
  variant: ReplayVariant;
  initialStatus?: string;
  normalizedStatus?: string;
  normalizedStage?: string;
  flowLevel?: string;
  files: TaskSample["files"];
  prdBytes: number;
  implementEntries: number;
  checkEntries: number;
  copiedReferenceFiles: number;
  missingReferenceFiles: string[];
  routeOk: boolean;
  nextAction?: string;
  secondPassCacheHit?: boolean;
  nextEstimatedTokens?: number;
  nextTargetTokens?: number;
  blockers: string[];
  warnings: string[];
  adaptive?: { strategy?: string; recommendedAgent?: string; risk?: string; confidence?: number; briefAgent?: string };
  checkpoint?: { ok: boolean; summary: string; blockers: string[]; warnings: string[] };
  startDryRun?: { ok: boolean; blockers: string[] };
  finishDryRun?: { ok: boolean; blockers: string[] };
  completedRouteOk?: boolean;
  errors: string[];
  durationMs: number;
  tempRoot?: string;
}

interface ReplayReport {
  schemaVersion: 1;
  kind: "pi-coding-workflow.history-replay";
  createdAt: string;
  sourceRoot: string;
  options: { limit: number; keepTemp: boolean; variants: ReplayVariant[]; samples?: string[] };
  inventory: Record<string, unknown>;
  summary: Record<string, unknown>;
  distributions: Record<string, Record<string, number>>;
  results: ReplayResult[];
}

const DEFAULT_SOURCE = ".";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const samples = await discoverTaskSamples(options.sourceRoot);
  const selected = selectSamples(samples, options);
  const replayCases = selected.flatMap((sample) => options.variants.map((variant) => ({ sample, variant })));
  const results: ReplayResult[] = [];

  for (const replayCase of replayCases) {
    results.push(await replaySample(replayCase.sample, replayCase.variant, options));
  }

  const report: ReplayReport = {
    schemaVersion: 1,
    kind: "pi-coding-workflow.history-replay",
    createdAt: new Date().toISOString(),
    sourceRoot: options.sourceRoot,
    options: { limit: options.limit, keepTemp: options.keepTemp, variants: options.variants, samples: options.samples ? [...options.samples] : undefined },
    inventory: inventory(samples, selected, replayCases.length),
    summary: summarize(results, Date.now() - started),
    distributions: distributions(results),
    results,
  };

  await mkdir(options.outDir, { recursive: true });
  const stamp = timestampForFile();
  const jsonPath = join(options.outDir, `history-replay-${stamp}.json`);
  const mdPath = join(options.outDir, `history-replay-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(mdPath, renderMarkdown(report), "utf8");
  await writeFile(join(options.outDir, "history-replay-latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(options.outDir, "history-replay-latest.md"), renderMarkdown(report), "utf8");

  console.log(renderConsole(report));
  console.log(`\nJSON report: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);
}

function parseArgs(args: string[]): ReplayOptions {
  let sourceRoot = DEFAULT_SOURCE;
  let outDir = "reports";
  let limit = 0;
  let keepTemp = false;
  let variants: ReplayVariant[] = ["as_is"];
  let samples: Set<string> | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") outDir = args[++i] ?? outDir;
    else if (arg === "--limit") limit = Number(args[++i] ?? "0") || 0;
    else if (arg === "--keep-temp") keepTemp = true;
    else if (arg === "--variants") variants = parseVariants(args[++i] ?? "as_is");
    else if (arg === "--sample") samples = new Set((args[++i] ?? "").split(",").map((item) => item.trim()).filter(Boolean));
    else positional.push(arg);
  }
  if (positional[0]) sourceRoot = positional[0];
  return { sourceRoot: resolve(sourceRoot), outDir, limit, keepTemp, variants, samples };
}

function parseVariants(value: string): ReplayVariant[] {
  const aliases: Record<string, ReplayVariant> = { "as-is": "as_is", as_is: "as_is", planning: "planning", in_progress: "in_progress", "in-progress": "in_progress" };
  const parsed = value.split(",").map((item) => aliases[item.trim()]).filter((item): item is ReplayVariant => Boolean(item));
  return parsed.length > 0 ? [...new Set(parsed)] : ["as_is"];
}

async function discoverTaskSamples(sourceRoot: string): Promise<TaskSample[]> {
  const tasksRoot = join(sourceRoot, ".workflow/tasks");
  const dirs = await walkTaskDirs(tasksRoot);
  const samples: TaskSample[] = [];
  for (const dir of dirs) {
    const taskPath = join(dir, "task.json");
    if (!existsSync(taskPath)) continue;
    const sourceRel = normalizeSlash(relative(tasksRoot, dir));
    const archived = sourceRel.startsWith("archive/");
    const sourceTask = await readJsonSafe(taskPath);
    const id = String(sourceTask?.id ?? basename(dir));
    const prdPath = join(dir, "prd.md");
    const implementPath = join(dir, "implement.jsonl");
    const checkPath = join(dir, "check.jsonl");
    samples.push({
      id,
      sourceDir: dir,
      sourceRel,
      archived,
      archiveBucket: archived ? sourceRel.split("/").slice(0, 2).join("/") : undefined,
      files: {
        taskJson: true,
        prd: existsSync(prdPath),
        implement: existsSync(implementPath),
        check: existsSync(checkPath),
        telemetry: existsSync(join(dir, "telemetry.jsonl")),
      },
      sourceTask,
      prdBytes: existsSync(prdPath) ? (await stat(prdPath)).size : 0,
      implementEntries: existsSync(implementPath) ? (await manifestFiles(implementPath)).length : 0,
      checkEntries: existsSync(checkPath) ? (await manifestFiles(checkPath)).length : 0,
    });
  }
  return samples.sort((a, b) => a.id.localeCompare(b.id));
}

async function walkTaskDirs(root: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  if (existsSync(join(root, "task.json"))) {
    out.push(root);
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await walkTaskDirs(join(root, entry.name), out);
  }
  return out;
}

function selectSamples(samples: TaskSample[], options: ReplayOptions): TaskSample[] {
  let selected = samples.filter((sample) => !options.samples || options.samples.has(sample.id));
  // Prioritize complete and workflow-architecture samples, then keep deterministic order.
  selected = selected.sort((a, b) => scoreSample(b) - scoreSample(a) || a.id.localeCompare(b.id));
  if (options.limit > 0) selected = selected.slice(0, options.limit);
  return selected;
}

function scoreSample(sample: TaskSample): number {
  let score = 0;
  if (sample.files.prd) score += 5;
  if (sample.files.implement) score += 4;
  if (sample.files.check) score += 4;
  if (sample.files.telemetry) score += 2;
  if (/adaptive|subagent|cache|token|prd|finish|runtime|stage|observability/i.test(sample.id)) score += 4;
  if (sample.archived) score += 1;
  return score;
}

async function replaySample(sample: TaskSample, variant: ReplayVariant, options: ReplayOptions): Promise<ReplayResult> {
  const started = Date.now();
  const tempRoot = await mkdtemp(join(tmpdir(), "pcw-history-replay-"));
  const result: ReplayResult = {
    id: sample.id,
    replayId: `${sample.id}#${variant}`,
    sourceRel: sample.sourceRel,
    archived: sample.archived,
    variant,
    initialStatus: sample.sourceTask?.status,
    files: sample.files,
    prdBytes: sample.prdBytes,
    implementEntries: sample.implementEntries,
    checkEntries: sample.checkEntries,
    copiedReferenceFiles: 0,
    missingReferenceFiles: [],
    routeOk: false,
    blockers: [],
    warnings: [],
    errors: [],
    durationMs: 0,
    tempRoot: options.keepTemp ? tempRoot : undefined,
  };

  try {
    await prepareReplayWorkspace(options.sourceRoot, tempRoot, sample, variant, result);
    const next = await workflowNext(tempRoot, { task: sample.id });
    const cached = await workflowNext(tempRoot, { task: sample.id });
    const checkNext = await workflowNext(tempRoot, { task: sample.id, agent: "check" });
    const finishNext = await workflowNext(tempRoot, { task: sample.id, agent: "finish" });
    const checkpoint = await workflowRun(tempRoot, { action: "checkpoint", mode: "dry_run", task: sample.id, phase: "custom" });

    result.routeOk = next.ok;
    result.normalizedStatus = next.status;
    result.normalizedStage = next.stage;
    result.flowLevel = next.flowLevel;
    result.nextAction = next.nextAction;
    result.secondPassCacheHit = cached.cache?.hit === true;
    result.nextEstimatedTokens = next.meta?.estimatedTokens;
    result.nextTargetTokens = next.meta?.targetTokens;
    result.blockers = next.blockedBy.map((blocker) => blocker.code);
    result.warnings = next.warnings.map((warning) => warning.code);
    result.adaptive = {
      strategy: next.adaptiveControl?.strategy,
      recommendedAgent: next.adaptiveControl?.recommendedAgent,
      risk: next.adaptiveControl?.risk,
      confidence: next.adaptiveControl?.confidence,
      briefAgent: next.adaptiveControl?.subagentBriefs?.[0]?.agent,
    };
    result.checkpoint = { ok: checkpoint.ok, summary: checkpoint.summary, blockers: checkpoint.blockedBy.map((blocker) => blocker.code), warnings: checkpoint.warnings.map((warning) => warning.code) };

    if (next.status === "planning") {
      const start = await workflowRun(tempRoot, { action: "start_checked", mode: "dry_run", task: sample.id });
      result.startDryRun = { ok: start.ok, blockers: start.blockedBy.map((blocker) => blocker.code) };
    }
    if (next.status === "in_progress") {
      const finish = await workflowRun(tempRoot, { action: "finish_run", mode: "dry_run", task: sample.id });
      result.finishDryRun = { ok: finish.ok, blockers: finish.blockedBy.map((blocker) => blocker.code) };
    }
    if (next.status === "completed") {
      result.completedRouteOk = next.nextAction === "none" && finishNext.nextAction === "none" && checkNext.nextAction === "none";
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    result.durationMs = Date.now() - started;
    if (!options.keepTemp) await rm(tempRoot, { recursive: true, force: true });
  }
  return result;
}

async function prepareReplayWorkspace(sourceRoot: string, tempRoot: string, sample: TaskSample, variant: ReplayVariant, result: ReplayResult): Promise<void> {
  await executeInitWorkspace(tempRoot, "unity");
  const specSource = join(sourceRoot, ".workflow/spec");
  const specTarget = join(tempRoot, ".workflow/spec");
  if (existsSync(specSource)) {
    await rm(specTarget, { recursive: true, force: true });
    await cp(specSource, specTarget, { recursive: true, force: true });
  }

  const targetTaskDir = join(tempRoot, ".workflow/tasks", sample.id);
  await rm(targetTaskDir, { recursive: true, force: true });
  await cp(sample.sourceDir, targetTaskDir, { recursive: true, force: true });
  await applyReplayVariant(join(targetTaskDir, "task.json"), variant);

  const refs = new Set<string>();
  for (const manifest of [join(sample.sourceDir, "implement.jsonl"), join(sample.sourceDir, "check.jsonl")]) {
    for (const file of await manifestFiles(manifest)) refs.add(file);
  }

  for (const ref of refs) {
    const target = join(tempRoot, ref);
    if (existsSync(target)) continue;
    const source = join(sourceRoot, ref);
    if (!existsSync(source)) {
      result.missingReferenceFiles.push(ref);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
    result.copiedReferenceFiles += 1;
  }
}

async function applyReplayVariant(taskJsonPath: string, variant: ReplayVariant): Promise<void> {
  if (variant === "as_is") return;
  const task = await readJsonSafe(taskJsonPath) ?? {};
  if (variant === "planning") {
    task.status = "planning";
    task.stage = "grill";
  } else if (variant === "in_progress") {
    task.status = "in_progress";
    task.stage = "execute";
  }
  task.updatedAt = new Date().toISOString();
  task.updated_at = task.updated_at ?? task.updatedAt;
  await writeFile(taskJsonPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
}

async function manifestFiles(path: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const files: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?._example === true || parsed?.example === true) continue;
      if (typeof parsed?.file === "string" && parsed.file.trim()) files.push(normalizeSlash(parsed.file.trim()));
    } catch {
      // Invalid manifest lines are intentionally left for the engine replay to report.
    }
  }
  return files;
}

async function readJsonSafe(path: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function inventory(all: TaskSample[], selected: TaskSample[], replayCases: number): Record<string, unknown> {
  return {
    discoveredTasks: all.length,
    selectedTasks: selected.length,
    replayCases,
    activeTasks: all.filter((sample) => !sample.archived).length,
    archivedTasks: all.filter((sample) => sample.archived).length,
    withPrd: all.filter((sample) => sample.files.prd).length,
    withImplementManifest: all.filter((sample) => sample.files.implement).length,
    withCheckManifest: all.filter((sample) => sample.files.check).length,
    withTelemetry: all.filter((sample) => sample.files.telemetry).length,
    completeSamples: all.filter((sample) => sample.files.prd && sample.files.implement && sample.files.check).length,
  };
}

function summarize(results: ReplayResult[], elapsedMs: number): Record<string, unknown> {
  const ok = results.filter((result) => result.routeOk);
  const cacheHits = results.filter((result) => result.secondPassCacheHit).length;
  const completed = results.filter((result) => result.normalizedStatus === "completed");
  const planning = results.filter((result) => result.normalizedStatus === "planning");
  const inProgress = results.filter((result) => result.normalizedStatus === "in_progress");
  const checkpointOk = results.filter((result) => result.checkpoint?.ok).length;
  const startRuns = results.filter((result) => result.startDryRun);
  const finishRuns = results.filter((result) => result.finishDryRun);
  const tokenValues = ok.map((result) => result.nextEstimatedTokens ?? 0).filter((value) => value > 0);

  return {
    elapsedMs,
    samples: results.length,
    routeSuccess: ok.length,
    routeSuccessRate: rate(ok.length, results.length),
    secondPassCacheHits: cacheHits,
    secondPassCacheHitRate: rate(cacheHits, results.length),
    avgWorkflowNextEstimatedTokens: average(tokenValues),
    maxWorkflowNextEstimatedTokens: tokenValues.length > 0 ? Math.max(...tokenValues) : 0,
    checkpointPassRate: rate(checkpointOk, results.length),
    completedRouteOkRate: rate(completed.filter((result) => result.completedRouteOk).length, completed.length),
    planningStartDryRunPassRate: rate(startRuns.filter((result) => result.startDryRun?.ok).length, startRuns.length),
    inProgressFinishDryRunPassRate: rate(finishRuns.filter((result) => result.finishDryRun?.ok).length, finishRuns.length),
    normalizedStatusCounts: { completed: completed.length, planning: planning.length, in_progress: inProgress.length },
    totalMissingReferenceFiles: results.reduce((sum, result) => sum + result.missingReferenceFiles.length, 0),
    samplesWithErrors: results.filter((result) => result.errors.length > 0).length,
  };
}

function distributions(results: ReplayResult[]): Record<string, Record<string, number>> {
  return {
    variant: countBy(results.map((result) => result.variant)),
    status: countBy(results.map((result) => result.normalizedStatus ?? "unknown")),
    nextAction: countBy(results.map((result) => result.nextAction ?? "unknown")),
    adaptiveStrategy: countBy(results.map((result) => result.adaptive?.strategy ?? "none")),
    recommendedAgent: countBy(results.map((result) => result.adaptive?.recommendedAgent ?? "none")),
    blockers: countBy(results.flatMap((result) => result.blockers)),
    checkpointBlockers: countBy(results.flatMap((result) => result.checkpoint?.blockers ?? [])),
  };
}

function renderMarkdown(report: ReplayReport): string {
  const summary = report.summary as any;
  const lines = [
    "# History Replay Report",
    "",
    `- Created: ${report.createdAt}`,
    `- Source: ${report.sourceRoot}`,
    `- Samples: ${summary.samples}`,
    `- Variants: ${report.options.variants.join(", ")}`,
    `- Route success: ${summary.routeSuccess}/${summary.samples} (${percent(summary.routeSuccessRate)})`,
    `- Second-pass cache hit: ${summary.secondPassCacheHits}/${summary.samples} (${percent(summary.secondPassCacheHitRate)})`,
    `- Avg workflow_next estimated tokens: ${summary.avgWorkflowNextEstimatedTokens}`,
    `- Max workflow_next estimated tokens: ${summary.maxWorkflowNextEstimatedTokens}`,
    `- Checkpoint pass rate: ${percent(summary.checkpointPassRate)}`,
    `- Completed route OK rate: ${percent(summary.completedRouteOkRate)}`,
    `- Missing referenced files: ${summary.totalMissingReferenceFiles}`,
    `- Samples with errors: ${summary.samplesWithErrors}`,
    "",
    "## Distributions",
    "",
    "### Adaptive strategy",
    table(report.distributions.adaptiveStrategy),
    "",
    "### Recommended agent",
    table(report.distributions.recommendedAgent),
    "",
    "### Blockers",
    table(report.distributions.blockers),
    "",
    "## Per-sample summary",
    "",
    "| Task | Variant | Status | Next | Cache | Adaptive | Agent | Tokens | Blockers | Missing refs | Errors |",
    "|---|---|---:|---|---:|---|---|---:|---:|---:|---:|",
    ...report.results.map((result) => `| ${result.id} | ${result.variant} | ${result.normalizedStatus ?? "?"}/${result.normalizedStage ?? "?"} | ${result.nextAction ?? "?"} | ${result.secondPassCacheHit ? "yes" : "no"} | ${result.adaptive?.strategy ?? "?"} | ${result.adaptive?.recommendedAgent ?? "?"} | ${result.nextEstimatedTokens ?? 0} | ${result.blockers.length} | ${result.missingReferenceFiles.length} | ${result.errors.length} |`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderConsole(report: ReplayReport): string {
  const summary = report.summary as any;
  return [
    "History replay completed",
    `samples=${summary.samples} routeSuccess=${summary.routeSuccess}/${summary.samples} cacheHitRate=${percent(summary.secondPassCacheHitRate)}`,
    `avgNextTokens=${summary.avgWorkflowNextEstimatedTokens} maxNextTokens=${summary.maxWorkflowNextEstimatedTokens}`,
    `checkpointPassRate=${percent(summary.checkpointPassRate)} missingRefs=${summary.totalMissingReferenceFiles} errors=${summary.samplesWithErrors}`,
    `adaptive=${JSON.stringify(report.distributions.adaptiveStrategy)}`,
    `agents=${JSON.stringify(report.distributions.recommendedAgent)}`,
  ].join("\n");
}

function table(values: Record<string, number>): string {
  const rows = Object.entries(values).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return "(none)";
  return ["| Value | Count |", "|---|---:|", ...rows.map(([key, count]) => `| ${key} | ${count} |`)].join("\n");
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function rate(value: number, total: number): number {
  if (total <= 0) return 0;
  return Number((value / total).toFixed(4));
}

function percent(value: number): string {
  return `${Math.round(value * 10_000) / 100}%`;
}

function timestampForFile(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
