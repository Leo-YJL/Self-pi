import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, RESERVED_LABELS } from "./constants.ts";
import type { QuestionParams, ValidationResult } from "./types.ts";

export function validateQuestionnaire(params: QuestionParams): ValidationResult {
  if (!Array.isArray(params.questions) || params.questions.length === 0) {
    return { ok: false, error: "no_questions", message: "Error: At least one question is required" };
  }
  if (params.questions.length > MAX_QUESTIONS) {
    return { ok: false, error: "too_many_questions", message: `Error: At most ${MAX_QUESTIONS} questions are allowed` };
  }

  const seenQuestions = new Set<string>();
  const seenDecisionIds = new Set<string>();
  for (const q of params.questions) {
    const questionKey = q.question.trim().toLowerCase();
    if (seenQuestions.has(questionKey)) {
      return { ok: false, error: "duplicate_question", message: "Error: Question text must be unique" };
    }
    seenQuestions.add(questionKey);

    const decisionId = q.decisionId?.trim();
    if (decisionId) {
      const key = decisionId.toLowerCase();
      if (seenDecisionIds.has(key)) {
        return { ok: false, error: "duplicate_decision_id", message: "Error: decisionId must be unique within one call" };
      }
      seenDecisionIds.add(key);
    }

    if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS) {
      return { ok: false, error: "empty_options", message: `Error: Each question requires at least ${MIN_OPTIONS} options` };
    }
    if (q.options.length > MAX_OPTIONS) {
      return { ok: false, error: "empty_options", message: `Error: Each question allows at most ${MAX_OPTIONS} options` };
    }

    const recommendedCount = q.options.filter((option) => option.recommended).length;
    if (!q.multiSelect && recommendedCount > 1) {
      return {
        ok: false,
        error: "multiple_recommended_options",
        message: "Error: Single-select questions can have at most one recommended option",
      };
    }

    const seenLabels = new Set<string>();
    for (const option of q.options) {
      const labelKey = option.label.trim().toLowerCase();
      if (RESERVED_LABELS.has(labelKey)) {
        return {
          ok: false,
          error: "reserved_label",
          message: "Error: Option label is reserved. Do not author Other / Type something. / Chat about this / Next labels.",
        };
      }
      if (seenLabels.has(labelKey)) {
        return { ok: false, error: "duplicate_option_label", message: "Error: Option labels must be unique" };
      }
      seenLabels.add(labelKey);
    }
  }

  return { ok: true };
}
