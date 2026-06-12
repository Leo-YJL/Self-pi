import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { buildPrdKernelFromMarkdown, readPrdKernel } from "./prd.ts";
import { findActiveTask, readTask, type WorkflowTaskJson } from "./task.ts";
import type { RunMode, WorkflowBlocker, WorkflowWarning } from "../types.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";

export interface PrdFinalConfirmationInput {
  task?: string;
  mode?: RunMode;
  message?: string;
  confirmedBy?: string;
}

export interface PrdFinalConfirmationResult {
  ok: boolean;
  mode: RunMode;
  mutated: boolean;
  task?: string;
  prdPath?: string;
  beforeConfirmed?: boolean;
  afterConfirmed?: boolean;
  blockedBy: WorkflowBlocker[];
  warnings: WorkflowWarning[];
  summary: string;
  preview?: string;
}

export async function confirmPrdFinal(root: string, input: PrdFinalConfirmationInput = {}): Promise<PrdFinalConfirmationResult> {
  const mode = input.mode ?? "dry_run";
  const task = input.task ? await readTask(root, input.task) : await findActiveTask(root);
  if (!task) return blocked(mode, "missing_task", "No active workflow task found for PRD confirmation.");

  const prdPath = `.workflow/tasks/${task.id}/prd.md`;
  const absPath = resolveInsideRoot(root, prdPath);
  if (!existsSync(absPath)) return blocked(mode, "prd_missing", `${prdPath} is missing.`, task.id, prdPath);

  const before = await readPrdKernel(root, task, "compact");
  const markdown = await readFile(absPath, "utf8");
  const nextMarkdown = upsertFinalConfirmation(markdown, task, input.message, input.confirmedBy);
  const after = buildPrdKernelFromMarkdown(task, prdPath, nextMarkdown, "compact");
  const warnings: WorkflowWarning[] = [];
  if (task.status !== "planning" || task.stage !== "grill") {
    warnings.push({ code: "task_not_planning", message: `PRD confirmation is usually expected during planning/grill, got ${task.status}/${task.stage}.`, path: `.workflow/tasks/${task.id}/task.json` });
  }
  if (!after.finalConfirmation.confirmed) {
    return {
      ok: false,
      mode,
      mutated: false,
      task: task.id,
      prdPath,
      beforeConfirmed: before.finalConfirmation.confirmed,
      afterConfirmed: false,
      blockedBy: [{ code: "confirmation_not_detected", message: "The generated confirmation text was not recognized as confirmed by the PRD parser.", severity: "blocking", path: prdPath }],
      warnings,
      summary: "PRD final confirmation could not be generated.",
      preview: previewDiff(markdown, nextMarkdown),
    };
  }

  if (mode !== "execute") {
    return {
      ok: true,
      mode,
      mutated: false,
      task: task.id,
      prdPath,
      beforeConfirmed: before.finalConfirmation.confirmed,
      afterConfirmed: true,
      blockedBy: [],
      warnings,
      summary: before.finalConfirmation.confirmed ? "PRD final confirmation is already confirmed; dry-run would refresh confirmation evidence." : "Dry-run PRD final confirmation; execute to update PRD.",
      preview: previewDiff(markdown, nextMarkdown),
    };
  }

  await writeFile(absPath, ensureTrailingNewline(nextMarkdown), "utf8");
  return {
    ok: true,
    mode,
    mutated: markdown !== nextMarkdown,
    task: task.id,
    prdPath,
    beforeConfirmed: before.finalConfirmation.confirmed,
    afterConfirmed: true,
    blockedBy: [],
    warnings,
    summary: `PRD final confirmation recorded for ${task.id}.`,
  };
}

function blocked(mode: RunMode, code: string, message: string, task?: string, prdPath?: string): PrdFinalConfirmationResult {
  return { ok: false, mode, mutated: false, task, prdPath, blockedBy: [{ code, message, severity: "blocking", path: prdPath }], warnings: [], summary: message };
}

function upsertFinalConfirmation(markdown: string, task: WorkflowTaskJson, message?: string, confirmedBy = "user"): string {
  const body = confirmationBody(task, message, confirmedBy);
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+(.+?)\s*$/.test(line) && isFinalConfirmationHeading(line.replace(/^#{1,6}\s+/, "").trim()));

  if (headingIndex === -1) {
    const trimmed = markdown.replace(/\s+$/g, "");
    return `${trimmed}\n\n## Final Confirmation Before Implementation\n${body}\n`;
  }

  const heading = lines[headingIndex];
  const level = heading.match(/^#{1,6}/)?.[0].length ?? 2;
  let endIndex = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const match = /^(#{1,6})\s+/.exec(lines[i]);
    if (match && match[1].length <= level) {
      endIndex = i;
      break;
    }
  }
  const nextLines = [...lines.slice(0, headingIndex + 1), ...body.split(/\r?\n/), ...lines.slice(endIndex)];
  return ensureTrailingNewline(nextLines.join("\n"));
}

function confirmationBody(task: WorkflowTaskJson, message?: string, confirmedBy = "user"): string {
  const evidence = (message ?? "").trim() || `Confirmed to proceed with task ${task.id}.`;
  return `- Status: confirmed\n- Confirmed By: ${confirmedBy}\n- Confirmed At: ${new Date().toISOString()}\n- Evidence: ${evidence}`;
}

function isFinalConfirmationHeading(title: string): boolean {
  return /final confirmation/i.test(title) || /最终确认|实施前确认|确认.*实施/i.test(title);
}

function ensureTrailingNewline(text: string): string {
  return `${text.replace(/\s+$/g, "")}\n`;
}

function previewDiff(before: string, after: string): string {
  if (before === after) return "No PRD changes required.";
  const afterLines = after.split(/\r?\n/);
  const headingIndex = afterLines.findIndex((line) => /^#{1,6}\s+/.test(line) && isFinalConfirmationHeading(line.replace(/^#{1,6}\s+/, "").trim()));
  if (headingIndex === -1) return afterLines.slice(-8).join("\n");
  return afterLines.slice(headingIndex, Math.min(afterLines.length, headingIndex + 8)).join("\n");
}
