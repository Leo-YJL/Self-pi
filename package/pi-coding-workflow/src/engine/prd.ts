import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { WorkflowBlocker, WorkflowGrillDecision, WorkflowStage } from "../types.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";
import type { WorkflowTaskJson } from "./task.ts";

export type PrdViewMode = "compact" | "brief" | "full";
export type PrdSectionKey =
  | "executionContract"
  | "goal"
  | "requirements"
  | "acceptanceCriteria"
  | "validationPlan"
  | "openQuestions"
  | "finalConfirmation"
  | "outOfScope"
  | "definitionOfDone"
  | "grillResult"
  | "architectureImpact";

export interface PrdChecklistItem {
  line: number;
  raw: string;
  text: string;
  checked: boolean;
  isNA: boolean;
  hasLimitation: boolean;
}

export interface PrdChecklistSummary {
  total: number;
  checked: number;
  unchecked: number;
  items: PrdChecklistItem[];
  uncheckedItems: PrdChecklistItem[];
}

export interface PrdSection {
  key: PrdSectionKey;
  title: string;
  found: boolean;
  lineStart?: number;
  body: string;
  checklist: PrdChecklistSummary;
}

export interface PrdKernel {
  mode: PrdViewMode;
  title: string;
  task: { id: string; status: string; stage: WorkflowStage; flowLevel: string };
  source: { path: string; exists: boolean; hash?: string; confirmationHash?: string; mtime?: string; bytes?: number };
  executionContract: { fields: Record<string, string>; raw: string };
  goal: string;
  requirements: string;
  acceptanceCriteria: string;
  validationPlan: string;
  openQuestions: { found: boolean; blocking: boolean; items: string[]; summary: string };
  finalConfirmation: { confirmed: boolean; evidence?: string; found: boolean; confirmedPrdHash?: string };
  outOfScope: string;
  definitionOfDone: string;
  sections: Record<PrdSectionKey, PrdSection>;
  decisions: { presentDecisionIds: string[]; missingDecisionIds: string[] };
  quality: {
    hasTodo: boolean;
    todoLines: Array<{ line: number; text: string }>;
    uncheckedChecklistCount: number;
    uncheckedChecklistLines: Array<{ line: number; text: string }>;
    blockingOpenQuestions: boolean;
  };
  warnings: string[];
  summary: string;
}

export interface PrdChecklistGateResult {
  key: PrdSectionKey;
  label: string;
  passed: boolean;
  code: string;
  message: string;
  path: string;
  missing: boolean;
  uncheckedItems: PrdChecklistItem[];
}

interface Heading {
  level: number;
  title: string;
  lineIndex: number;
}

const SECTION_MATCHERS: Record<PrdSectionKey, RegExp[]> = {
  executionContract: [/^execution contract$/i, /执行契约/i],
  goal: [/^goal$/i, /^goals$/i, /目标/i],
  requirements: [/^requirements?$/i, /需求|要求/i],
  acceptanceCriteria: [/acceptance criteria/i, /验收/i],
  validationPlan: [/validation plan/i, /验证计划|验证/i],
  openQuestions: [/open questions?/i, /开放问题|待解决问题|阻塞问题/i],
  finalConfirmation: [/final confirmation/i, /最终确认|实施前确认|确认.*实施/i],
  outOfScope: [/out of scope/i, /范围外|不在范围/i],
  definitionOfDone: [/definition of done/i, /^dod$/i, /完成定义/i],
  grillResult: [/grill result/i, /grill.*结果/i],
  architectureImpact: [/architecture impact/i, /架构影响/i],
};

const SECTION_LABELS: Record<PrdSectionKey, string> = {
  executionContract: "Execution Contract",
  goal: "Goal",
  requirements: "Requirements",
  acceptanceCriteria: "Acceptance Criteria",
  validationPlan: "Validation Plan",
  openQuestions: "Open Questions",
  finalConfirmation: "Final Confirmation",
  outOfScope: "Out of Scope",
  definitionOfDone: "Definition of Done",
  grillResult: "Grill Result",
  architectureImpact: "Architecture Impact",
};

