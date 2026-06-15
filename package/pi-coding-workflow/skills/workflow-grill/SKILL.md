---
name: workflow-grill
description: "Stage 1 PRD-first intake for pi-coding-workflow tasks: create or continue a planning/grill task, challenge unclear requirements against code/spec, record user decisions, update the task PRD after each round, confirm the PRD, and finalize grill before implementation starts."
---
# workflow-grill

Use this skill only for active coding workflow projects using `pi-coding-workflow`.

This is the `pi-coding-workflow` adaptation of the `grill-with-docs` style: interview relentlessly, challenge terminology and assumptions against repository evidence, resolve dependencies one decision at a time, and write decisions down immediately. The durable output is the workflow task PRD; update `.workflow/spec/**` only for reusable project knowledge. Do not create `CONTEXT.md` or ADRs as part of this skill.

## Reference docs

Keep this `SKILL.md` as the operating checklist. Load these references only when needed:

- [PRD-FORMAT.md](./PRD-FORMAT.md): preferred `.workflow/tasks/<task-id>/prd.md` shape and section rules.
- [DECISION-CARDS.md](./DECISION-CARDS.md): detailed Decision Card wording and examples.
- [EXAMPLES.md](./EXAMPLES.md): `workflow_run`, `workflow_next`, PRD update, and finalization examples.

## Required outcome

By the end of Stage 1 grill:

1. A suitable `.workflow/tasks/<task-id>/task.json` planning/grill task exists.
2. `.workflow/tasks/<task-id>/prd.md` is implementation-ready:
   - no `TODO` / `TBD` / `待定` markers,
   - no blocking open questions,
   - all user-sourced business decisions appear literally in `## Grill Decision Log`,
   - final PRD confirmation is recorded with explicit `Status: confirmed` and the current PRD hash,
   - `implement.jsonl` / `check.jsonl` are initialized and real entries are maintained through manifest actions,
   - Stage 1 grill is finalized by `workflow_run action=finalize_grill`.
3. Implementation has not started unless the user explicitly asks to continue after grill finalization.

## Start sequence

1. Run `workflow_next({ "includeContext": "signal" })` to detect workflow state with minimal token use; request `lite` or `task` context only if the signal refs are insufficient.
2. If `.workflow/config.json` is missing, stop and tell the user to initialize workflow first (`/workflow-init --execute`, then `/workflow-init-spec --execute --plan <plan-id>` if needed). Do not create ad-hoc task files by hand.
3. If `workflow_next` returns `adaptiveControl.strategy: "subagent_brief"`, prefer the recommended `workflow_delegate` dry-run/execute path for bounded research before asking questions that repository/spec inspection can answer.
4. If a planning/grill task already exists and appears to match the request, continue it. If it might be unrelated, ask before creating a duplicate.
5. If no suitable task exists, create one with `workflow_run action=create_from_grill`: dry-run first, then execute once title is clear. If flow level is omitted, the workflow config default is used.

Prefer `workflow_next` for read-only routing and `workflow_run` for controlled mutations. Do not use deprecated prompt wrappers or legacy command aliases.

## Flow level selection

- `simple`: one localized change, low ambiguity, one implementation/check slice.
- `standard`: default for normal features/fixes with meaningful requirements or tests.
- `complex`: cross-cutting behavior, migrations, multiple subsystems, high-risk rollback or compatibility concerns.
- `goal`: umbrella task that should likely produce child tasks.

When unsure, recommend `standard`. Ask only if the wrong level would materially change grill depth, PRD scope, or workflow gating.

## Grill discipline

- Ask one decision at a time by default; group only tightly coupled decisions, max 4 per `ask_user_question` call.
- Every blocking question needs a concrete recommendation, 2-4 viable choices, consequences, and `persistTo`.
- If code, docs, `.workflow/spec/**`, or the current PRD can answer a question, inspect those sources instead of asking.
- Cross-check user statements against repository evidence. If code/spec contradicts the user, surface the contradiction and ask which source wins.
- Sharpen vague terms into canonical project language. If terms like “account”, “session”, “sync”, “done”, or “safe” are overloaded, force precision.
- Stress-test boundaries with concrete scenarios and edge cases.
- Preserve unrelated dirty files.

Use Decision Cards for ambiguous requirements. Required fields: `decisionId`, `severity`, `context`, `ambiguity`, `recommendation`, `why`, `options`, and `persistTo`. See [DECISION-CARDS.md](./DECISION-CARDS.md) for examples.

## Required grill rounds

Business decisions and final PRD confirmation are separate concepts.

