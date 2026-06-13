import { Type } from "typebox";
import { MAX_HEADER_LENGTH, MAX_LABEL_LENGTH, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "./constants.ts";

export const OptionSchema = Type.Object({
  label: Type.String({
    maxLength: MAX_LABEL_LENGTH,
    description: "Option label shown to the user. Keep it concise: 1-5 words, max 60 characters.",
  }),
  description: Type.String({
    description: "Short explanation of what this choice means, including trade-offs when useful.",
  }),
  value: Type.Optional(
    Type.String({
      description: "Stable value to return for this option. Defaults to label when omitted.",
    }),
  ),
  recommended: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Set true when this option is the assistant's recommended decision.",
    }),
  ),
  consequence: Type.Optional(
    Type.String({
      description: "What changes, risk, or trade-off follows if this option is chosen.",
    }),
  ),
  preview: Type.Optional(
    Type.String({
      description: "Optional markdown/code/ascii preview shown beside or below this option.",
    }),
  ),
});

export const QuestionSchema = Type.Object({
  question: Type.String({
    description: "Complete question to ask the user. Make it specific and normally end with a question mark.",
  }),
  header: Type.String({
    maxLength: MAX_HEADER_LENGTH,
    description: "Very short label for this question, max 16 characters. Examples: Scope, Runtime, Table.",
  }),
  decisionId: Type.Optional(
    Type.String({
      description: "Stable decision id, e.g. image-pool.runtime-hard-whitelist. Useful for writing PRD decision logs.",
    }),
  ),
  severity: Type.Optional(
    Type.Union([Type.Literal("blocking"), Type.Literal("non_blocking")], {
      description: "Whether this decision blocks implementation or can be resolved later.",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description: "Known facts or current state that make the question necessary.",
    }),
  ),
  ambiguity: Type.Optional(
    Type.String({
      description: "What remains ambiguous if the user does not decide.",
    }),
  ),
  recommendation: Type.Optional(
    Type.String({
      description: "Assistant's recommended answer in concrete implementation terms.",
    }),
  ),
  why: Type.Optional(
    Type.String({
      description: "Why the recommendation is preferred; include trade-offs when useful.",
    }),
  ),
  persistTo: Type.Optional(
    Type.Union([Type.Literal("prd"), Type.Literal("spec"), Type.Literal("none")], {
      description: "Where the answer should normally be recorded by the agent after the tool returns.",
    }),
  ),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: "2-4 concrete choices. The UI adds custom answer / chat / navigation rows itself.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description: "Set true when multiple options may be selected.",
    }),
  ),
});

export const QuestionParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: `Ask 1-${MAX_QUESTIONS} structured questions or decision cards in one call.`,
  }),
});