export async function readPrdKernel(root: string, task: WorkflowTaskJson, mode: PrdViewMode = "brief"): Promise<PrdKernel> {
  const relPath = `.workflow/tasks/${task.id}/prd.md`;
  const absPath = resolveInsideRoot(root, relPath);
  if (!existsSync(absPath)) {
    return emptyPrdKernel(task, relPath, mode, "PRD is missing.");
  }

  const markdown = await readFile(absPath, "utf8");
  const fileStat = await stat(absPath);
  const parsed = buildPrdKernelFromMarkdown(task, relPath, markdown, mode, {
    hash: createHash("sha256").update(markdown).digest("hex").slice(0, 16),
    mtime: fileStat.mtime.toISOString(),
    bytes: fileStat.size,
  });
  return parsed;
}

export function buildPrdKernelFromMarkdown(
  task: WorkflowTaskJson,
  relPath: string,
  markdown: string,
  mode: PrdViewMode = "brief",
  sourceMeta: { hash?: string; mtime?: string; bytes?: number } = {},
): PrdKernel {
  const lines = markdown.split(/\r?\n/);
  const headings = collectHeadings(lines);
  const title = extractTitle(lines, task.title || task.id);
  const sections = Object.fromEntries(
    (Object.keys(SECTION_MATCHERS) as PrdSectionKey[]).map((key) => [key, extractSection(key, lines, headings, mode)]),
  ) as Record<PrdSectionKey, PrdSection>;
  const executionFields = parseExecutionFields(sections.executionContract.body);
  const todoLines = collectTodoLines(lines);
  const uncheckedChecklistLines = collectUncheckedChecklistLines(lines);
  const openQuestions = analyzeOpenQuestions(sections.openQuestions);
  const finalConfirmation = analyzeFinalConfirmation(sections, executionFields, markdown);
  const warnings: string[] = [];
  if (todoLines.length > 0) warnings.push("PRD contains TODO/TBD markers.");
  if (openQuestions.blocking) warnings.push("PRD contains blocking open questions.");
  if (!finalConfirmation.confirmed) warnings.push("PRD final confirmation is missing or not confirmed.");

  const summaryParts = [
    `PRD ${title}`,
    `flow=${task.flowLevel}`,
    `stage=${task.stage}`,
    sourceMeta.hash ? `hash=${sourceMeta.hash}` : "hash=unknown",
  ];
  if (todoLines.length > 0) summaryParts.push(`todo=${todoLines.length}`);
  if (openQuestions.blocking) summaryParts.push(`openQuestions=${openQuestions.items.length}`);
  if (!finalConfirmation.confirmed) summaryParts.push("finalConfirmation=missing");

  return {
    mode,
    title,
    task: { id: task.id, status: task.status, stage: task.stage, flowLevel: task.flowLevel },
    source: { path: relPath, exists: true, confirmationHash: prdConfirmationHash(markdown), ...sourceMeta },
    executionContract: { fields: executionFields, raw: sections.executionContract.body },
    goal: sections.goal.body,
    requirements: sections.requirements.body,
    acceptanceCriteria: sections.acceptanceCriteria.body,
    validationPlan: sections.validationPlan.body,
    openQuestions,
    finalConfirmation,
    outOfScope: sections.outOfScope.body,
    definitionOfDone: sections.definitionOfDone.body,
    sections,
    decisions: analyzePrdDecisionCoverage(task, markdown),
    quality: {
      hasTodo: todoLines.length > 0,
      todoLines: todoLines.slice(0, 20),
      uncheckedChecklistCount: uncheckedChecklistLines.length,
      uncheckedChecklistLines: uncheckedChecklistLines.slice(0, 20),
      blockingOpenQuestions: openQuestions.blocking,
    },
    warnings,
    summary: summaryParts.join("; "),
  };
}

