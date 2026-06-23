import type { WorkflowAgent } from "../../types.ts";

export type WorkflowRagChunkKind =
  | "spec_section"
  | "task_prd_section"
  | "task_goal"
  | "task_requirement"
  | "task_acceptance"
  | "grill_decision"
  | "manifest_entry";

export type WorkflowRagTrustTier = "spec" | "current_task" | "historical_task" | "runtime";

export interface WorkflowRagChunk {
  schemaVersion: 1;
  id: string;
  ref: string;
  kind: WorkflowRagChunkKind;
  path: string;
  title?: string;
  section?: string;
  task?: string;
  flowLevel?: string;
  status?: string;
  stage?: string;
  agent?: WorkflowAgent;
  tags: string[];
  trustTier: WorkflowRagTrustTier;
  content: string;
  contentHash: string;
  sourceMtimeMs?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRagIndexFile {
  schemaVersion: 1;
  kind: "pi-coding-workflow.rag-index";
  mode: "lexical";
  chunkCount: number;
  sourceHash: string;
  chunksRef: string;
  updatedAt: string;
  sources: Record<string, number>;
}

export interface WorkflowRagStatus {
  enabled: boolean;
  mode: "lexical" | "embedding" | "hybrid";
  indexState: "disabled" | "missing" | "fresh";
  chunkCount: number;
  sourceHash?: string;
  chunksRef?: string;
  indexRef?: string;
  updatedAt?: string;
  sources?: Record<string, number>;
}

export interface WorkflowRagSearchHit {
  ref: string;
  chunkId: string;
  kind: WorkflowRagChunkKind;
  path: string;
  score: number;
  lexicalScore: number;
  reason: string;
  preview: string;
}
