import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { DialogAnswer, OptionData, QuestionAnswer, QuestionData, Row } from "./types.ts";

function makeRows(question: QuestionData, questionIndex: number, questionCount: number): Row[] {
  const rows: Row[] = question.options.map((option, optionIndex) => ({ kind: "option", option, optionIndex }));
  if (question.multiSelect) {
    rows.push({ kind: "done", label: questionIndex < questionCount - 1 ? "Next →" : "Submit" });
  } else {
    rows.push({ kind: "custom", label: "Type something." });
  }
  rows.push({ kind: "chat", label: "Chat about this" });
  return rows;
}

function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(10, width);
  const output: string[] = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine;
    if (line.length === 0) {
      output.push("");
      continue;
    }
    while (line.length > safeWidth) {
      output.push(line.slice(0, safeWidth));
      line = line.slice(safeWidth);
    }
    output.push(line);
  }
  return output;
}

function truncateStyled(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width));
}

function formatNotes(notes: Map<number, string>, selectedIndexes?: number[]): string | undefined {
  const pieces: string[] = [];
  for (const [optionIndex, note] of notes.entries()) {
    if (selectedIndexes && !selectedIndexes.includes(optionIndex)) continue;
    const trimmed = note.trim();
    if (trimmed) pieces.push(`option ${optionIndex + 1}: ${trimmed}`);
  }
  return pieces.length > 0 ? pieces.join("; ") : undefined;
}

function optionValue(option: OptionData): string {
  return option.value ?? option.label;
}

function recommendedIndexes(question: QuestionData): number[] {
  return question.options
    .map((option, index) => (option.recommended ? index : -1))
    .filter((index) => index >= 0);
}

function recommendedValue(question: QuestionData): string | undefined {
  const first = recommendedIndexes(question)[0];
  return first === undefined ? undefined : optionValue(question.options[first]);
}

function isExactRecommendedSelection(question: QuestionData, selectedIndexes: number[]): boolean {
  const recommended = recommendedIndexes(question).sort((a, b) => a - b);
  const selected = [...selectedIndexes].sort((a, b) => a - b);
  return recommended.length > 0 && recommended.length === selected.length && recommended.every((value, index) => value === selected[index]);
}

function enrichAnswer(question: QuestionData, questionIndex: number, answer: DialogAnswer): QuestionAnswer {
  const base = {
    questionIndex,
    question: question.question,
    decisionId: question.decisionId,
    severity: question.severity,
    persistTo: question.persistTo,
    recommendedValue: recommendedValue(question),
  } as Partial<QuestionAnswer>;

  if (answer.kind === "chat") {
    return { ...base, questionIndex, question: question.question, kind: "chat", answer: "Chat about this" } as QuestionAnswer;
  }
  if (answer.kind === "custom") {
    return { ...base, questionIndex, question: question.question, kind: "custom", answer: answer.answer, answerValue: answer.answer } as QuestionAnswer;
  }
  if (answer.kind === "multi") {
    const selectedOptions = answer.selectedIndexes.map((index) => question.options[index]).filter(Boolean);
    return {
      ...base,
      questionIndex,
      question: question.question,
      kind: "multi",
      answer: null,
      selected: answer.selected,
      selectedValues: selectedOptions.map(optionValue),
      acceptedRecommended: isExactRecommendedSelection(question, answer.selectedIndexes),
      notes: answer.notes,
    } as QuestionAnswer;
  }

  const option = question.options[answer.optionIndex];
  return {
    ...base,
    questionIndex,
    question: question.question,
    kind: "option",
    answer: answer.answer,
    answerValue: option ? optionValue(option) : answer.answer,
    acceptedRecommended: Boolean(option?.recommended),
    consequence: option?.consequence,
    notes: answer.notes,
    preview: answer.preview,
  } as QuestionAnswer;
}