export function evaluatePrdChecklistGate(
  kernel: PrdKernel,
  key: PrdSectionKey,
  options: { allowNA?: boolean; allowLimitation?: boolean; requireChecklist?: boolean } = {},
): PrdChecklistGateResult {
  const section = kernel.sections[key];
  const label = SECTION_LABELS[key];
  const path = kernel.source.path;
  const missingCode = `prd_${keyToCode(key)}_missing`;
  const uncheckedCode = `prd_${keyToCode(key)}_unchecked`;
  const noChecklistCode = `prd_${keyToCode(key)}_no_checklist`;

  if (!section?.found || !section.body.trim()) {
    return {
      key,
      label,
      passed: false,
      code: missingCode,
      message: `${label} section is missing or empty in PRD.`,
      path,
      missing: true,
      uncheckedItems: [],
    };
  }

  if (section.checklist.total === 0) {
    const text = stripMarkdown(section.body);
    const canAcceptTextOnly = !options.requireChecklist && text.length > 0;
    const explicitNA = isNeutralLine(text) || hasLimitation(text);
    if (canAcceptTextOnly || explicitNA) {
      return { key, label, passed: true, code: "ok", message: `${label} has text-only completion evidence.`, path, missing: false, uncheckedItems: [] };
    }
    return {
      key,
      label,
      passed: false,
      code: noChecklistCode,
      message: `${label} should use a checklist or explicit N/A/limitation evidence for finish preflight.`,
      path,
      missing: false,
      uncheckedItems: [],
    };
  }

  const failing = section.checklist.uncheckedItems.filter((item) => {
    if (options.allowNA && item.isNA) return false;
    if (options.allowLimitation && item.hasLimitation) return false;
    return true;
  });
  if (failing.length > 0) {
    return {
      key,
      label,
      passed: false,
      code: uncheckedCode,
      message: `${label} has unchecked items: ${failing.map((item) => item.text).slice(0, 3).join("; ")}`,
      path,
      missing: false,
      uncheckedItems: failing,
    };
  }

  return { key, label, passed: true, code: "ok", message: `${label} checklist is complete.`, path, missing: false, uncheckedItems: [] };
}

export function prdGateToBlocker(gate: PrdChecklistGateResult): WorkflowBlocker | null {
  if (gate.passed) return null;
  return { code: gate.code, message: gate.message, severity: "blocking", path: gate.path };
}

export interface AppendPrdDecisionLogResult {
  markdown: string;
  changed: boolean;
  appendedDecisionIds: string[];
  alreadyPresentDecisionIds: string[];
  preview: string;
}

export type PrdUpdateMode = "replace" | "append";

export interface UpdatePrdSectionResult {
  markdown: string;
  changed: boolean;
  section: PrdSectionKey;
  mode: PrdUpdateMode;
  existed: boolean;
  preview: string;
}

export function prdConfirmationHash(markdown: string): string {
  return createHash("sha256").update(`${stripFinalConfirmationSection(markdown).trim()}\n`).digest("hex").slice(0, 16);
}

export function updatePrdSection(markdown: string, section: PrdSectionKey, content: string, mode: PrdUpdateMode = "replace"): UpdatePrdSectionResult {
  const body = content.trim();
  const lines = markdown.replace(/\s+$/g, "").split(/\r?\n/);
  const headings = collectHeadings(lines);
  const heading = headings.find((candidate) => SECTION_MATCHERS[section].some((matcher) => matcher.test(candidate.title.trim())));
  const label = SECTION_LABELS[section];
  let nextLines: string[];
  let existed = false;

  if (heading) {
    existed = true;
    const nextHeading = headings.find((candidate) => candidate.lineIndex > heading.lineIndex && candidate.level <= heading.level);
    const endLine = nextHeading ? nextHeading.lineIndex : lines.length;
    const currentBody = lines.slice(heading.lineIndex + 1, endLine).join("\n").trim();
    const nextBody = mode === "append" && currentBody ? `${currentBody}\n\n${body}` : body;
    nextLines = [...lines.slice(0, heading.lineIndex + 1), "", ...nextBody.split(/\r?\n/), "", ...lines.slice(endLine)];
  } else {
    const finalHeading = headings.find((candidate) => SECTION_MATCHERS.finalConfirmation.some((matcher) => matcher.test(candidate.title.trim())));
    const insertAt = section === "finalConfirmation" ? lines.length : finalHeading?.lineIndex ?? lines.length;
    nextLines = [...lines.slice(0, insertAt), `## ${label}`, "", ...body.split(/\r?\n/), "", ...lines.slice(insertAt)];
  }

  const nextMarkdown = `${nextLines.join("\n").replace(/\s+$/g, "")}\n`;
  return {
    markdown: nextMarkdown,
    changed: nextMarkdown !== `${markdown.replace(/\s+$/g, "")}\n`,
    section,
    mode,
    existed,
    preview: [`## ${label}`, "", ...body.split(/\r?\n/).slice(0, 12)].join("\n"),
  };
}

