# Workflow System Spec

## Purpose

Document how tasks, specs, validation, and finish flow are managed in this project.

## Rules

- Keep task requirements in PRD or equivalent task files.
- For standard/complex/goal workflow tasks, Stage 1 grill should be multi-round: business decision round → PRD update → next round → PRD update → final PRD confirmation.
- Record business decision ids literally in the PRD Grill Decision Log; use deterministic PRD append/update helpers where available, and ensure final confirmation is tied to the latest PRD hash.
- Keep durable project knowledge in .workflow/spec.
- Do not treat runtime artifacts under .workflow/.runtime as source.
