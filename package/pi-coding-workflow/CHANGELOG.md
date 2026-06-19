# Changelog

## 0.4.0 - unreleased

### Added

- `workflow_run` accepts `mode: "auto"` for gate-checked state actions (`create_from_grill`, `create_child`, `init_manifests`, `upsert_manifest_entry`, `remove_manifest_entry`, `finalize_grill`, `start_checked`, `finish_run`, `archive`, `reopen`). The engine runs preflight first and either commits (when gates pass) or returns a structured blocker without mutating (when gates fail), removing the `dry_run` + `execute` round-trip. `mode: "auto"` on PRD writes / `batch` / `sync_manifest_from_diff` falls back to `dry_run` so previews still happen.
- `workflow_run` `promptGuidelines` now recommends `mode=auto` as the default for those gate-checked actions.

### Changed

- `workflow_next` no longer mirrors `evidenceRefs`, `omitted`, and `tokenBudget` at the top level — these stay only inside `context.*` (their canonical location). Removes ~100 tokens / call duplication; measured ~20% reduction on every `workflow_next` payload (~500 tokens / lifecycle in standard scenarios). Top-level fields remain optional in the schema for backward compatibility but are no longer populated.
- `workflow_next` cache-miss path now spawns `git status --porcelain` exactly once per call. Both the cache-key fingerprint and the workspace summary inside the context bundle reuse a shared `readGitPorcelain` result. Saves one `git` process spawn (~30–80 ms on Windows) per cache miss.
- `workflow_run` preflight artifact id is now derived from the action + task + preflight payload (no `createdAt` in the id material). Identical preflight reruns reuse the same artifact file instead of writing a near-duplicate. Trivial preflight payloads (e.g. `list_tasks` pagination metadata, `sync_manifest_from_diff` with no candidates) are no longer written to disk at all — the inline summary already covers them.
- `workflow_next` signal-mode `detailRef` artifacts use a deterministic id derived from task + PRD/manifest hashes, and `writeJsonArtifact` skips the rewrite when an artifact with the same explicit id already exists. Identical signal payloads now reuse the same file instead of accumulating near-duplicate runtime artifacts.
- Telemetry warning `workflow_next_signal_suggested` now fires after 5 lite-only `workflow_next` calls (down from 12) so the suggestion to switch to `includeContext=signal` surfaces earlier.
- `workflow-finish` skill clarifies the `reopen` PRD dead-zone: requirements changes should be a new task rather than PRD edits after `reopen` (final confirmation would be invalidated and `finalize_grill` requires the `planning` state).

### Tests

- Added auto-mode coverage: passing-gate execute, failing-gate blocker, non-whitelisted fallback to `dry_run`, and per-child normalization inside `batch`.
- Added signal artifact dedup test (same payload reuses ref + mtime; mutated PRD produces new ref).
- Added `workflow_next_signal_suggested` threshold test (fires at 5 lite calls, clears after one signal call).
- Added top-level field dedup test (`workflow_next` no longer mirrors `evidenceRefs / omitted / tokenBudget` at the root).
- Added preflight dedup tests (identical `start_checked` reruns reuse the artifact mtime; `list_tasks` does not produce a preflight file).

## 0.3.1 - 2026-06-16 (lite slim, included in 0.4.0)

### Changed

- `workflow_next` lite-mode output drops the duplicate `blockedBy[]` (only `blockedCodes[]` is inlined), the natural-language `context.summary` is cleared, and `adaptiveControl.reasons`/`stopConditions` are stripped. Single-call lite output dropped from ~1141 tokens to ~530 tokens (-54%).
- `workflow_next` no-workflow branch no longer recommends `checkpoint`; it returns the `workflow_dir_missing` warning without a misleading recommended tool.
- `list_tasks` output drops the duplicate `preflight.tasks` array; only the top-level `tasks` array is returned.
- `cache.ts` schema bumped to v3 (output format changed; older caches are safely treated as miss).
- Telemetry events record `contextMode` and the summary distinguishes lite vs signal call counts.

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