export function appendPrdDecisionLog(markdown: string, decisions: WorkflowGrillDecision[]): AppendPrdDecisionLogResult {
  const eligible = decisions.filter((decision) =>
    decision.status === "answered"
    && (decision.persistTo ?? "prd") === "prd"
    && !isFinalConfirmationDecisionId(decision.id)
  );
  const alreadyPresentDecisionIds = eligible.filter((decision) => markdown.includes(decision.id)).map((decision) => decision.id);
  const missing = eligible.filter((decision) => !alreadyPresentDecisionIds.includes(decision.id));
  if (missing.length === 0) {
    return { markdown, changed: false, appendedDecisionIds: [], alreadyPresentDecisionIds, preview: "No missing PRD grill decisions." };
  }

  const rows = missing.map((decision) => `| ${escapeTableCell(decision.roundId ?? "")} | ${escapeTableCell(decision.roundKind ?? "custom")} | \`${escapeTableCell(decision.id)}\` | ${escapeTableCell(decision.severity)} | ${escapeTableCell(decision.summary)} |`);
  const table = ["| Round | Kind | Decision ID | Severity | Summary |", "|---|---|---|---|---|", ...rows].join("\n");
  const lines = markdown.replace(/\s+$/g, "").split(/\r?\n/);
  const headings = collectHeadings(lines);
  const existing = headings.find((heading) => /^(grill decision log|decisions?)$/i.test(heading.title.trim()) || /grill.*decision/i.test(heading.title));
  let nextMarkdown: string;

  if (existing) {
    const nextHeading = headings.find((candidate) => candidate.lineIndex > existing.lineIndex && candidate.level <= existing.level);
    const endLine = nextHeading ? nextHeading.lineIndex : lines.length;
    const body = lines.slice(existing.lineIndex + 1, endLine).join("\n");
    const insertion = /Decision\s+ID/i.test(body) ? rows.join("\n") : table;
    nextMarkdown = [...lines.slice(0, endLine), "", insertion, ...lines.slice(endLine)].join("\n");
  } else {
    const finalHeading = headings.find((heading) => SECTION_MATCHERS.finalConfirmation.some((matcher) => matcher.test(heading.title.trim())));
    const insertAt = finalHeading?.lineIndex ?? lines.length;
    const section = ["## Grill Decision Log", "", table, ""];
    nextMarkdown = [...lines.slice(0, insertAt), ...section, ...lines.slice(insertAt)].join("\n");
  }

  return {
    markdown: `${nextMarkdown.replace(/\s+$/g, "")}\n`,
    changed: true,
    appendedDecisionIds: missing.map((decision) => decision.id),
    alreadyPresentDecisionIds,
    preview: rows.join("\n"),
  };
}

function stripFinalConfirmationSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const headings = collectHeadings(lines);
  const heading = headings.find((candidate) => SECTION_MATCHERS.finalConfirmation.some((matcher) => matcher.test(candidate.title.trim())));
  if (!heading) return markdown;
  const nextHeading = headings.find((candidate) => candidate.lineIndex > heading.lineIndex && candidate.level <= heading.level);
  const endLine = nextHeading ? nextHeading.lineIndex : lines.length;
  return [...lines.slice(0, heading.lineIndex), ...lines.slice(endLine)].join("\n");
}

function emptyPrdKernel(task: WorkflowTaskJson, relPath: string, mode: PrdViewMode, summary: string): PrdKernel {
  const sections = Object.fromEntries(
    (Object.keys(SECTION_MATCHERS) as PrdSectionKey[]).map((key) => [key, emptySection(key)]),
  ) as Record<PrdSectionKey, PrdSection>;
  return {
    mode,
    title: task.title || task.id,
    task: { id: task.id, status: task.status, stage: task.stage, flowLevel: task.flowLevel },
    source: { path: relPath, exists: false },
    executionContract: { fields: {}, raw: "" },
    goal: "",
    requirements: "",
    acceptanceCriteria: "",
    validationPlan: "",
    openQuestions: { found: false, blocking: false, items: [], summary: "Open Questions section missing." },
    finalConfirmation: { confirmed: false, found: false },
    outOfScope: "",
    definitionOfDone: "",
    sections,
    decisions: { presentDecisionIds: [], missingDecisionIds: [] },
    quality: { hasTodo: false, todoLines: [], uncheckedChecklistCount: 0, uncheckedChecklistLines: [], blockingOpenQuestions: false },
    warnings: [summary],
    summary,
  };
}

