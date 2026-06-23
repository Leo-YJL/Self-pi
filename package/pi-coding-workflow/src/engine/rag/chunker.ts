import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ProjectWorkflowConfig, WorkflowRagSource } from "../../types.ts";
import { normalizeSlash, repoRelative, resolveInsideRoot } from "../../safety/pathPolicy.ts";
import { listArchivedTasks, listRootTasks, type WorkflowTaskJson } from "../task.ts";
import { stableShortHash } from "../../artifacts/writeToolResult.ts";
import type { WorkflowRagChunk, WorkflowRagChunkKind, WorkflowRagTrustTier } from "./types.ts";

interface MarkdownSection {
  title: string;
  level: number;
  body: string;
  lineStart: number;
}

export async function collectWorkflowRagChunks(root: string, config: ProjectWorkflowConfig | null, options: { sources?: WorkflowRagSource[] } = {}): Promise<WorkflowRagChunk[]> {
  const sourceSet = options.sources?.length ? new Set(options.sources) : null;
  const chunks: WorkflowRagChunk[] = [];
  if (sourceEnabled(config, "spec") && (!sourceSet || sourceSet.has("spec"))) {
    chunks.push(...await collectSpecChunks(root));
  }
  const wantsTasks = (!sourceSet || sourceSet.has("activeTask") || sourceSet.has("historicalTasks") || sourceSet.has("tasks"))
    && (sourceEnabled(config, "activeTask") || sourceEnabled(config, "historicalTasks"));
  if (wantsTasks) {
    chunks.push(...await collectTaskChunks(root, config, sourceSet));
  }
  return chunks.sort((a, b) => a.ref.localeCompare(b.ref));
}

async function collectSpecChunks(root: string): Promise<WorkflowRagChunk[]> {
  const specDir = ".workflow/spec";
  const abs = resolveInsideRoot(root, specDir);
  if (!existsSync(abs)) return [];
  const files = (await walkFiles(root, specDir)).filter((file) => file.endsWith(".md"));
  const chunks: WorkflowRagChunk[] = [];
  for (const path of files) {
    const markdown = await readFile(resolveInsideRoot(root, path), "utf8");
    const s = await stat(resolveInsideRoot(root, path));
    for (const section of markdownSections(markdown, basename(path))) {
      const content = sectionText(section);
      if (!content) continue;
      chunks.push(makeChunk({
        kind: "spec_section",
        path,
        title: section.title,
        section: section.title,
        tags: ["spec", ...pathTags(path), section.title],
        trustTier: "spec",
        content,
        sourceMtimeMs: Math.trunc(s.mtimeMs),
        ref: `spec:${path}#${slug(section.title)}`,
      }));
    }
  }
  return chunks;
}

async function collectTaskChunks(root: string, config: ProjectWorkflowConfig | null, sourceSet: Set<WorkflowRagSource> | null): Promise<WorkflowRagChunk[]> {
  const rootTasks = await listRootTasks(root);
  const archivedTasks = sourceEnabled(config, "historicalTasks") ? await listArchivedTasks(root) : [];
  const all = [...rootTasks, ...archivedTasks];
  const chunks: WorkflowRagChunk[] = [];
  for (const task of all) {
    const active = task.status === "planning" || task.status === "in_progress";
    const historical = !active;
    const includeActive = sourceEnabled(config, "activeTask") && (!sourceSet || sourceSet.has("activeTask") || sourceSet.has("tasks"));
    const includeHistorical = sourceEnabled(config, "historicalTasks") && (!sourceSet || sourceSet.has("historicalTasks") || sourceSet.has("tasks"));
    if ((active && !includeActive) || (historical && !includeHistorical)) continue;
    chunks.push(...await taskPrdChunks(root, task, active ? "current_task" : "historical_task"));
    chunks.push(...taskDecisionChunks(task, active ? "current_task" : "historical_task"));
    if (sourceEnabled(config, "manifestFiles") && (!sourceSet || sourceSet.has("manifestFiles") || sourceSet.has("tasks"))) {
      chunks.push(...await taskManifestChunks(root, task, active ? "current_task" : "historical_task"));
    }
  }
  return chunks;
}

async function taskPrdChunks(root: string, task: WorkflowTaskJson, trustTier: WorkflowRagTrustTier): Promise<WorkflowRagChunk[]> {
  const path = `.workflow/tasks/${task.id}/prd.md`;
  const abs = resolveInsideRoot(root, path);
  if (!existsSync(abs)) return [];
  const markdown = await readFile(abs, "utf8");
  const s = await stat(abs);
  const chunks: WorkflowRagChunk[] = [];
  for (const section of markdownSections(markdown, task.title)) {
    const content = sectionText(section);
    if (!content) continue;
    const kind = taskSectionKind(section.title);
    chunks.push(makeChunk({
      kind,
      path,
      title: `${task.title}: ${section.title}`,
      section: section.title,
      task: task.id,
      flowLevel: task.flowLevel,
      status: task.status,
      stage: task.stage,
      tags: ["task", task.id, task.status, task.stage, task.flowLevel, section.title, kind],
      trustTier,
      content,
      sourceMtimeMs: Math.trunc(s.mtimeMs),
      ref: `task:${task.id}#prd:${slug(section.title)}`,
    }));
  }
  return chunks;
}

