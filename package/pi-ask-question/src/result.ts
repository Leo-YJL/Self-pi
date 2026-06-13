import { CHAT_CONTINUATION_MESSAGE, DECLINE_MESSAGE } from "./constants.ts";
import type { QuestionAnswer, QuestionParams, QuestionnaireResult } from "./types.ts";

export function buildToolResult(text: string, details: QuestionnaireResult) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function formatAnswerScalar(answer: QuestionAnswer): string {
  switch (answer.kind) {
    case "chat":
      return CHAT_CONTINUATION_MESSAGE;
    case "multi":
      return answer.selected && answer.selected.length > 0 ? answer.selected.join(", ") : "(no input)";
    case "custom":
      return answer.answer && answer.answer.length > 0 ? answer.answer : "(no input)";
    case "option":
      return answer.answer ?? "(no input)";
  }
}

function buildAnswerSegment(answer: QuestionAnswer): string {
  const id = answer.decisionId ? `[${answer.decisionId}] ` : "";
  const parts = [`${id}"${answer.question}"="${formatAnswerScalar(answer)}"`];
  if (answer.answerValue) parts.push(`value: ${answer.answerValue}`);
  if (answer.selectedValues && answer.selectedValues.length > 0) parts.push(`values: ${answer.selectedValues.join(", ")}`);
  if (answer.acceptedRecommended) parts.push("accepted recommended answer");
  if (answer.persistTo) parts.push(`persistTo: ${answer.persistTo}`);
  if (answer.consequence) parts.push(`consequence: ${answer.consequence}`);
  if (answer.preview) parts.push(`selected preview: ${answer.preview}`);
  if (answer.notes) parts.push(`user notes: ${answer.notes}`);
  return `${parts.join(". ")}.`;
}

export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
  if (!result || result.cancelled) {
    return buildToolResult(DECLINE_MESSAGE, { answers: result?.answers ?? [], cancelled: true });
  }

  const segments: string[] = [];
  for (let i = 0; i < params.questions.length; i++) {
    const answer = result.answers.find((x) => x.questionIndex === i);
    if (answer) segments.push(buildAnswerSegment(answer));
  }

  if (segments.length === 0) {
    return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
  }

  return buildToolResult(
    `User has answered your questions: ${segments.join(" ")} You can now continue with the user's answers in mind.`,
    result,
  );
}
