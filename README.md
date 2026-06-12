# Self-pi

Personal Pi package monorepo (`pipackage`) for reusable Pi extensions, skills and workflow packages.

## Packages

### `package/pi-coding-workflow`

Generic Pi coding workflow package. It keeps the LLM-visible workflow surface small while moving workflow state, preflight gates, cache, telemetry and adaptive routing into a TypeScript engine.

Core capabilities:

- **Two LLM-visible tools only**
  - `workflow_next`: semantic read-only router with lite context by default.
  - `workflow_run`: controlled actuator for create/start/checkpoint/finish/archive/batch actions.
- **Pi commands**
  - `/workflow-init`
  - `/workflow-init-spec`
  - `/workflow-prd-confirm`
- **PRD / manifest / finish gates**
  - PRD kernel parsing.
  - final confirmation gate.
  - `implement.jsonl` / `check.jsonl` validation.
  - start / checkpoint / finish preflight.
- **Pi-native optimization**
  - lite context with `evidenceRefs`, `omitted`, `tokenBudget`, `meta`.
  - fingerprint-backed workflow cache.
  - telemetry JSONL under `.workflow/.runtime/telemetry/`.
  - `pi.appendEntry()` lightweight session state.
  - workflow-aware `session_before_compact` summary.
- **Adaptive control**
  - `workflow_next.adaptiveControl` recommends deterministic preflight, user gate, or compact `research` / `implement` / `check` / `finish` brief.
  - No extra LLM-visible subagent tools are added.
- **History replay harness**
  - can replay historical `.workflow/tasks/**` samples in temporary workspaces for regression and quantification.

## Install / package path

GameBase currently loads the workflow package from:

```text
D:/YJL_AI/PI_Package/pipackage/package/pi-coding-workflow
```

Package resource declaration:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"],
    "skills": ["./skills"]
  }
}
```

## Common commands

From repository root:

```bash
npm test
```

From the workflow package:

```bash
cd package/pi-coding-workflow
npm test
npm run smoke:unity-scanner
npm run replay:history -- "D:/YJL_AI/GameBase" --variants as_is,planning,in_progress
```

## Latest local validation snapshot

GameBase history replay was run against 37 historical tasks with 3 variants each (`as_is`, `planning`, `in_progress`), for 111 replay cases:

| Metric | Result |
|---|---:|
| Route success | 111 / 111 |
| Second-pass cache hit | 111 / 111 |
| Avg `workflow_next` estimated tokens | 406 |
| Max `workflow_next` estimated tokens | 637 |
| Lite token target | 800 |
| Checkpoint pass rate | 100% |
| Missing referenced files | 0 |
| Replay errors | 0 |

Adaptive strategy distribution:

```text
deterministic_preflight: 57
subagent_brief: 48
ask_user: 6
```

Recommended agent distribution:

```text
implement: 37
none: 37
research: 31
user: 6
```

## Repository layout

```text
package/
  pi-coding-workflow/
    README.md
    package.json
    skills/
    src/
      engine/
      init/
      replay/
    templates/
    tests/
```

## Notes

- The workflow package is TypeScript-only; old Python workflow wrappers are intentionally not restored.
- Unity profile remains generic and does not hard-code GameBase-specific rules.
- Runtime artifacts belong under `.workflow/.runtime/**` in target projects and should not be treated as source-of-truth specs.
