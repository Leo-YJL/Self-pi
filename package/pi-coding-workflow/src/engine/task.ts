import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FlowLevel, WorkflowGrillState, WorkflowStatus } from "../types.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";

export interface WorkflowTaskJson {
  id: string;
  title: string;
  status: WorkflowStatus;
  flowLevel: FlowLevel;
  stage: "grill" | "execute" | "finish";
  grill?: WorkflowGrillState;
  createdAt: string;
  updatedAt: string;
  parentTask?: string;
  children?: string[];
  meta?: Record<string, unknown>;
  /** Legacy GameBase task field. Package normalizes it to flowLevel. */
  flow_level?: FlowLevel;
  /** Legacy GameBase task field. Package normalizes it to createdAt. */
  created_at?: string;
  /** Legacy GameBase task field. Package normalizes it to updatedAt. */
  updated_at?: string;
  /** Legacy GameBase task field. Package normalizes it to parentTask. */
  parent_task?: string;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "task";
}

export function todayPrefix(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function taskDirectory(root: string, id: string): string {
  return resolveInsideRoot(root, `.workflow/tasks/${id}`);
}

export function normalizeTask(raw: Partial<WorkflowTaskJson> & Record<string, unknown>): WorkflowTaskJson {
  const id = String(raw.id ?? "");
  const now = new Date().toISOString();
  const status = (raw.status === "planning" || raw.status === "in_progress" || raw.status === "completed" || raw.status === "no_task") ? raw.status : "planning";
  const flowLevel = (raw.flowLevel ?? raw.flow_level ?? "standard") as FlowLevel;
  const stage = (raw.stage === "grill" || raw.stage === "execute" || raw.stage === "finish")
    ? raw.stage
    : status === "in_progress" ? "execute" : status === "completed" ? "finish" : "grill";
  return {
    ...(raw as WorkflowTaskJson),
    id,
    title: String(raw.title ?? id),
    status,
    flowLevel,
    stage,
    createdAt: String(raw.createdAt ?? raw.created_at ?? now),
    updatedAt: String(raw.updatedAt ?? raw.updated_at ?? raw.createdAt ?? raw.created_at ?? now),
    parentTask: raw.parentTask ?? raw.parent_task,
  };
}

export async function createTask(root: string, title: string, level: FlowLevel, slug?: string, parentTask?: string): Promise<WorkflowTaskJson> {
  const id = `${todayPrefix()}-${slug ?? slugify(title)}`;
  const dir = taskDirectory(root, id);
  if (existsSync(dir)) throw new Error(`Task already exists: ${id}`);
  await mkdir(join(dir, "research"), { recursive: true });
  const now = new Date().toISOString();
  const task: WorkflowTaskJson = {
    id,
    title,
    status: "planning",
    flowLevel: level,
    stage: "grill",
    grill: { status: "in_progress", rounds: 0, decisions: [], blockingOpenDecisions: 0, finalConfirmed: false },
    createdAt: now,
    updatedAt: now,
    parentTask,
  };
  await writeTask(root, task);
  await writeFile(join(dir, "prd.md"), `# ${title}\n\n## Execution Contract\n\n- Flow Level: ${level}\n- Outcome: TODO\n\n## Open Questions\n\nNone.\n`, "utf8");
  return task;
}

export async function readTask(root: string, id: string): Promise<WorkflowTaskJson> {
  const path = resolveInsideRoot(root, `.workflow/tasks/${id}/task.json`);
  return normalizeTask(JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>);
}

export async function tryReadTask(root: string, id: string): Promise<WorkflowTaskJson | null> {
  try {
    return await readTask(root, id);
  } catch {
    return null;
  }
}

export async function writeTask(root: string, task: WorkflowTaskJson): Promise<void> {
  const normalized = normalizeTask(task as unknown as Record<string, unknown>);
  normalized.updatedAt = new Date().toISOString();
  const path = resolveInsideRoot(root, `.workflow/tasks/${normalized.id}/task.json`);
  await mkdir(resolveInsideRoot(root, `.workflow/tasks/${normalized.id}`), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

export async function listRootTasks(root: string): Promise<WorkflowTaskJson[]> {
  const tasksRoot = resolveInsideRoot(root, ".workflow/tasks");
  if (!existsSync(tasksRoot)) return [];
  const entries = await readdir(tasksRoot, { withFileTypes: true });
  const tasks: WorkflowTaskJson[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    const task = await tryReadTask(root, entry.name);
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => timestampOf(b) - timestampOf(a));
}

export async function findActiveTask(root: string): Promise<WorkflowTaskJson | null> {
  const tasks = await listRootTasks(root);
  return tasks.find((task) => task.status === "in_progress")
    ?? tasks.find((task) => task.status === "planning")
    ?? null;
}

export function timestampOf(task: WorkflowTaskJson): number {
  const value = task.updatedAt ?? task.updated_at ?? task.createdAt ?? task.created_at ?? "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
