import { estimateTokens } from "./contextBudget.ts";

export interface WorkflowCompactionInput {
  branchEntries?: unknown[];
  preparation?: {
    previousSummary?: string;
    messagesToSummarize?: unknown[];
    turnPrefixMessages?: unknown[];
    fileOps?: { readFiles?: string[]; modifiedFiles?: string[] };
    firstKeptEntryId?: string;
    tokensBefore?: number;
  };
}

export interface WorkflowCompactionSummary {
  summary: string;
  details: {
    kind: "pi-coding-workflow.compaction";
    activeTask?: string;
    status?: string;
    stage?: string;
    nextAction?: string;
    readFiles: string[];
    modifiedFiles: string[];
    workflowEntryCount: number;
    estimatedTokens: number;
  };
}

export function buildWorkflowCompactionSummary(input: WorkflowCompactionInput): WorkflowCompactionSummary | null {
  const workflowEntries = collectWorkflowEntries(input.branchEntries ?? []);
  const latest = workflowEntries.at(-1);
  if (!latest) return null;

  const data = latest.data;
  const readFiles = uniqueStrings(input.preparation?.fileOps?.readFiles ?? []).slice(0, 20);
  const modifiedFiles = uniqueStrings(input.preparation?.fileOps?.modifiedFiles ?? []).slice(0, 20);
  const recentConversation = extractRecentConversation([
    ...(input.preparation?.messagesToSummarize ?? []),
    ...(input.preparation?.turnPrefixMessages ?? []),
  ]);
  const previousSignal = previousWorkflowSignal(input.preparation?.previousSummary);
  const artifactRefs = uniqueStrings([...(data.artifactRefs ?? []), ...(data.omittedRefs ?? [])]).slice(0, 8);

  const lines = [
    "## Workflow State",
    `- activeTask: ${data.task ?? "none"}`,
    `- status/stage: ${data.status ?? "unknown"}/${data.stage ?? "unknown"}`,
    data.flowLevel ? `- flowLevel: ${data.flowLevel}` : undefined,
    `- nextAction: ${data.nextAction ?? data.nextRecommendedCall?.arguments?.action ?? "unknown"}`,
    data.action ? `- lastWorkflowRun: ${data.action}${data.mode ? ` (${data.mode})` : ""}` : undefined,
    typeof data.meta?.cacheHit === "boolean" ? `- workflowCacheHit: ${data.meta.cacheHit}` : undefined,
    data.meta?.estimatedTokens ? `- lastEstimatedTokens: ${data.meta.estimatedTokens}` : undefined,
    artifactRefs.length > 0 ? `- artifactRefs: ${artifactRefs.join(", ")}` : undefined,
    "",
    "## Progress",
    previousSignal || "No previous compaction summary was available.",
    recentConversation.length > 0 ? "" : undefined,
    recentConversation.length > 0 ? "Recent non-tool conversation signals:" : undefined,
    ...recentConversation.map((item) => `- ${item}`),
    "",
    "## Files",
    "<read-files>",
    ...(readFiles.length > 0 ? readFiles : ["(none recorded)"]),
    "</read-files>",
    "",
    "<modified-files>",
    ...(modifiedFiles.length > 0 ? modifiedFiles : ["(none recorded)"]),
    "</modified-files>",
    "",
    "## Next Steps",
    `1. Resume with workflow_next${data.task ? ` for task ${data.task}` : ""} using includeContext=lite.`,
    "2. Request task/check/finish context only if evidenceRefs are insufficient.",
    "3. Use workflow_run batch for deterministic follow-up actions when possible.",
  ].filter((line): line is string => typeof line === "string");

  const summary = trimMultiline(lines.join("\n"), 3_200);
  return {
    summary,
    details: {
      kind: "pi-coding-workflow.compaction",
      activeTask: data.task,
      status: data.status,
      stage: data.stage,
      nextAction: data.nextAction,
      readFiles,
      modifiedFiles,
      workflowEntryCount: workflowEntries.length,
      estimatedTokens: estimateTokens(summary),
    },
  };
}

function collectWorkflowEntries(entries: unknown[]): Array<{ data: any }> {
  const result: Array<{ data: any }> = [];
  for (const entry of entries as any[]) {
    if (entry?.type !== "custom") continue;
    if (entry?.customType !== "pi-coding-workflow") continue;
    const data = entry.data ?? entry.details ?? {};
    if (!data || typeof data !== "object") continue;
    result.push({ data });
  }
  return result;
}

function previousWorkflowSignal(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) return "";
  const head = text.split(/Previous compaction summary excerpt:/i)[0];
  const task = /- activeTask:\s*([^\n]+)/.exec(head)?.[1]?.trim();
  const statusStage = /- status\/stage:\s*([^\n]+)/.exec(head)?.[1]?.trim();
  const nextAction = /- nextAction:\s*([^\n]+)/.exec(head)?.[1]?.trim();
  const parts = [task ? `activeTask=${task}` : undefined, statusStage ? `status/stage=${statusStage}` : undefined, nextAction ? `nextAction=${nextAction}` : undefined].filter(Boolean);
  if (parts.length === 0) return "Previous workflow summary existed but was intentionally compacted to avoid recursive summary growth.";
  return `Previous workflow checkpoint: ${parts.join("; ")}.`;
}

function extractRecentConversation(messages: unknown[]): string[] {
  const result: string[] = [];
  for (const message of messages as any[]) {
    const role = message?.role ?? message?.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = trimBlock(extractText(message?.content ?? message?.message?.content), 180);
    if (!text) continue;
    result.push(`${role}: ${text}`);
  }
  return result.slice(-5);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === "string" ? item : item?.type === "text" && typeof item.text === "string" ? item.text : "")
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function trimBlock(text: unknown, maxChars: number): string {
  if (typeof text !== "string") return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 16)).trimEnd()} ...[truncated]`;
}

function trimMultiline(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n...[compaction summary truncated]`;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}
