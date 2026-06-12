import type { ContextMode, DetailMode, WorkflowOmittedArtifact, WorkflowTokenBudget } from "../types.ts";

export const TOKEN_CHARS = 4;

export const NEXT_LITE_TARGET_TOKENS = 800;
export const NEXT_SUMMARY_TARGET_TOKENS = 2_000;
export const NEXT_DETAIL_TARGET_TOKENS = 3_500;
export const RUN_RESULT_TARGET_TOKENS = 1_200;

export interface ContextBudgetPolicy {
  targetTokens: number;
  maxRecommendedTokens: number;
  maxSummaryChars: number;
  includeDetails: boolean;
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.max(1, Math.ceil(text.length / TOKEN_CHARS));
}

export function estimateBytes(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Buffer.byteLength(text, "utf8");
}

export function contextBudgetPolicy(mode: ContextMode, detail: DetailMode = "summary"): ContextBudgetPolicy {
  if (mode === "none") return { targetTokens: 0, maxRecommendedTokens: 0, maxSummaryChars: 0, includeDetails: false };
  if (mode === "lite" || detail === "lite") {
    return { targetTokens: NEXT_LITE_TARGET_TOKENS, maxRecommendedTokens: NEXT_LITE_TARGET_TOKENS, maxSummaryChars: 1_600, includeDetails: false };
  }
  if (mode === "brief" || detail === "summary") {
    return { targetTokens: NEXT_SUMMARY_TARGET_TOKENS, maxRecommendedTokens: NEXT_SUMMARY_TARGET_TOKENS, maxSummaryChars: 3_200, includeDetails: mode !== "brief" };
  }
  return { targetTokens: NEXT_DETAIL_TARGET_TOKENS, maxRecommendedTokens: NEXT_DETAIL_TARGET_TOKENS, maxSummaryChars: 4_800, includeDetails: true };
}

export function truncateText(text: string, maxChars: number): { text: string; truncatedBytes: number } {
  if (maxChars <= 0 || text.length <= maxChars) return { text, truncatedBytes: 0 };
  const kept = text.slice(0, Math.max(0, maxChars - 16)).trimEnd();
  const truncated = text.slice(kept.length);
  return { text: `${kept}\n... [truncated]`, truncatedBytes: Buffer.byteLength(truncated, "utf8") };
}

export function tokenBudget(value: unknown, maxRecommendedTokens: number, options: { cacheHit?: boolean; truncatedBytes?: number; omitted?: WorkflowOmittedArtifact[] } = {}): WorkflowTokenBudget {
  return {
    estimatedInput: estimateTokens(value),
    maxRecommended: maxRecommendedTokens,
    cacheHit: options.cacheHit ?? false,
    truncatedBytes: options.truncatedBytes ?? 0,
    omittedRefs: (options.omitted ?? []).map((item) => item.ref),
  };
}

export function omitted(kind: string, ref: string, value: unknown, reason: string): WorkflowOmittedArtifact {
  return { kind, ref, bytes: estimateBytes(value), reason };
}
