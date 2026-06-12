# Tool Contract: workflow_next / workflow_run

Status: package v0.1 slice.

The LLM-visible surface intentionally stays limited to two tools.

## `workflow_next`

Purpose: semantic read-only route decision and compact context summary.

Semantic read-only means:

- does not mutate project source files
- does not mutate `.workflow/tasks/**` task state
- does not mutate `.workflow/config.json`
- does not run Git mutations
- may update `.workflow/.runtime/cache/**` and telemetry artifacts

Input:

```ts
type WorkflowNextInput = {
  task?: string;
  agent?: "research" | "implement" | "check" | "finish";
  includeContext?: "none" | "lite" | "brief" | "task" | "check" | "finish"; // default: lite
  detail?: "lite" | "summary" | "normal" | "full";
};
```

Output highlights:

```ts
type WorkflowNextOutput = {
  ok: boolean;
  status: "no_task" | "planning" | "in_progress" | "completed";
  task?: string;
  stage?: "grill" | "execute" | "finish";
  flowLevel?: "simple" | "standard" | "complex" | "goal";
  nextAction: string;
  recommendedTool?: { name: "workflow_run"; arguments: Record<string, unknown> };
  blockedBy: Array<{ code: string; message: string; severity: string; path?: string }>;
  warnings: Array<{ code: string; message: string; path?: string }>;
  evidenceRefs?: string[];
  omitted?: Array<{ kind: string; ref: string; bytes: number; reason: string }>;
  tokenBudget?: { estimatedInput: number; maxRecommended: number; cacheHit: boolean };
  cache?: { cacheFriendly: boolean; hit?: boolean; cacheKey?: string };
  meta?: { estimatedTokens: number; cacheHit?: boolean; durationMs?: number };
};
```

Default behavior:

- `includeContext` defaults to `lite`.
- `lite` returns evidence refs and omits detailed PRD/manifest/workspace data.
- Use `task`/`check`/`finish` context only when the LLM truly needs details.

Typical call:

```json
{}
```

Typical result next step:

```json
{
  "nextAction": "start_checked",
  "recommendedTool": {
    "name": "workflow_run",
    "arguments": { "action": "start_checked", "mode": "dry_run", "task": "06-12-example" }
  }
}
```

## `workflow_run`

Purpose: controlled actuator for workflow state changes and deterministic checks.

Input:

```ts
type WorkflowRunInput = {
  action: "create_from_grill" | "create_child" | "start_checked" | "checkpoint" | "finish_run" | "archive" | "batch";
  mode?: "dry_run" | "execute"; // default: dry_run
  task?: string;
  title?: string;
  level?: "simple" | "standard" | "complex" | "goal";
  slug?: string;
  parentTask?: string;
  phase?: "after-implementation" | "after-check" | "custom";
  profile?: "generic" | "unity";
  notes?: string;
  message?: string;
  userConfirmed?: boolean;
  actions?: Array<Omit<WorkflowRunInput, "action" | "actions"> & { action: Exclude<WorkflowRunInput["action"], "batch"> }>;
};
```

Output highlights:

```ts
type WorkflowRunOutput = {
  ok: boolean;
  mutated: boolean;
  action: string;
  mode: "dry_run" | "execute";
  task?: string;
  status?: string;
  stage?: string;
  summary: string;
  blockedBy: unknown[];
  warnings: unknown[];
  artifacts?: Array<{ kind: string; ref: string; summary?: string }>;
  checkpointId?: string;
  nextRecommendedCall?: { name: "workflow_next" | "workflow_run"; arguments: Record<string, unknown> };
  transaction?: WorkflowTransaction;
  rollbackHints?: WorkflowRollbackHint[];
  meta?: { estimatedTokens: number; durationMs?: number; omittedRefs?: string[] };
};
```

Mutation rules:

- Mutating actions require `mode: "execute"`.
- `dry_run` never changes task state.
- `finish_run` execute requires `message`.
- `archive` requires `userConfirmed=true` and is still reserved for project policy.

Batch rules:

- `action: "batch"` cannot contain nested batch items.
- Top-level `mode: "dry_run"` forces all child actions to dry-run.
- Top-level `mode: "execute"` makes child actions execute by default; a child may explicitly set `mode: "dry_run"`.
- Execute/partial batches write a transaction artifact and return rollback hints.

Example:

```json
{
  "action": "batch",
  "mode": "dry_run",
  "actions": [
    { "action": "start_checked", "task": "06-12-example" },
    { "action": "checkpoint", "task": "06-12-example", "phase": "after-implementation" }
  ]
}
```

## Error/blocker conventions

Tool calls return `ok:false` with `blockedBy[]` instead of throwing for expected workflow blockers. Examples:

- `prd_missing`
- `prd_todo_present`
- `prd_open_questions_blocking`
- `prd_final_confirmation_missing`
- `implement_manifest_missing`
- `check_manifest_missing`
- `git_diff_check_failed`
- `missing_message`

Unexpected programming/runtime errors may still throw through Pi's tool error path.