- `simple`: at least 1 business grill round, then a separate final PRD confirmation round.
- `standard`: at least 2 business grill rounds, then a separate final PRD confirmation round.
- `complex` / `goal`: at least 3 business grill rounds, then a separate final PRD confirmation round.

Recommended business sequence:

1. `scope`: goal, non-goals, affected users, out-of-scope behavior.
2. `runtime`: behavior, data model, state transitions, errors, compatibility, rollback/fallback.
3. `validation`: acceptance criteria, tests, manual checks, observability, Definition of Done.

Use `roundKind`: `scope`, `runtime`, `validation`, `custom`; reserve `final_confirmation` for the final confirmation only. Do not compress all blocking choices into one ask. After each business round, record decisions and update the PRD before asking the next round.

## After every user answer

1. Convert the answer into explicit implementation contract language.
2. Prefer one `workflow_run action=record_round_and_update_prd mode=execute` call to record the round, update PRD sections, and append missing `## Grill Decision Log` rows.
3. Use `decisionSource: "ask_user_question"` for the question UI; use `"user"` for normal chat answers.
4. Reuse the same `roundId` for all decisions from the same `ask_user_question` call.
5. Use `decisionSeverity: "blocking"` unless the decision is genuinely optional.
6. Use `persistTo: "prd"` for task-local behavior, `"spec"` only for durable project knowledge, and `"none"` only for transient preferences.
7. Only fall back to separate `record_grill_decision`, `update_prd_section`, and `append_prd_decisions` calls when the composite action cannot express the update.
8. Do not call `workflow_next` after every PRD child update. Re-run `workflow_next({ "includeContext": "signal" })` once after the round for routing; request `detail:"normal"` only when the full Decision Card template is needed.

For examples, see [EXAMPLES.md](./EXAMPLES.md).

## PRD drafting rules

- Write the PRD as an implementation contract, not a brainstorming transcript.
- Follow [PRD-FORMAT.md](./PRD-FORMAT.md) when drafting or repairing the PRD.
- Keep requirements atomic, testable, unambiguous, and traceable to grill decisions when relevant.
- Use explicit `Out of Scope` bullets for rejected alternatives and non-goals.
- Acceptance Criteria, Validation Plan, and Definition of Done should use checklists so finish preflight can track completion later.
- `## Open Questions` must be `None.` before finalization; if a blocking question remains, keep grilling.
- Remove the initial `Outcome: TODO` created by `create_from_grill`.
- Do not hand-write `Confirmed PRD Hash`; use `/workflow-prd-confirm` so the hash matches the current PRD body and the final confirmation section contains `Status: confirmed`.

## Final confirmation and handoff

Final confirmation happens only after the latest PRD has been written and reviewed. It must be separate from business decision rounds.

1. Show the user the PRD path and a concise summary of scope, out-of-scope items, acceptance criteria, validation plan, and known risks.
2. Ask a final Decision Card with only confirmation choices: `Confirm PRD` or `Revise PRD`.
3. If the user chooses revise, update the PRD and repeat final confirmation.
4. If the user confirms, record final confirmation with `/workflow-prd-confirm --task <task-id> --message "<user confirmation>" --execute`.
5. Run `workflow_run action=finalize_grill mode=dry_run userConfirmed=true decisionSource=ask_user_question`.
6. If dry-run passes, run the same `finalize_grill` in `execute` mode.
7. Run `workflow_next({ "includeContext": "signal" })` and report the next workflow step.

Do not include `stage1-final-confirm`, `final-confirmation`, or `prd-confirm` in the same `ask_user_question` call as business decisions. Do not append final confirmation decision IDs into the business `## Grill Decision Log`.

## Anti-patterns

- Do not start implementation while this skill is still resolving PRD decisions.
- Do not ask vague questions like “How should this work?” without a recommendation.
- Do not ask questions that repository inspection can answer.
- Do not ask every possible edge case upfront; ask only decisions that affect implementation safety.
- Do not treat “yes” as sufficient if the decision was not stated clearly in the prompt.
- Do not bury decisions only in chat history; record them with `workflow_run` and write them into the PRD/spec.
- Do not leave `TODO`, `TBD`, or blocking Open Questions in the PRD.
- Do not manually fake final confirmation or a PRD hash.
- Do not hand-write manifest JSONL when a deterministic manifest action can express the change.
- Do not mix final confirmation with scope/runtime/validation decisions.
- Do not force the user to choose a recommendation without showing at least one viable alternative and consequence.
- Do not update unrelated files or overwrite unrelated dirty changes.