function taskDecisionChunks(task: WorkflowTaskJson, trustTier: WorkflowRagTrustTier): WorkflowRagChunk[] {
  return (task.grill?.decisions ?? [])
    .filter((decision) => decision.status === "answered")
    .map((decision) => makeChunk({
      kind: "grill_decision",
      path: `.workflow/tasks/${task.id}/task.json`,
      title: `${task.title}: ${decision.id}`,
      section: decision.roundKind ?? "grill_decision",
      task: task.id,
      flowLevel: task.flowLevel,
      status: task.status,
      stage: task.stage,
      tags: ["task", "grill", "decision", task.id, decision.id, decision.roundKind ?? "custom", decision.severity],
      trustTier,
      content: [
        `Decision: ${decision.id}`,
        `Round: ${decision.roundId ?? ""}`,
        `Kind: ${decision.roundKind ?? "custom"}`,
        `Severity: ${decision.severity}`,
        `Source: ${decision.source}`,
        decision.summary,
      ].filter(Boolean).join("\n"),
      ref: `task:${task.id}#grill_decision:${slug(decision.id)}`,
    }));
}

async function taskManifestChunks(root: string, task: WorkflowTaskJson, trustTier: WorkflowRagTrustTier): Promise<WorkflowRagChunk[]> {
  const chunks: WorkflowRagChunk[] = [];
  for (const agent of ["implement", "check"] as const) {
    const path = `.workflow/tasks/${task.id}/${agent}.jsonl`;
    const abs = resolveInsideRoot(root, path);
    if (!existsSync(abs)) continue;
    const text = await readFile(abs, "utf8");
    const s = await stat(abs);
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed._example === true || parsed.example === true) continue;
        const file = String(parsed.file ?? "").trim();
        const reason = String(parsed.reason ?? "").trim();
        if (!file || !reason) continue;
        chunks.push(makeChunk({
          kind: "manifest_entry",
          path,
          title: `${task.title}: ${agent} ${file}`,
          section: `${agent}.jsonl:${index + 1}`,
          task: task.id,
          flowLevel: task.flowLevel,
          status: task.status,
          stage: task.stage,
          agent,
          tags: ["manifest", agent, task.id, file, reason],
          trustTier,
          content: [`Manifest: ${agent}`, `File: ${file}`, `Reason: ${reason}`].join("\n"),
          sourceMtimeMs: Math.trunc(s.mtimeMs),
          ref: `task:${task.id}#manifest:${agent}:${slug(file)}`,
        }));
      } catch {
        // Invalid manifest lines are surfaced by manifest validation, not the RAG indexer.
      }
    }
  }
  return chunks;
}

async function walkFiles(root: string, relDir: string): Promise<string[]> {
  const absDir = resolveInsideRoot(root, relDir);
  if (!existsSync(absDir)) return [];
  const entries = await readdir(absDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = normalizeSlash(`${relDir}/${entry.name}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, rel));
    else if (entry.isFile()) files.push(repoRelative(root, resolveInsideRoot(root, rel)));
  }
  return files.sort();
}

function markdownSections(markdown: string, fallbackTitle: string): MarkdownSection[] {
  const lines = markdown.split(/\r?\n/);
  const headings: Array<{ level: number; title: string; lineIndex: number }> = [];
  lines.forEach((line, lineIndex) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) headings.push({ level: match[1].length, title: match[2].replace(/\s+#+\s*$/, "").trim(), lineIndex });
  });
  if (headings.length === 0) return [{ title: fallbackTitle, level: 1, lineStart: 1, body: markdown.trim() }];
  return headings.map((heading) => {
    const next = headings.find((candidate) => candidate.lineIndex > heading.lineIndex && candidate.level <= heading.level);
    const end = next ? next.lineIndex : lines.length;
    return {
      title: heading.title,
      level: heading.level,
      lineStart: heading.lineIndex + 1,
      body: lines.slice(heading.lineIndex + 1, end).join("\n").trim(),
    };
  });
}

function sectionText(section: MarkdownSection): string {
  const body = section.body.trim();
  const text = [`#`.repeat(Math.min(section.level, 6)) + ` ${section.title}`, body].filter(Boolean).join("\n\n").trim();
  return trimChunkContent(text);
}

function taskSectionKind(title: string): WorkflowRagChunkKind {
  if (/^goals?$/i.test(title) || /目标/i.test(title)) return "task_goal";
  if (/requirements?|需求|要求/i.test(title)) return "task_requirement";
  if (/acceptance|验收/i.test(title)) return "task_acceptance";
  return "task_prd_section";
}

function makeChunk(input: Omit<WorkflowRagChunk, "schemaVersion" | "id" | "contentHash" | "createdAt" | "updatedAt">): WorkflowRagChunk {
  const now = new Date().toISOString();
  const contentHash = hash(input.content);
  return {
    schemaVersion: 1,
    ...input,
    tags: [...new Set(input.tags.map((tag) => String(tag).trim()).filter(Boolean))],
    contentHash,
    id: `chunk-${stableShortHash({ ref: input.ref, kind: input.kind, contentHash })}`,
    createdAt: now,
    updatedAt: now,
  };
}

function sourceEnabled(config: ProjectWorkflowConfig | null, source: WorkflowRagSource): boolean {
  const sources = config?.rag?.sources;
  if (source === "spec") return sources?.spec !== false;
  if (source === "activeTask") return sources?.activeTask !== false;
  if (source === "historicalTasks") return sources?.historicalTasks !== false;
  if (source === "manifestFiles") return sources?.manifestFiles !== false;
  return false;
}

function trimChunkContent(text: string): string {
  const normalized = text.replace(/\s+$/g, "").trim();
  return normalized.length > 2_000 ? `${normalized.slice(0, 1_984).trimEnd()}\n... [truncated]` : normalized;
}

function pathTags(path: string): string[] {
  return normalizeSlash(dirname(path)).split("/").filter(Boolean);
}

function slug(text: string): string {
  return normalizeSlash(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_.-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "section";
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
