# Decision Card Guide for `workflow-grill`

Use Decision Cards whenever a requirement is ambiguous enough that implementation cannot safely start without a user decision.

## Required fields

A good grill question contains:

- `decisionId`: stable id, e.g. `image-pool.runtime-hard-whitelist`.
- `severity`: `blocking` when implementation cannot safely start without the decision.
- `context`: known facts from the user request, repository, PRD, or spec.
- `ambiguity`: what remains unclear if the user does not decide.
- `recommendation`: one concrete recommended answer.
- `why`: why the recommendation is safer or cheaper, including trade-offs.
- `options`: 2-4 concrete choices; mark exactly one recommended option for single-select questions.
- `persistTo`: normally `prd`; use `spec` only for durable project facts and `none` only for transient preferences.

## Grouping rules

- Ask one decision at a time by default.
- Group only tightly coupled decisions.
- Never put more than 4 questions in one `ask_user_question` call.
- If later questions depend on earlier answers, wait for the first answer group.
- Ask high-risk decisions separately if they require careful review.
- Never mix final PRD confirmation with business decisions.

## Persist targets

- `prd`: task-local implementation contract, scope, behavior, validation, risk, non-goal.
- `spec`: durable project knowledge that should apply to future tasks.
- `none`: transient preference or conversation-only choice.

If `persistTo=spec`, update `.workflow/spec/**` only after confirming the decision is reusable project knowledge.

## Business decision example

```json
{
  "questions": [
    {
      "decisionId": "avatar.scope.file-types",
      "severity": "blocking",
      "persistTo": "prd",
      "header": "File types",
      "question": "Which avatar file types should this task accept?",
      "context": "The request says avatar upload validation, but the current API only documents PNG examples.",
      "ambiguity": "If we guess, implementation may reject files the product expects or accept files the backend cannot process.",
      "recommendation": "Accept PNG and JPEG only for this task.",
      "why": "This matches common browser avatar flows and avoids adding GIF/WebP processing risk before requirements exist.",
      "options": [
        {
          "label": "PNG + JPEG",
          "value": "png_jpeg",
          "recommended": true,
          "description": "Accept `.png`, `.jpg`, and `.jpeg` uploads.",
          "consequence": "PRD will scope validation and tests to PNG/JPEG."
        },
        {
          "label": "Images broad",
          "value": "common_images",
          "description": "Accept PNG, JPEG, GIF, and WebP.",
          "consequence": "Requires broader MIME and edge-case validation."
        },
        {
          "label": "Match current API",
          "value": "current_api_only",
          "description": "Accept only what the existing API already documents.",
          "consequence": "Lowest change risk, but may not satisfy product expectations."
        }
      ]
    }
  ]
}
```

## Final confirmation example

Use this only after the latest PRD has been written and reviewed.

```json
{
  "questions": [
    {
      "decisionId": "stage1-final-confirm",
      "severity": "blocking",
      "persistTo": "prd",
      "header": "Confirm",
      "question": "Do you confirm the current PRD is ready for implementation?",
      "context": "The PRD has been updated with all recorded grill decisions and has no blocking open questions.",
      "ambiguity": "Implementation should not start until the user confirms this exact PRD revision.",
      "recommendation": "Confirm the PRD and finalize Stage 1.",
      "why": "The workflow gate needs a user-sourced confirmation tied to the latest PRD hash.",
      "options": [
        {
          "label": "Confirm PRD",
          "value": "confirm",
          "recommended": true,
          "description": "Approve the current PRD for implementation.",
          "consequence": "Run `/workflow-prd-confirm`, then finalize Stage 1 grill."
        },
        {
          "label": "Revise PRD",
          "value": "revise",
          "description": "Pause and change scope, requirements, validation, or risks.",
          "consequence": "Keep the task in planning/grill and update the PRD before asking again."
        }
      ]
    }
  ]
}
```

## Legacy ask fallback

If only a legacy ask tool is available, still preserve the same structure by putting context, ambiguity, recommendation, why, and consequences into the question and option descriptions.
