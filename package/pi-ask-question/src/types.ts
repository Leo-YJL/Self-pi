import type { Static } from "typebox";
import type { OptionSchema, QuestionParamsSchema, QuestionSchema } from "./schema.ts";

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

export type AnswerKind = "option" | "custom" | "chat" | "multi";
export type DecisionSeverity = "blocking" | "non_blocking";
export type PersistTarget = "prd" | "spec" | "none";

export interface QuestionAnswer {
  questionIndex: number;
  question: string;
  kind: AnswerKind;
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
  decisionId?: string;
  severity?: DecisionSeverity;
  answerValue?: string;
  selectedValues?: string[];
  acceptedRecommended?: boolean;
  recommendedValue?: string;
  persistTo?: PersistTarget;
  consequence?: string;
}

export interface QuestionnaireResult {
  answers: QuestionAnswer[];
  cancelled: boolean;
  error?:
    | "no_ui"
    | "no_questions"
    | "empty_options"
    | "too_many_questions"
    | "duplicate_question"
    | "duplicate_decision_id"
    | "duplicate_option_label"
    | "reserved_label"
    | "multiple_recommended_options";
}

export type ValidationResult = { ok: true } | { ok: false; error: QuestionnaireResult["error"]; message: string };

export type Row =
  | { kind: "option"; option: OptionData; optionIndex: number }
  | { kind: "custom"; label: string }
  | { kind: "chat"; label: string }
  | { kind: "done"; label: string };

export type DialogAnswer =
  | { kind: "option"; optionIndex: number; answer: string; notes?: string; preview?: string }
  | { kind: "custom"; answer: string }
  | { kind: "chat" }
  | { kind: "multi"; selectedIndexes: number[]; selected: string[]; notes?: string };