function emptySection(key: PrdSectionKey): PrdSection {
  return { key, title: SECTION_LABELS[key], found: false, body: "", checklist: { total: 0, checked: 0, unchecked: 0, items: [], uncheckedItems: [] } };
}

function collectHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  lines.forEach((line, lineIndex) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) headings.push({ level: match[1].length, title: match[2].replace(/\s+#+\s*$/, "").trim(), lineIndex });
  });
  return headings;
}

function extractTitle(lines: string[], fallback: string): string {
  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1) return h1[1].replace(/\s+#+\s*$/, "").trim();
  }
  const firstText = lines.map(stripMarkdown).find((line) => line.length > 0);
  return firstText ?? fallback;
}

function extractSection(key: PrdSectionKey, lines: string[], headings: Heading[], mode: PrdViewMode): PrdSection {
  const heading = headings.find((candidate) => SECTION_MATCHERS[key].some((matcher) => matcher.test(candidate.title.trim())));
  if (!heading) return emptySection(key);

  const nextHeading = headings.find((candidate) => candidate.lineIndex > heading.lineIndex && candidate.level <= heading.level);
  const startLine = heading.lineIndex + 1;
  const endLine = nextHeading ? nextHeading.lineIndex : lines.length;
  const fullBody = lines.slice(startLine, endLine).join("\n").trim();
  const body = trimForMode(fullBody, mode);
  return {
    key,
    title: heading.title,
    found: true,
    lineStart: heading.lineIndex + 1,
    body,
    checklist: parseChecklist(fullBody, startLine + 1),
  };
}

function trimForMode(text: string, mode: PrdViewMode): string {
  const normalized = text.trim();
  if (mode === "full") return normalized;
  const limit = mode === "compact" ? 900 : 2200;
  return normalized.length > limit ? `${normalized.slice(0, limit).trimEnd()}\n...` : normalized;
}

function parseExecutionFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?([^:：\n]{2,80})[:：]\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1].trim().replace(/`/g, "");
    fields[key] = match[2].trim();
  }
  return fields;
}

function collectTodoLines(lines: string[]): Array<{ line: number; text: string }> {
  const todo = /\bTODO\b|TODO\(|\bTBD\b|待定|待补充|未定/i;
  const result: Array<{ line: number; text: string }> = [];
  lines.forEach((line, index) => {
    if (todo.test(line)) result.push({ line: index + 1, text: line.trim() });
  });
  return result;
}

function collectUncheckedChecklistLines(lines: string[]): Array<{ line: number; text: string }> {
  const result: Array<{ line: number; text: string }> = [];
  lines.forEach((line, index) => {
    if (/^\s*[-*]\s+\[\s\]/.test(line)) result.push({ line: index + 1, text: line.trim() });
  });
  return result;
}

function parseChecklist(body: string, startLineNumber: number): PrdChecklistSummary {
  const items: PrdChecklistItem[] = [];
  body.split(/\r?\n/).forEach((line, offset) => {
    const match = /^\s*[-*]\s+\[([ xX])\]\s*(.+?)\s*$/.exec(line);
    if (!match) return;
    const text = match[2].trim();
    items.push({
      line: startLineNumber + offset,
      raw: line,
      text,
      checked: match[1].toLowerCase() === "x",
      isNA: isNeutralLine(text),
      hasLimitation: hasLimitation(text),
    });
  });
  const checked = items.filter((item) => item.checked).length;
  const uncheckedItems = items.filter((item) => !item.checked);
  return { total: items.length, checked, unchecked: uncheckedItems.length, items, uncheckedItems };
}

function analyzeOpenQuestions(section: PrdSection): PrdKernel["openQuestions"] {
  if (!section.found) return { found: false, blocking: false, items: [], summary: "Open Questions section missing." };
  const meaningful = section.body
    .split(/\r?\n/)
    .map(stripMarkdown)
    .filter(Boolean)
    .filter((line) => !isNeutralLine(line))
    .filter((line) => !/^status\s*[:：]\s*(confirmed|done|closed|resolved|已确认|已解决)$/i.test(line));
  const blocking = meaningful.length > 0;
  return {
    found: true,
    blocking,
    items: meaningful.slice(0, 20),
    summary: blocking ? meaningful.slice(0, 3).join("; ") : "No blocking open questions.",
  };
}

function isFinalConfirmationDecisionId(id: string): boolean {
  return /(?:stage1[-_.])?final[-_.]?confirm|final[-_.]?confirmation|prd[-_.]?confirm/i.test(id);
}

function escapeTableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function analyzePrdDecisionCoverage(task: WorkflowTaskJson, markdown: string): PrdKernel["decisions"] {
  const decisions = task.grill?.decisions ?? [];
  const requiredIds = decisions
    .filter((decision) => decision.status === "answered" && (decision.persistTo ?? "prd") === "prd")
    .map((decision) => decision.id);
  const presentDecisionIds = requiredIds.filter((id) => markdown.includes(id));
  return {
    presentDecisionIds,
    missingDecisionIds: requiredIds.filter((id) => !presentDecisionIds.includes(id)),
  };
}

function analyzeFinalConfirmation(
  sections: Record<PrdSectionKey, PrdSection>,
  executionFields: Record<string, string>,
  markdown: string,
): PrdKernel["finalConfirmation"] {
  const candidates: Array<{ label: string; text: string }> = [];
  const finalSection = sections.finalConfirmation;
  if (finalSection.found) candidates.push({ label: finalSection.title, text: finalSection.body });
  for (const [key, value] of Object.entries(executionFields)) {
    if (/final confirmation|最终确认|确认/i.test(key)) candidates.push({ label: key, text: value });
  }

  // Legacy PRDs sometimes keep the confirmation under a combined review gate.
  const reviewMatch = /##\s+PRD Grill Review[\s\S]*?(?=\n##\s+|$)/i.exec(markdown);
  if (reviewMatch) candidates.push({ label: "PRD Grill Review", text: reviewMatch[0] });

  for (const candidate of candidates) {
    const text = stripMarkdown(candidate.text);
    if (!text) continue;
    const confirmedPrdHash = extractConfirmedPrdHash(candidate.text);
    if (isConfirmedText(text)) return { confirmed: true, evidence: `${candidate.label}: ${text.slice(0, 240)}`, found: true, confirmedPrdHash };
    return { confirmed: false, evidence: `${candidate.label}: ${text.slice(0, 240)}`, found: true, confirmedPrdHash };
  }
  return { confirmed: false, found: false };
}

function extractConfirmedPrdHash(text: string): string | undefined {
  return /Confirmed\s+PRD\s+Hash\s*[:：]\s*([a-f0-9]{12,64})/i.exec(text)?.[1];
}

function isConfirmedText(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\b(unconfirmed|not confirmed|pending|todo|tbd)\b/.test(lower) || /未确认|待确认|待定/.test(text)) return false;
  return /\bconfirmed\b|\bproceed\b|\bapproved\b|已确认|确认|用户选择|继续实施|可以开始/.test(lower) || /已确认|确认|用户选择|继续实施|可以开始/.test(text);
}

function stripMarkdown(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\[[ xX]\]\s*/, "")
    .replace(/[`*_>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNeutralLine(text: string): boolean {
  const normalized = stripMarkdown(text).replace(/[.。；;!！\s]+$/g, "").toLowerCase();
  if (!normalized) return true;
  if (/^(none|no blockers?|no blocking questions?|n\/a|not applicable|na)$/.test(normalized)) return true;
  if (/^(无|无阻塞|暂无|没有|不适用|无需|无阻塞问题)$/.test(normalized)) return true;
  if (/无阻塞|暂无阻塞|no blocking/.test(normalized)) return true;
  return false;
}

function hasLimitation(text: string): boolean {
  return /limitation|limited|限制|局限|无法验证|未执行|用户未提供|记录限制|可接受风险/i.test(text);
}

function keyToCode(key: PrdSectionKey): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
