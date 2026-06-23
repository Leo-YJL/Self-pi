import type { WorkflowRagChunk, WorkflowRagSearchHit } from "./types.ts";

export function lexicalSearchWorkflowRag(chunks: WorkflowRagChunk[], query: string, options: { topK?: number; minScore?: number; maxPreviewChars?: number } = {}): WorkflowRagSearchHit[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];
  const topK = Math.max(1, Math.min(50, Math.trunc(options.topK ?? 8)));
  const minScore = Math.max(0, Math.min(1, Number(options.minScore ?? 0.12)));
  const maxPreviewChars = Math.max(40, Math.min(500, Math.trunc(options.maxPreviewChars ?? 240)));

  const hits = chunks.map((chunk) => scoreChunk(chunk, queryTokens, maxPreviewChars))
    .filter((hit) => hit.score >= minScore)
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));

  return dedupeHits(hits).slice(0, topK);
}

function scoreChunk(chunk: WorkflowRagChunk, queryTokens: string[], maxPreviewChars: number): WorkflowRagSearchHit {
  const searchable = [chunk.title, chunk.section, chunk.path, chunk.tags.join(" "), chunk.content].filter(Boolean).join("\n");
  const tokenSet = new Set(tokenize(searchable));
  const titleSet = new Set(tokenize([chunk.title, chunk.section, chunk.tags.join(" ")].filter(Boolean).join(" ")));
  let matched = 0;
  let titleMatched = 0;
  for (const token of queryTokens) {
    if (tokenSet.has(token)) matched += 1;
    if (titleSet.has(token)) titleMatched += 1;
  }
  const lexicalScore = matched / queryTokens.length;
  const titleBoost = Math.min(0.18, titleMatched * 0.03);
  const trustBoost = trustBoostFor(chunk);
  const score = Math.min(1, Number((lexicalScore + titleBoost + trustBoost).toFixed(4)));
  return {
    ref: chunk.ref,
    chunkId: chunk.id,
    kind: chunk.kind,
    path: chunk.path,
    score,
    lexicalScore: Number(lexicalScore.toFixed(4)),
    reason: reasonFor(chunk, matched, titleMatched),
    preview: preview(chunk.content, maxPreviewChars),
  };
}

function dedupeHits(hits: WorkflowRagSearchHit[]): WorkflowRagSearchHit[] {
  const result: WorkflowRagSearchHit[] = [];
  const seen = new Set<string>();
  const perTask = new Map<string, number>();
  for (const hit of hits) {
    const key = hit.ref.split("#")[0] + "#" + hit.kind;
    const taskMatch = /^task:([^#]+)/.exec(hit.ref);
    const task = taskMatch?.[1];
    if (seen.has(key)) continue;
    if (task) {
      const count = perTask.get(task) ?? 0;
      if (count >= 3) continue;
      perTask.set(task, count + 1);
    }
    seen.add(key);
    result.push(hit);
  }
  return result;
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9_:.#/-]{2,}/g) ?? [];
  const cjkChars = lower.match(/[\u4e00-\u9fa5]/g) ?? [];
  const cjkBigrams: string[] = [];
  for (let i = 0; i < cjkChars.length - 1; i++) cjkBigrams.push(`${cjkChars[i]}${cjkChars[i + 1]}`);
  return [...latin, ...cjkChars, ...cjkBigrams].filter((token) => token.length > 0);
}

function trustBoostFor(chunk: WorkflowRagChunk): number {
  if (chunk.trustTier === "spec") return 0.12;
  if (chunk.trustTier === "current_task") return 0.08;
  if (chunk.trustTier === "historical_task") return 0.04;
  return 0;
}

function reasonFor(chunk: WorkflowRagChunk, matched: number, titleMatched: number): string {
  const bits = [`${matched} query token(s) matched`];
  if (titleMatched > 0) bits.push(`${titleMatched} in title/tags`);
  bits.push(`trust=${chunk.trustTier}`);
  return bits.join("; ");
}

function preview(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 16)).trimEnd()} ... [truncated]` : normalized;
}
