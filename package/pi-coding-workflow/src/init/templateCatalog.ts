export const GENERIC_TEMPLATES: Record<string, string> = {
  ".workflow/spec/index.md": `# Project Spec Index

This directory is the durable project fact source for coding workflow tasks.

## Profile

- Profile: {{profile}}

## Reading Order

- guides/general.md
- modules/index.md
- modules/project-architecture.md
- modules/build-and-test.md
- modules/workflow-system.md

## Update Rule

When a task establishes durable project knowledge, update the relevant spec file in the same task or record why it is deferred.
`,
  ".workflow/spec/guides/general.md": `# General Project Guide

## Principles

- Read current project facts before modifying files.
- Preserve unrelated dirty files.
- Keep source of truth and generated output policy explicit.
- Record validation limits when commands cannot run.

## Validation

- Prefer project-configured checks.
- Run whitespace/diff checks when available.
`,
  ".workflow/spec/modules/index.md": `# Modules Spec Index

- project-architecture.md — project structure and ownership boundaries.
- build-and-test.md — configured validation commands and limits.
- workflow-system.md — task workflow and spec update rules.
`,
  ".workflow/spec/modules/project-architecture.md": `# Project Architecture Spec

## Purpose

Document project structure, module boundaries, and durable ownership rules.

## Current State

TODO(init-spec): Fill with project-specific architecture facts.
`,
  ".workflow/spec/modules/build-and-test.md": `# Build and Test Spec

## Purpose

Document project validation commands and owner boundaries.

## Commands

TODO(init-spec): Add build/test/typecheck commands when verified.
`,
  ".workflow/spec/modules/workflow-system.md": `# Workflow System Spec

## Purpose

Document how tasks, specs, validation, and finish flow are managed in this project.

## Rules

- Keep task requirements in PRD or equivalent task files.
- Keep durable project knowledge in .workflow/spec.
- Do not treat runtime artifacts under .workflow/.runtime as source.
`,
};

