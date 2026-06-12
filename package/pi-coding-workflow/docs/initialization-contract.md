# Initialization Contract

Status: package v0.1 slice.

Initialization is split into base workspace init and spec init.

## Base workspace init

Command:

```text
/workflow-init --dry-run
/workflow-init --execute
```

Engine functions:

- `planInitWorkspace(root, profile)`
- `executeInitWorkspace(root, profile)`

Created structure:

```text
.workflow/
  config.json
  tasks/
    .gitkeep
  spec/
    .gitkeep
  .runtime/
    .gitkeep
```

`.gitignore` is created or updated to include:

```text
.workflow/.runtime/
```

Rules:

- Base init must not copy TypeScript engine files into the target project.
- Base init must not create `.pi/extensions` or old Python wrappers.
- Existing base files are skipped, not overwritten.
- The default context mode is `lite`.

## Spec init

Commands:

```text
/workflow-init-spec --profile generic --dry-run
/workflow-init-spec --profile unity --dry-run
/workflow-init-spec --execute --plan <plan-id>
```

Engine functions:

- `initSpecDryRun(root, profile)`
- `initSpecExecute(root, planId, answers, allowModify)`

Dry-run behavior:

- Always writes a plan artifact first:

```text
.workflow/.runtime/init-spec/<plan-id>.json
```

- Returns the plan id and artifact ref.
- Does not modify `.workflow/spec/**` source spec files.

Execute behavior:

- Reads an existing plan by id.
- Must not rescan and silently generate a different plan.
- Creates files whose operations are `op:"create"` and whose target path does not already exist.
- Skips existing files for first-version templates.
- Requires blocking question answers before execute.
- `op:"modify"` is skipped unless `allowModify=true`.
- Template content hash is verified before writing.

## Profiles

### generic

Creates:

```text
.workflow/spec/index.md
.workflow/spec/guides/general.md
.workflow/spec/modules/index.md
.workflow/spec/modules/project-architecture.md
.workflow/spec/modules/build-and-test.md
.workflow/spec/modules/workflow-system.md
```

### unity

Includes all generic files plus:

```text
.workflow/spec/modules/unity-project.md
.workflow/spec/modules/unity-assets.md
```

Unity rules:

- Detect facts from project files (`Assets`, `Packages`, `ProjectSettings`, asmdefs, scenes, bootstrap scripts).
- Do not default to Addressables/YooAsset/AssetBundle rules unless project facts support them.
- Do not hard-code GameBase-specific Core/HotUpdate/Design/ExcelTools/HybridCLR rules.
- First version intentionally does not create `editor-and-build.md`.

## Runtime artifacts

Runtime-only generated files belong under:

```text
.workflow/.runtime/**
```

Examples:

- init-spec plans
- checkpoints
- transactions
- telemetry
- workflow context cache

Deleting `.workflow/.runtime/**` may lose performance/debug artifacts but must not break durable project facts.
