import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProjectWorkflowConfig, WorkflowRagSource } from "../../types.ts";
import { normalizeSlash, resolveInsideRoot } from "../../safety/pathPolicy.ts";
import { stableShortHash } from "../../artifacts/writeToolResult.ts";
import { collectWorkflowRagChunks } from "./chunker.ts";
import type { WorkflowRagChunk, WorkflowRagIndexFile, WorkflowRagStatus } from "./types.ts";

const RAG_DIR = ".workflow/.runtime/rag";
const CHUNKS_REF = `${RAG_DIR}/chunks.jsonl`;
const INDEX_REF = `${RAG_DIR}/index.json`;

export interface WorkflowRagReindexPlan {
  chunks: WorkflowRagChunk[];
  chunkCount: number;
  sourceHash: string;
  sources: Record<string, number>;
  chunksRef: string;
  indexRef: string;
}

export interface WorkflowRagWriteResult extends WorkflowRagReindexPlan {
  changed: boolean;
}

export async function planWorkflowRagReindex(root: string, config: ProjectWorkflowConfig | null, options: { sources?: WorkflowRagSource[] } = {}): Promise<WorkflowRagReindexPlan> {
  const chunks = await collectWorkflowRagChunks(root, config, options);
  const sources = countSources(chunks);
  return {
    chunks,
    chunkCount: chunks.length,
    sourceHash: sourceHash(chunks),
    sources,
    chunksRef: CHUNKS_REF,
    indexRef: INDEX_REF,
  };
}

export async function writeWorkflowRagIndex(root: string, plan: WorkflowRagReindexPlan): Promise<WorkflowRagWriteResult> {
  const oldHash = await currentSourceHash(root);
  const index: WorkflowRagIndexFile = {
    schemaVersion: 1,
    kind: "pi-coding-workflow.rag-index",
    mode: "lexical",
    chunkCount: plan.chunkCount,
    sourceHash: plan.sourceHash,
    chunksRef: CHUNKS_REF,
    updatedAt: new Date().toISOString(),
    sources: plan.sources,
  };
  await mkdir(resolveInsideRoot(root, RAG_DIR), { recursive: true });
  await writeFile(resolveInsideRoot(root, CHUNKS_REF), `${plan.chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}${plan.chunks.length > 0 ? "\n" : ""}`, "utf8");
  await writeFile(resolveInsideRoot(root, INDEX_REF), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return { ...plan, changed: oldHash !== plan.sourceHash };
}

export async function readWorkflowRagStatus(root: string, config: ProjectWorkflowConfig | null): Promise<WorkflowRagStatus> {
  const enabled = config?.rag?.enabled === true;
  const mode = config?.rag?.mode ?? "lexical";
  const indexPath = resolveInsideRoot(root, INDEX_REF);
  const chunksPath = resolveInsideRoot(root, CHUNKS_REF);
  if (!existsSync(indexPath) || !existsSync(chunksPath)) {
    return { enabled, mode, indexState: enabled ? "missing" : "disabled", chunkCount: 0, indexRef: INDEX_REF, chunksRef: CHUNKS_REF };
  }
  try {
    const index = JSON.parse(await readFile(indexPath, "utf8")) as WorkflowRagIndexFile;
    return {
      enabled,
      mode,
      indexState: enabled ? "fresh" : "disabled",
      chunkCount: index.chunkCount ?? 0,
      sourceHash: index.sourceHash,
      chunksRef: index.chunksRef ?? CHUNKS_REF,
      indexRef: INDEX_REF,
      updatedAt: index.updatedAt,
      sources: index.sources,
    };
  } catch {
    return { enabled, mode, indexState: enabled ? "missing" : "disabled", chunkCount: 0, indexRef: INDEX_REF, chunksRef: CHUNKS_REF };
  }
}

export async function readWorkflowRagChunks(root: string): Promise<WorkflowRagChunk[]> {
  const path = resolveInsideRoot(root, CHUNKS_REF);
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  const chunks: WorkflowRagChunk[] = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as WorkflowRagChunk;
      if (parsed.schemaVersion === 1 && parsed.id && parsed.content) chunks.push(parsed);
    } catch {
      // Ignore malformed runtime RAG lines; rag_status/reindex can repair the index.
    }
  }
  return chunks;
}

export async function writeWorkflowRagQueryArtifact(root: string, payload: unknown, idMaterial: unknown): Promise<string> {
  const id = `query-${stableShortHash(idMaterial)}`;
  const ref = normalizeSlash(`${RAG_DIR}/queries/${id}.json`);
  const abs = resolveInsideRoot(root, ref);
  if (!existsSync(abs)) {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  return ref;
}

async function currentSourceHash(root: string): Promise<string | undefined> {
  const path = resolveInsideRoot(root, INDEX_REF);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as WorkflowRagIndexFile;
    return parsed.sourceHash;
  } catch {
    return undefined;
  }
}

function countSources(chunks: WorkflowRagChunk[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const chunk of chunks) counts[chunk.kind] = (counts[chunk.kind] ?? 0) + 1;
  return counts;
}

function sourceHash(chunks: WorkflowRagChunk[]): string {
  const material = chunks.map((chunk) => `${chunk.id}:${chunk.contentHash}`).sort().join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}
