# Unity Assets Spec

## Purpose

This document defines runtime asset roots, Editor/tool configuration boundaries, generated output boundaries, resource addressing, asset loading, asset lifetime, and validation rules.

It is intentionally generic Unity. Project-specific resource systems such as Addressables, YooAsset, custom AssetBundle tools, remote CDN rules or generated data pipelines must be documented only when detected by scanner or added by project overlay specs.

## Scope

Applies to:

- Runtime assets under `Assets/**`
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
- Runtime architecture and asmdef rules; see `unity-project.md`.

## Fact Sources

Primary facts:

- `Assets/**`
- Resource system config files if present
- Scene list / Build Settings if available
- Addressable / AssetBundle / custom collector settings if present
- Asset loading service/facade code
- Import settings and generated asset manifests

Detected by init-spec:

| Fact | Value |
|---|---|
| Runtime resource roots | `{{runtime_resource_roots}}` |
| Editor config roots | `{{editor_config_roots}}` |
| Generated output roots | `{{generated_output_roots}}` |
| Build output roots | `{{build_output_roots}}` |
| Resource system candidates | `{{resource_system}}` |

## Resource System Detection

This generic Unity spec does not assume Addressables, YooAsset, AssetBundle, Resources, StreamingAssets or a custom loader by default.

Rules:

- If `com.unity.addressables` is detected in `Packages/manifest.json`, Addressables may be recorded as a resource system candidate.
- If a custom resource package/config/loader is detected, record it as a candidate with evidence.
- If no known resource system is detected, keep rules generic and mark the resource system as `TODO(init-spec)`.
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
