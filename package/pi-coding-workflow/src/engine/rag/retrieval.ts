import type { ProjectWorkflowConfig, WorkflowRetrievalSummary, WorkflowRagHitCompact } from "../../types.ts";
import { estimateTokens } from "../contextBudget.ts";
import type { WorkflowContextBundle } from "../contextBundle.ts";
import { lexicalSearchWorkflowRag } from "./lexical.ts";
import { readWorkflowRagChunks, readWorkflowRagStatus, writeWorkflowRagQueryArtifact } from "./indexStore.ts";

export async function retrieveWorkflowMemoryForNext(
  root: string,
  config: ProjectWorkflowConfig | null,
  input: { task?: string; agent?: string; nextAction?: string; bundle?: WorkflowContextBundle | null },
): Promise<WorkflowRetrievalSummary | undefined> {
  if (config?.rag?.enabled !== true) return undefined;
  const status = await readWorkflowRagStatus(root, config);
  const mode = config.rag.mode ?? "lexical";
  if (status.indexState !== "fresh") {
    return {
      enabled: true,
      mode,
      indexState: status.indexState,
      topRefs: [],
      tokenBudget: budgetFor([], 300),
    };
  }

  const chunks = await readWorkflowRagChunks(root);
  const query = buildRetrievalQuery(input);
  const retrieval = config.rag.retrieval ?? {};
  const topK = retrieval.topK ?? 8;
  const maxReturnedRefs = Math.max(1, Math.min(12, Math.trunc(retrieval.maxReturnedRefs ?? 5)));
  const hits = lexicalSearchWorkflowRag(chunks, query, {
    topK,
    minScore: retrieval.minScore ?? 0.12,
    maxPreviewChars: retrieval.maxPreviewChars ?? 240,
  });
  const topRefs: WorkflowRagHitCompact[] = hits.slice(0, maxReturnedRefs).map((hit) => ({
    ref: hit.ref,
    kind: hit.kind,
    path: hit.path,
    score: hit.score,
    reason: hit.reason,
    preview: hit.preview,
  }));

  let queryRef: string | undefined;
  if (retrieval.writeQueryArtifact !== false) {
    queryRef = await writeWorkflowRagQueryArtifact(root, {
      kind: "pi-coding-workflow.rag-query",
      schemaVersion: 1,
      mode,
      task: input.task,
      agent: input.agent,
      nextAction: input.nextAction,
      query,
      hits,
      createdAt: new Date().toISOString(),
    }, { task: input.task, agent: input.agent, nextAction: input.nextAction, query, hitIds: hits.map((hit) => hit.chunkId) });
  }

  return {
    enabled: true,
    mode,
    indexState: status.indexState,
    queryRef,
    topRefs,
    tokenBudget: budgetFor({ topRefs, queryRef }, 500),
  };
}

function buildRetrievalQuery(input: { task?: string; agent?: string; nextAction?: string; bundle?: WorkflowContextBundle | null }): string {
  const bundle = input.bundle;
  if (!bundle) return [input.task, input.agent, input.nextAction].filter(Boolean).join(" ");
  const blockers = bundle.blockedBy.map((blocker) => blocker.code).join(" ");
  const warnings = bundle.warnings.map((warning) => warning.code).join(" ");
  return [
    `task ${bundle.task.id} ${bundle.task.title}`,
    `status ${bundle.task.status} stage ${bundle.task.stage} flow ${bundle.task.flowLevel}`,
    input.agent ? `agent ${input.agent}` : undefined,
    input.nextAction ? `next ${input.nextAction}` : undefined,
    bundle.prd.title,
    bundle.prd.goal,
    bundle.prd.requirements,
    bundle.prd.acceptanceCriteria,
    bundle.prd.validationPlan,
    blockers ? `blockers ${blockers}` : undefined,
    warnings ? `warnings ${warnings}` : undefined,
  ].filter(Boolean).join("\n");
}

function budgetFor(value: unknown, maxRecommended: number): WorkflowRetrievalSummary["tokenBudget"] {
  return { estimatedInput: estimateTokens(value), maxRecommended, cacheHit: false, truncatedBytes: 0, omittedRefs: [] };
}
