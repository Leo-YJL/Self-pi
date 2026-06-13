---
name: workflow-grill
description: Stage 1 intake, PRD drafting and flow-level selection for coding workflow tasks.
---
# workflow-grill

Use this generic skill only for active coding workflow projects using `pi-coding-workflow`.

## Rules

- Prefer `workflow_next` for read-only routing and adaptive planning/research guidance.
- If `adaptiveControl.recommendedAgent` is `research`, follow the returned brief to resolve PRD uncertainty before implementation.
- Use `/workflow-prd-confirm` for final human confirmation instead of asking the LLM to relay confirmation text.
- Prefer `workflow_run` for controlled workflow actions.
- After creating a planning task, record user-sourced grill decisions with `workflow_run action=record_grill_decision` and close Stage 1 with `workflow_run action=finalize_grill`; do not run `start_checked` while the task has `grill_not_finalized`.
- Do not use deprecated prompt wrappers or legacy command aliases.
- Keep project-specific facts in the project `.workflow/spec/**` overlay.
- Preserve unrelated dirty files.

## Decision Card clarification style

When requirements are ambiguous, use decision-card clarification instead of free-form interrogation.

A good grill question contains:

- `decisionId`: stable id, e.g. `image-pool.runtime-hard-whitelist`.
- `severity`: `blocking` when implementation cannot safely start without the decision.
- `context`: known facts from the user request, repository, PRD, or spec.
- `ambiguity`: what would remain unclear if the user does not decide.
- `recommendation`: one concrete recommended answer.
- `why`: why the recommendation is safer or cheaper, including trade-offs.
- `options`: 2-4 concrete choices. Put the recommended choice first and mark it recommended when the ask tool supports it.
- `persistTo`: normally `prd` for task-local decisions, `spec` only for durable project facts, and `none` for transient preferences.

Ask related decisions in small groups:

- 1-4 questions per `ask_user_question` call.
- Do not ask 10+ decisions at once.
- Split by topic, for example runtime semantics, editor behavior, table schema, validation, error handling.
- Ask high-risk decisions separately if they require careful reading.
- If later questions depend on earlier answers, wait for the first answer group before asking the next group.

## Recommended ask_user_question shape

When the `pi-ask-question` package is available, prefer the extended Decision Card fields:

```json
{
  "questions": [
    {
      "decisionId": "feature.runtime-behavior",
      "severity": "blocking",
      "persistTo": "prd",
      "header": "Runtime",
      "question": "Should runtime use behavior A or behavior B?",
      "context": "Known facts that make this decision necessary.",
      "ambiguity": "What can go wrong if we guess.",
      "recommendation": "Use behavior A.",
      "why": "Behavior A preserves existing semantics and has clearer failure modes.",
      "options": [
        {
          "label": "Use A",
          "value": "use_a",
          "recommended": true,
          "description": "Concrete behavior A.",
          "consequence": "This becomes the implementation contract."
        },
        {
          "label": "Use B",
          "value": "use_b",
          "description": "Concrete behavior B.",
          "consequence": "Requires extra fallback handling."
        }
      ]
    }
  ]
}
```

If only the legacy ask tool is available, still follow the same decision-card wording by putting context, ambiguity, recommendation, and why into the question/option descriptions.

## After the user answers

- Convert answers into explicit PRD decisions.
- For `persistTo=prd`, update `.workflow/tasks/<task>/prd.md`, usually under `## Grill Result` or a `## Decisions` section.
- For unresolved blocking decisions, keep them under `## Open Questions` and do not run `workflow_run start_checked`.
- Once blocking decisions and PRD final confirmation are resolved, run `workflow_run action=finalize_grill mode=dry_run` and then `mode=execute` before `start_checked`.
- For `persistTo=spec`, update `.workflow/spec/**` only when the answer is a durable project fact, not a one-task implementation detail.
- Re-run `workflow_next` after updating PRD/spec so blockers and adaptive control reflect the new state.

## Anti-patterns

- Do not ask vague questions like “How should this work?” without a recommendation.
- Do not ask every possible edge case upfront; ask only decisions that affect implementation safety.
- Do not treat “yes” as sufficient if the decision was not stated clearly in the prompt.
- Do not bury decisions only in chat history; write durable decisions into PRD/spec as appropriate.
- Do not force the user to choose a recommendation without showing at least one viable alternative and consequence.
