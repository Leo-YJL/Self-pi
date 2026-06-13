import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS } from "./constants.ts";
import { buildQuestionnaireResponse, buildToolResult } from "./result.ts";
import { QuestionParamsSchema } from "./schema.ts";
import type { QuestionAnswer, QuestionData, QuestionParams, QuestionnaireResult } from "./types.ts";
import { askOneQuestion } from "./ui.ts";
import { validateQuestionnaire } from "./validation.ts";

export default function piAskQuestionPackage(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description: `Ask the user one or more structured clarifying questions or decision cards during execution.
Use this tool when the task is underspecified and you need concrete user decisions instead of guessing.

Capabilities:
- 1-${MAX_QUESTIONS} questions per call.
- ${MIN_OPTIONS}-${MAX_OPTIONS} options per question.
- Backward compatible with simple structured questions.
- Decision Card fields: decisionId, severity, context, ambiguity, recommendation, why, persistTo.
- Options can include value, recommended, consequence and preview.
- Single-select questions include a custom free-text fallback.
- Multi-select questions support selecting multiple options.
- Users can add notes, accept the recommended option, toggle decision details, or choose Chat about this.

Do not author reserved labels such as Other, Type something., Chat about this, Next, or Submit; the UI adds those rows itself.`,
    promptSnippet: `Ask the user up to ${MAX_QUESTIONS} structured clarifying questions or decision cards when requirements are ambiguous`,
    promptGuidelines: [
      `Use ask_user_question when you cannot safely proceed without concrete user preferences, requirements, or implementation decisions.`,
      `For grill/intake work, prefer Decision Card fields: decisionId, severity, context, ambiguity, recommendation, why, and persistTo.`,
      `Group related clarification into one ask_user_question call; do not make multiple back-to-back calls unless the next group depends on previous answers.`,
      `Each question must have ${MIN_OPTIONS}-${MAX_OPTIONS} useful options. Every option needs a short label and a description explaining consequence or trade-off.`,
      `Mark exactly one recommended option for single-select decision cards when you have a safe default recommendation.`,
      `Use persistTo=prd for task-local implementation decisions, persistTo=spec for durable project facts, and persistTo=none for transient preferences.`,
      `Use option.preview for concrete artifacts that benefit from visual comparison, such as code snippets, configs, UI mockups, diagrams, or migration plans.`,
    ],
    parameters: QuestionParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const typed = params as QuestionParams;
      if (!ctx.hasUI) {
        return buildToolResult("Error: UI not available (running in non-interactive mode)", {
          answers: [],
          cancelled: true,
          error: "no_ui",
        });
      }

      const validation = validateQuestionnaire(typed);
      if (!validation.ok) {
        return buildToolResult(validation.message, { answers: [], cancelled: true, error: validation.error });
      }

      pi.events.emit("ask_user_question:prompt", {
        questions: typed.questions.map((q) => ({
          question: q.question,
          header: q.header,
          decisionId: q.decisionId,
          severity: q.severity,
          persistTo: q.persistTo,
          hasRecommendation: Boolean(q.recommendation || q.options.some((o) => o.recommended)),
          multiSelect: q.multiSelect ?? false,
          options: q.options.map((o) => ({
            label: o.label,
            value: o.value,
            recommended: Boolean(o.recommended),
            hasPreview: Boolean(o.preview),
            hasConsequence: Boolean(o.consequence),
          })),
        })),
      });

      const answers: QuestionAnswer[] = [];
      for (let i = 0; i < typed.questions.length; i++) {
        const answer = await askOneQuestion(ctx, typed.questions[i], i, typed.questions.length);
        if (!answer) return buildQuestionnaireResponse({ answers, cancelled: true }, typed);
        answers.push(answer);
        if (answer.kind === "chat") break;
      }

      return buildQuestionnaireResponse({ answers, cancelled: false }, typed);
    },

    renderCall(args, theme) {
      const questions = Array.isArray(args.questions) ? (args.questions as QuestionData[]) : [];
      const labels = questions.map((q, i) => q.decisionId || q.header || `Q${i + 1}`).join(", ");
      const decisionCount = questions.filter((q) => q.decisionId || q.recommendation || q.ambiguity).length;
      let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
      text += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
      if (decisionCount > 0) text += theme.fg("accent", ` • ${decisionCount} decision card${decisionCount === 1 ? "" : "s"}`);
      if (labels) text += theme.fg("dim", ` (${truncateToWidth(labels, 48)})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      if (details.cancelled) return new Text(theme.fg("warning", "User declined / cancelled"), 0, 0);

      const lines = details.answers.map((answer) => {
        const label = answer.decisionId ? `[${answer.decisionId}]` : `Q${answer.questionIndex + 1}`;
        const recommended = answer.acceptedRecommended ? theme.fg("success", " recommended") : "";
        const persist = answer.persistTo ? theme.fg("dim", ` → ${answer.persistTo}`) : "";
        if (answer.kind === "multi") {
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", label)}: ${answer.selected?.join(", ") || "(none)"}${recommended}${persist}`;
        }
        if (answer.kind === "chat") {
          return `${theme.fg("warning", "↪ ")}${theme.fg("accent", label)}: chat about this${persist}`;
        }
        const prefix = answer.kind === "custom" ? "(typed) " : "";
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", label)}: ${theme.fg("muted", prefix)}${answer.answer ?? ""}${recommended}${persist}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
