# PRD Format for `workflow-grill`

Use this format for `.workflow/tasks/<task-id>/prd.md`. Section titles intentionally match `pi-coding-workflow` PRD parsing.

## Template

```md
# {Task title}

## Execution Contract

- Flow Level: simple | standard | complex | goal
- Outcome: {one sentence describing the implementation-ready outcome}
- Task ID: {task-id}

## Goal

{1-3 short paragraphs explaining the user-visible or developer-visible outcome.}

## Requirements

- R1: {atomic, testable requirement}
- R2: {atomic, testable requirement}
- R3: {atomic, testable requirement}

## Out of Scope

- {explicit rejected behavior or alternative}
- {explicit non-goal}

## Acceptance Criteria

- [ ] {observable behavior that must be true when implementation is done}
- [ ] {observable behavior that must be true when implementation is done}

## Validation Plan

- [ ] {automated test, build, lint, or typecheck command}
- [ ] {manual verification step if needed}

## Definition of Done

- [ ] Implementation satisfies every requirement above.
- [ ] Acceptance criteria are checked with evidence.
- [ ] Validation plan has been run or documented with an accepted limitation.
- [ ] No unrelated files were changed.

## Architecture Impact

{Use `N/A` only if there is genuinely no architectural or durable project impact. Otherwise summarize affected modules, contracts, migrations, compatibility, or rollback concerns.}

## Open Questions

None.

## Grill Decision Log

| Round | Kind | Decision ID | Severity | Summary |
|---|---|---|---|---|
| round-1-scope | scope | `feature.scope.example` | blocking | {short user-sourced decision summary} |

## Final Confirmation Before Implementation

- Status: pending
```

## Section rules

### Execution Contract

Must include at least:

- `Flow Level`
- `Outcome`

The initial task created by `workflow_run action=create_from_grill` contains `Outcome: TODO`; replace it before finalization.

### Goal

Describe the target outcome, not implementation notes. Keep it concise.

### Requirements

Requirements should be implementation contracts:

- atomic,
- testable,
- unambiguous,
- stable enough for implementation,
- traceable to grill decisions when relevant.

Use IDs such as `R1`, `R2`, etc. when helpful.

### Out of Scope

Record deliberate exclusions so implementation does not drift. Examples:

- unsupported file types,
- no migration/backfill in this task,
- no UI redesign,
- no behavior change for legacy mode.

### Acceptance Criteria

Use checkboxes. These are later checked during finish, so phrase them as observable completed states.

Good:

```md
- [ ] Unsupported MIME types return the existing validation error shape.
- [ ] Existing valid PNG/JPEG uploads continue to succeed.
```

Avoid vague items:

```md
- [ ] Validation works well.
```

### Validation Plan

Use checkboxes and include exact commands when known:

```md
- [ ] npm test
- [ ] npm run build
- [ ] Manual: upload a `.gif` avatar and verify the documented error message.
```

If a command cannot be run in the environment, keep the item and document the limitation at finish time rather than deleting it.

### Definition of Done

Use checkboxes. Keep generic workflow completion criteria plus task-specific completion requirements if needed.

### Architecture Impact

Use this section for durable or cross-cutting effects:

- public API contracts,
- data model changes,
- migrations/backfills,
- feature flags,
- compatibility concerns,
- rollback strategy,
- spec updates needed in `.workflow/spec/**`.

Use `N/A` only when the task is truly local and has no durable impact.

### Open Questions

Before `finalize_grill`, this section must be `None.` or another neutral no-blocker phrase. Any meaningful content is treated as blocking.

If a blocking question remains, do not finalize. Ask another grill question, record the answer, and update the PRD.

### Grill Decision Log

Every answered business decision with `persistTo: "prd"` must appear literally in this section. Prefer `workflow_run action=append_prd_decisions` to maintain the table.

Final confirmation decision IDs must not be mixed into business rounds. Do not add `stage1-final-confirm` here as a business decision.

### Final Confirmation Before Implementation

Do not hand-write the final confirmed state or hash. Keep it pending until the user has reviewed the latest PRD.

Use:

```text
/workflow-prd-confirm --task <task-id> --message "<user confirmation>" --execute
```

The command writes:

```md
- Status: confirmed
- Confirmed By: user
- Confirmed At: {timestamp}
- Confirmed PRD Hash: {hash}
- Evidence: {message}
```

The hash must match the PRD body excluding the final confirmation section. If the PRD changes after confirmation, confirm again.
