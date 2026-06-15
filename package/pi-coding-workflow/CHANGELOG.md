# Changelog

## 0.3.0 - 2026-06-15

### Added

- Added low-token `workflow_next` signal context with `detailRef` artifacts for full context.
- Added `list_tasks` status/limit/archive filters.
- Added delegate SDK injection for execute-path tests and `smoke:delegate-import`.

### Changed

- `sync_manifest_from_diff` dry-run now reports execute requirements and validates explicit entries.
- Adaptive deterministic start recommendations may use safe execute when gates are already clear.
- Documentation now describes safe execute behavior and delegate budget soft limits.

### Tests

- Added delegate execute success, unauthorized changes, and budget exceeded tests.
- Added signal context, manifest sync dry-run, and list task filtering tests.

## 0.2.0 - 2026-06-15

### Added

- Added deterministic manifest lifecycle actions: `init_manifests`, `upsert_manifest_entry`, `remove_manifest_entry`, and `sync_manifest_from_diff`.
- New tasks now include `implement.jsonl` and `check.jsonl` skeletons.
- Added `list_tasks`, `archive`, and `reopen` workflow actions.
- `workflow_next` now reports active task candidates and warns when multiple active tasks exist.
- Added GitHub Actions CI for `npm test` and Unity scanner smoke test.
- Added `.gitattributes` to stabilize line endings.
- Added a basic walkthrough under `examples/workflow-basic`.

### Changed

- `create_from_grill` and `create_child` now fall back to `workflow.defaultFlowLevel` when `level` is omitted.
- PRD final confirmation parsing now prefers explicit `Status: confirmed|pending` fields and uses safer natural-language fallback rules.
- Default git config no longer implies automatic commit or push; package execution remains non-committing.
- Runtime package version metadata is centralized through `src/version.ts` and follows `package.json`.
- Start-gate blocker computation is shared between context routing and `start_checked` validation.

### Fixed

- Invalid explicit task ids now return structured workflow blockers instead of uncaught `ENOENT` errors.
- Batch runs preserve their envelope when a child action references a missing task.
- Empty or malformed task JSON files are no longer normalized into anonymous active tasks.