export const UNITY_TEMPLATES: Record<string, string> = {
  ".workflow/spec/modules/unity-project.md": `# Unity Project Spec

## Purpose

This document defines the Unity project structure, runtime architecture, bootstrap entry, assembly/reference boundaries, and project-level coding constraints.

It is a durable project fact source. If this document conflicts with current Unity project files or source code, current project files win and this spec must be updated in the same task or the risk must be recorded.

## Scope

Applies to:

- \`Assets/**\`
- \`Packages/manifest.json\`
- \`Packages/packages-lock.json\`
- \`ProjectSettings/**\`
- Unity runtime C# code
- Unity Editor C# code
- asmdef files
- bootstrap / entry scene / initial scene loading

Does not define:

- Detailed resource address rules; see \`unity-assets.md\`.
- Editor/build/packaging workflow; those are owned by project-specific methods or overlay specs.
- Project-specific business architecture beyond what is explicitly recorded in this project overlay.

## Fact Sources

Primary facts:

- \`ProjectSettings/ProjectVersion.txt\`
- \`Packages/manifest.json\`
- \`Packages/packages-lock.json\`
- \`Assets/**\`
- \`*.asmdef\`
- Project bootstrap scripts and entry scenes

Detected by init-spec:

| Fact | Value |
|---|---|
| Project name | \`{{project_name}}\` |
| Unity version | \`{{unity_version}}\` |
| Assets root | \`{{assets_root}}\` |
| Packages manifest | \`{{packages_manifest}}\` |
| ProjectSettings root | \`{{project_settings_root}}\` |
| Entry scene candidate | \`{{first_scene}}\` |
| Bootstrap candidate | \`{{bootstrap_entry}}\` |

If a value is unknown, keep it marked as \`TODO(init-spec)\` until verified.

## Unity Directory Contract

Expected Unity project shape:

\`\`\`text
ProjectRoot/
  Assets/
  Packages/
    manifest.json
    packages-lock.json
  ProjectSettings/
    ProjectVersion.txt
  UserSettings/          # local/user settings, normally not a durable architecture fact
  Library/               # generated cache, not source
  Temp/                  # generated cache, not source
  obj/                   # generated cache, not source
\`\`\`

Rules:

- \`ProjectSettings/ProjectVersion.txt\` is the Unity version fact source.
- \`Packages/manifest.json\` and \`Packages/packages-lock.json\` are package dependency fact sources.
- \`Assets/**\` contains runtime code, Editor code and Unity assets.
- \`Library/\`, \`Temp/\`, \`obj/\`, build output and cache output must not be treated as source files.
- Do not commit generated cache directories unless this project explicitly documents a reason.

## Runtime Architecture Contract

Default Unity layering:

\`\`\`text
Game / Feature Layer
  - gameplay
  - UI
  - scene logic
  - feature managers
  - presentation logic
        ↓
Runtime Foundation Layer
  - bootstrap
  - service contracts
  - resource facade
  - event/timer/pool utilities
  - base UI/window abstractions
  - platform abstraction
        ↓
Unity / Third-party Layer
  - UnityEngine
  - Unity packages
  - rendering/input/resource packages
  - third-party SDKs
\`\`\`

Rules:

- Feature code may depend on Runtime Foundation contracts.
- Runtime Foundation must not reference concrete feature/business types.
- Cross-module communication should use interfaces, services, events, explicit data contracts, or narrow references.
- Avoid creating new global managers/singletons unless the PRD/spec explains ownership, lifetime, reset behavior and debug strategy.
- Project-specific architecture may refine this layering in an overlay spec, but must preserve clear dependency direction.

## Bootstrap Contract

Generic startup model:

\`\`\`text
Launch Scene / Entry Scene
  -> Bootstrap MonoBehaviour
  -> Read project config
  -> Initialize logging / services / resource system
  -> Load initial data or manifests
  -> Enter first procedure / scene / UI
\`\`\`

Project facts:

| Startup fact | Value |
|---|---|
| Entry scene | \`{{first_scene}}\` |
| Bootstrap component/script | \`{{bootstrap_entry}}\` |
| Config source | \`TODO(init-spec): config source if any\` |
| Resource system | \`{{resource_system}}\` |
| First scene/UI/procedure after bootstrap | \`TODO(init-spec): first runtime destination\` |

Rules:

- Startup entry must be locatable from project files.
- Initialization order must be documented when modified.
- Changing bootstrap, first scene, config loading, service initialization, or resource initialization requires updating this spec.
- If Unity Editor / PlayMode validation cannot run, the limitation must be recorded.

## Assembly Definition / Reference Rules

Rules:

- Runtime assemblies must not reference Editor assemblies.
- Editor-only code must live under \`Editor/\` folders or Editor-only asmdefs.
- Shared runtime contracts should live in a lower-level runtime assembly or clearly documented foundation layer.
- Avoid circular asmdef references.
- If asmdefs are changed, inspect reference direction and run available compile checks.

Detected assemblies:

| Assembly | Type | Notes |
|---|---|---|
| \`{{runtime_assembly_names}}\` | Runtime | TODO(init-spec): verify |
| \`{{editor_assembly_names}}\` | Editor | TODO(init-spec): verify |

## Unity C# Rules

Default rules:

- Use stable formatting and 4 spaces.
- Prefer \`[SerializeField] private\` fields over public Inspector fields.
- \`MonoBehaviour\` file name should match the component class name.
- Unity hot paths should avoid LINQ, boxing, closures, temporary collections, per-frame string concatenation and uncached \`GetComponent\`.
- Event subscription and unsubscription must be symmetric.
- Animation, VFX, Audio and UI transitions are presentation/timing tools; they must not own authoritative gameplay truth.
- Editor code and Runtime code must remain separated.

Project-specific C# style may be refined by a \`coding-style.md\` guide or project overlay spec.

## Update Rule

Update this spec when changing:

- Unity version or package dependency assumptions.
- Directory layout under \`Assets/\`.
- Runtime/Foundation/Feature layering.
- Bootstrap entry scene or initialization order.
- asmdef reference direction.
- Editor vs Runtime code boundaries.
- Project-wide Unity C# conventions.

## Validation

Minimum validation when this area changes:

- Inspect \`ProjectSettings/ProjectVersion.txt\`.
- Inspect \`Packages/manifest.json\` / \`packages-lock.json\`.
- Inspect asmdef reference direction if C# assemblies changed.
- Run available C# compile / Unity batchmode / CI command if configured by the project.
- If Unity Editor validation is user-owned or unavailable, state the limitation and risk.
`,
  ".workflow/spec/modules/unity-assets.md": `# Unity Assets Spec

## Purpose

This document defines runtime asset roots, Editor/tool configuration boundaries, generated output boundaries, resource addressing, asset loading, asset lifetime, and validation rules.

It is intentionally generic Unity. Project-specific resource systems such as Addressables, YooAsset, custom AssetBundle tools, remote CDN rules or generated data pipelines must be documented only when detected by scanner or added by project overlay specs.

## Scope

Applies to:

- Runtime assets under \`Assets/**\`
- Scenes
- Prefabs
- UI assets
- Textures / Sprites
- Audio
- VFX / Particle / Animation assets
- Fonts
- Materials / Shaders
- Resource loading code
- Editor resource configuration
- Generated asset outputs if the project commits them

Does not define:

- Editor/build/packaging workflow.
- Runtime architecture and asmdef rules; see \`unity-project.md\`.

## Fact Sources

Primary facts:

- \`Assets/**\`
- Resource system config files if present
- Scene list / Build Settings if available
- Addressable / AssetBundle / custom collector settings if present
- Asset loading service/facade code
- Import settings and generated asset manifests

Detected by init-spec:

| Fact | Value |
|---|---|
| Runtime resource roots | \`{{runtime_resource_roots}}\` |
| Editor config roots | \`{{editor_config_roots}}\` |
| Generated output roots | \`{{generated_output_roots}}\` |
| Build output roots | \`{{build_output_roots}}\` |
| Resource system candidates | \`{{resource_system}}\` |

## Resource System Detection

This generic Unity spec does not assume Addressables, YooAsset, AssetBundle, Resources, StreamingAssets or a custom loader by default.

Rules:

- If \`com.unity.addressables\` is detected in \`Packages/manifest.json\`, Addressables may be recorded as a resource system candidate.
- If a custom resource package/config/loader is detected, record it as a candidate with evidence.
- If no known resource system is detected, keep rules generic and mark the resource system as \`TODO(init-spec)\`.
- Do not write Addressables/YooAsset/AssetBundle-specific rules unless project facts support them.

## Asset Lifetime Rules

- Temporary assets should be released after use.
- Owner-bound assets should be released on owner close/destroy.
- Cached assets need explicit invalidation or lifetime policy.
- Pooling must reset asset references and not carry dirty state between uses.

## Generated Output Rules

Project must classify generated outputs before editing them.

## Update Rule

Update this spec when changing runtime resource roots, resource address rules, asset loading, lifetime/release behavior, generated output policy, or shader/material/resource build dependencies.
`,
};
