# pi-coding-workflow Telemetry / Artifact Schema

Status: package v0.1 slice, schema version `1`.

Runtime files are written under `.workflow/.runtime/**` and are not source-of-truth project specs. `.workflow/.runtime/` should stay ignored by Git.

## Telemetry JSONL

Location:

```text
.workflow/.runtime/telemetry/workflow-YYYYMMDD.jsonl
.workflow/.runtime/telemetry/workflow-YYYYMMDD-01.jsonl  # rotation
```

Rotation policy:

- Max file size: `512 KiB`.
- When the daily file exceeds the limit, the writer appends to the next numeric suffix.
- One JSON object per line.
- Telemetry write failures are non-fatal for workflow tools.

Schema:

```ts
type WorkflowTelemetryEvent = {
  schemaVersion: 1;
  kind: "pi-coding-workflow.telemetry";
  package: { name: "pi-coding-workflow"; version: string };
  event: "workflow_next" | "workflow_run";
  createdAt: string;
  ok: boolean;
  task?: string;
  status?: string;
  stage?: string;
  action?: string;
  mode?: string;
  nextAction?: string;
  cacheHit?: boolean;
  estimatedTokens?: number;
  targetTokens?: number;
  truncatedBytes?: number;
  omittedRefs: string[];
  artifactRefs: string[];
  blockerCodes: string[];
  warningCodes: string[];
  transaction?: {
    id?: string;
    state?: "planned" | "committed" | "partial" | "failed" | string;
    plannedActions?: number;
    rollbackHints?: number;
    artifactRef?: string;
  };
  durationMs?: number;
};
```

Intent:

- Measure LLM-facing cost proxies (`estimatedTokens`, `targetTokens`, `truncatedBytes`).
- Track workflow cache behavior (`cacheHit`).
- Track omitted artifact refs so follow-up tooling can inspect what was excluded from LLM context.
- Track blockers/warnings and transaction artifacts for replay/debugging.

## Checkpoint artifact

Location:

```text
.workflow/.runtime/checkpoints/*.json
```

Schema:

```ts
type WorkflowCheckpointArtifact = {
  schemaVersion: 1;
  kind: "pi-coding-workflow.checkpoint";
  package: { name: "pi-coding-workflow"; version: string };
  phase: "after-implementation" | "after-check" | "custom" | string;
  notes?: string;
  passed: boolean;
  summary: string;
  checks: Array<{
    name: string;
    passed: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
  }>;
  createdAt: string;
};
```

Current checkpoint checks:

- `git diff --check`
- Non-Git projects are treated as skipped/pass for this check.

## Transaction artifact

Location:

```text
.workflow/.runtime/transactions/*.json
```

Schema shape:

```ts
type WorkflowTransactionArtifact = {
  transaction: {
    id: string;
    mode: "dry_run" | "execute";
    state: "planned" | "committed" | "partial" | "failed";
    plannedActions: Array<{
      index: number;
      action: string;
      mode: "dry_run" | "execute";
      task?: string;
      title?: string;
      summary: string;
    }>;
    rollbackHints: Array<{
      actionIndex: number;
      action: string;
      kind: "remove_created_task" | "restore_task_json" | "manual";
      path?: string;
      summary: string;
      data?: unknown;
    }>;
    artifactRef?: string;
  };
  results: Array<{
    ok: boolean;
    action: string;
    mode: "dry_run" | "execute";
    task?: string;
    status?: string;
    stage?: string;
    summary: string;
    blockedBy: unknown[];
    warnings: unknown[];
    artifactRef?: string;
  }>;
  createdAt: string;
};
```

Rollback hints are advisory. They intentionally avoid automatic deletion/restoration until a future explicit rollback action is designed.

## Workflow context cache

Location:

```text
.workflow/.runtime/cache/pi-workflow/context-cache.json
```

Cache is used for `workflow_next` `lite` / `brief` calls. The key includes:

- package version
- task id/status/stage/flowLevel/updatedAt
- task/config/PRD/manifest file fingerprints
- profile/detail/agent
- workspace fingerprint excluding `.workflow/.runtime/`

Cache is a performance artifact only. Deleting it must not affect workflow correctness.