export async function askOneQuestion(ctx: any, question: QuestionData, questionIndex: number, questionCount: number): Promise<QuestionAnswer | null> {
  const result = await ctx.ui.custom<DialogAnswer | null>(
    (tui: any, theme: any, _keybindings: any, done: (value: DialogAnswer | null) => void) => {
      let rowIndex = 0;
      let mode: "select" | "custom" | "note" = "select";
      let noteTarget: number | null = null;
      let detailsExpanded = true;
      let cachedLines: string[] | undefined;
      const selected = new Set<number>();
      const notes = new Map<number, string>();
      const rows = makeRows(question, questionIndex, questionCount);
      const recommended = recommendedIndexes(question);

      const editorTheme: EditorTheme = {
        borderColor: (s) => theme.fg("accent", s),
        selectList: {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        },
      };
      const editor = new Editor(tui, editorTheme);

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function currentRow(): Row {
        return rows[Math.max(0, Math.min(rowIndex, rows.length - 1))];
      }

      function selectedPreview(): string | undefined {
        const row = currentRow();
        if (row.kind !== "option") return undefined;
        const parts = [];
        if (row.option.consequence) parts.push(`Consequence: ${row.option.consequence}`);
        if (row.option.preview) parts.push(row.option.preview);
        return parts.length > 0 ? parts.join("\n\n") : undefined;
      }

      function commitMulti(indexes?: number[]) {
        const selectedIndexes = (indexes ?? Array.from(selected)).sort((a, b) => a - b);
        done({
          kind: "multi",
          selectedIndexes,
          selected: selectedIndexes.map((i) => question.options[i]?.label).filter(Boolean),
          notes: formatNotes(notes, selectedIndexes),
        });
      }

      function acceptRecommended() {
        if (recommended.length === 0) return;
        if (question.multiSelect) {
          commitMulti(recommended);
          return;
        }
        const optionIndex = recommended[0];
        const option = question.options[optionIndex];
        done({
          kind: "option",
          optionIndex,
          answer: option.label,
          notes: formatNotes(notes, [optionIndex]),
          preview: option.preview,
        });
      }

      editor.onSubmit = (value) => {
        const trimmed = value.trim();
        if (mode === "custom") {
          if (!trimmed) {
            mode = "select";
            editor.setText("");
            refresh();
            return;
          }
          done({ kind: "custom", answer: trimmed });
          return;
        }

        if (mode === "note" && noteTarget !== null) {
          if (trimmed) notes.set(noteTarget, trimmed);
          else notes.delete(noteTarget);
          mode = "select";
          noteTarget = null;
          editor.setText("");
          refresh();
        }
      };

      function openNote(optionIndex: number) {
        noteTarget = optionIndex;
        mode = "note";
        editor.setText(notes.get(optionIndex) ?? "");
        refresh();
      }

      function handleInput(data: string) {
        if (mode !== "select") {
          if (matchesKey(data, Key.escape)) {
            mode = "select";
            noteTarget = null;
            editor.setText("");
            refresh();
            return;
          }
          editor.handleInput(data);
          refresh();
          return;
        }

        if (matchesKey(data, Key.up)) {
          rowIndex = Math.max(0, rowIndex - 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.down)) {
          rowIndex = Math.min(rows.length - 1, rowIndex + 1);
          refresh();
          return;
        }

        const row = currentRow();

        if (data === "d" || data === "D") {
          detailsExpanded = !detailsExpanded;
          refresh();
          return;
        }

        if (data === "a" || data === "A") {
          acceptRecommended();
          return;
        }

        if ((data === "n" || data === "N") && row.kind === "option") {
          openNote(row.optionIndex);
          return;
        }

        if ((matchesKey(data, Key.space) || data === " ") && question.multiSelect && row.kind === "option") {
          if (selected.has(row.optionIndex)) selected.delete(row.optionIndex);
          else selected.add(row.optionIndex);
          refresh();
          return;
        }

        if (matchesKey(data, Key.enter)) {
          if (row.kind === "option") {
            if (question.multiSelect) {
              if (selected.has(row.optionIndex)) selected.delete(row.optionIndex);
              else selected.add(row.optionIndex);
              refresh();
              return;
            }
            done({
              kind: "option",
              optionIndex: row.optionIndex,
              answer: row.option.label,
              notes: formatNotes(notes, [row.optionIndex]),
              preview: row.option.preview,
            });
            return;
          }
          if (row.kind === "custom") {
            mode = "custom";
            editor.setText("");
            refresh();
            return;
          }
          if (row.kind === "chat") {
            done({ kind: "chat" });
            return;
          }
          if (row.kind === "done") {
            commitMulti();
            return;
          }
        }

        if (matchesKey(data, Key.escape)) {
          done(null);
        }
      }

      function addWrapped(lines: string[], label: string, text: string | undefined, width: number, color: string) {
        if (!text) return;
        lines.push(truncateStyled(theme.fg("muted", `${label}:`), width));
        for (const wrapped of wrapText(text, width - 2)) lines.push(truncateStyled(`  ${theme.fg(color, wrapped)}`, width));
      }

      function renderDecisionDetails(width: number): string[] {
        const hasDetails = Boolean(question.decisionId || question.severity || question.persistTo || question.context || question.ambiguity || question.recommendation || question.why);
        if (!hasDetails) return [];
        const lines: string[] = [];
        const meta = [
          question.decisionId ? `id=${question.decisionId}` : undefined,
          question.severity ? `severity=${question.severity}` : undefined,
          question.persistTo ? `persistTo=${question.persistTo}` : undefined,
        ].filter(Boolean).join(" • ");
        if (meta) lines.push(truncateStyled(theme.fg("dim", meta), width));
        lines.push(truncateStyled(theme.fg("dim", detailsExpanded ? "d collapse details" : "d expand details"), width));
        if (!detailsExpanded) return lines;
        addWrapped(lines, "Context", question.context, width, "text");
        addWrapped(lines, "Ambiguity", question.ambiguity, width, "warning");
        addWrapped(lines, "Recommended", question.recommendation, width, "success");
        addWrapped(lines, "Why", question.why, width, "muted");
        return lines;
      }

      function renderOptions(width: number): string[] {
        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateStyled(s, width));

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const focused = i === rowIndex;
          const prefix = focused ? theme.fg("accent", "> ") : "  ";

          if (row.kind === "option") {
            const checked = question.multiSelect ? (selected.has(row.optionIndex) ? "[x] " : "[ ] ") : "";
            const noteMark = notes.has(row.optionIndex) ? " 📝" : "";
            const recommendedMark = row.option.recommended ? theme.fg("success", " Recommended") : "";
            const label = `${row.optionIndex + 1}. ${checked}${row.option.label}${noteMark}${recommendedMark}`;
            add(prefix + theme.fg(focused ? "accent" : "text", label));
            for (const wrapped of wrapText(row.option.description, width - 6)) add(`     ${theme.fg("muted", wrapped)}`);
            if (row.option.consequence) {
              for (const wrapped of wrapText(`Consequence: ${row.option.consequence}`, width - 6)) add(`     ${theme.fg("dim", wrapped)}`);
            }
            continue;
          }

          const color = row.kind === "chat" ? "warning" : row.kind === "done" ? "success" : "accent";
          add(prefix + theme.fg(focused ? "accent" : color, row.label));
        }

        return lines;
      }

      function renderPreview(width: number): string[] {
        const preview = selectedPreview();
        if (!preview) return [];
        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateStyled(s, width));
        add(theme.fg("muted", "Preview"));
        add(theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
        for (const line of wrapText(preview, width)) add(theme.fg("text", line));
        return lines;
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateStyled(s, width));
        const border = theme.fg("accent", "─".repeat(Math.max(1, width)));

        add(border);
        add(`${theme.fg("toolTitle", theme.bold("ask_user_question"))} ${theme.fg("muted", `${questionIndex + 1}/${questionCount}`)} ${theme.fg("accent", `[${question.header}]`)}`);
        for (const wrapped of wrapText(question.question, width - 2)) add(` ${theme.fg("text", wrapped)}`);

        const detailLines = renderDecisionDetails(width - 2);
        if (detailLines.length > 0) {
          lines.push("");
          for (const detail of detailLines) add(` ${detail}`);
        }
        lines.push("");

        const preview = renderPreview(Math.max(20, Math.floor(width * 0.45)));
        const optionLines = renderOptions(preview.length > 0 && width >= 96 ? Math.floor(width * 0.52) : width);

        if (preview.length > 0 && width >= 96) {
          const leftWidth = Math.floor(width * 0.52);
          const rightWidth = width - leftWidth - 3;
          const count = Math.max(optionLines.length, preview.length);
          for (let i = 0; i < count; i++) {
            const left = truncateToWidth(optionLines[i] ?? "", leftWidth).padEnd(leftWidth);
            const right = truncateToWidth(preview[i] ?? "", rightWidth);
            lines.push(`${left} ${theme.fg("borderMuted", "│")} ${right}`);
          }
        } else {
          lines.push(...optionLines);
          if (preview.length > 0) {
            lines.push("");
            lines.push(...renderPreview(width));
          }
        }

        if (mode === "custom") {
          lines.push("");
          add(theme.fg("muted", "Your answer:"));
          for (const line of editor.render(width - 2)) add(` ${line}`);
        }

        if (mode === "note") {
          lines.push("");
          const label = noteTarget !== null ? question.options[noteTarget]?.label : "option";
          add(theme.fg("muted", `Note for ${label}:`));
          for (const line of editor.render(width - 2)) add(` ${line}`);
        }

        lines.push("");
        if (mode === "select") {
          const accept = recommended.length > 0 ? " • a accept recommended" : "";
          const help = question.multiSelect
            ? `↑↓ move • Space/Enter toggle • n note${accept} • d details • Next/Submit row • Esc cancel`
            : `↑↓ move • Enter choose • n note${accept} • d details • Type something • Esc cancel`;
          add(theme.fg("dim", help));
        } else {
          add(theme.fg("dim", "Enter submit • Esc back"));
        }
        add(border);

        cachedLines = lines;
        return lines;
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput,
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "100%",
        maxHeight: "100%",
        margin: { left: 0, right: 0, bottom: 0 },
      },
    },
  );

  return result ? enrichAnswer(question, questionIndex, result) : null;
}
