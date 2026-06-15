import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { InitSpecPlan, PlanOperation, ProfileName } from "../types.ts";
import { resolveInsideRoot } from "../safety/pathPolicy.ts";
import { renderTemplate } from "../templates/renderTemplate.ts";
import { scanUnityProject } from "./unityScanner.ts";
import { GENERIC_TEMPLATES, UNITY_TEMPLATES } from "./templateCatalog.ts";
import { PACKAGE_VERSION } from "../version.ts";

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function makePlanId(): string {
  const d = new Date();
  const yyyymmdd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `spec-plan-${yyyymmdd}-${randomBytes(4).toString("hex")}`;
}

function variablesFromFacts(profile: ProfileName, facts: Record<string, unknown>): Record<string, unknown> {
  const unity = (facts.unity ?? {}) as any;
  return {
    project_name: "Project",
    profile,
    unity_version: unity.version,
    assets_root: "Assets",
    packages_manifest: "Packages/manifest.json",
    project_settings_root: "ProjectSettings",
    first_scene: unity.entryScene?.path,
    bootstrap_entry: unity.bootstrap?.candidates?.[0]?.path,
    resource_system: unity.resources?.systems?.map((system: any) => system.name).join(", "),
    runtime_assembly_names: unity.assemblies?.runtime?.map((asm: any) => asm.name).join(", "),
    editor_assembly_names: unity.assemblies?.editor?.map((asm: any) => asm.name).join(", "),
    runtime_resource_roots: unity.resources?.roots?.map((r: any) => r.path).join(", "),
    editor_config_roots: unity.resources?.roots?.filter((r: any) => String(r.type).includes("config")).map((r: any) => r.path).join(", "),
    generated_output_roots: unity.generated?.candidates?.map((g: any) => g.path).join(", "),
    build_output_roots: "TODO(init-spec)",
  };
}

const PROFILE_TEMPLATE_MAP: Record<ProfileName, Record<string, string>> = {
  generic: GENERIC_TEMPLATES,
  unity: { ...GENERIC_TEMPLATES, ...UNITY_TEMPLATES },
};

export async function createInitSpecPlan(root: string, profile: ProfileName): Promise<InitSpecPlan> {
  const selectedTemplates = PROFILE_TEMPLATE_MAP[profile];
  if (!selectedTemplates) throw new Error(`Unsupported profile: ${profile}`);

  const scan = profile === "unity" ? await scanUnityProject(root) : null;
  const facts = scan?.facts ?? { generic: { profile } };
  const variables = variablesFromFacts(profile, facts);
  const operations: PlanOperation[] = [];

  for (const [path, template] of Object.entries(selectedTemplates)) {
    const rendered = renderTemplate(template, variables);
    const exists = existsSync(resolveInsideRoot(root, path));
    operations.push({
      op: exists ? "skip" : "create",
      path,
      template: profile === "unity" && path.includes("unity-") ? `spec-unity/${path.replace(".workflow/spec/", "")}` : `spec-generic/${path.replace(".workflow/spec/", "")}`,
      contentHash: sha256(rendered),
      required: true,
      risk: "low",
      reason: exists ? "Spec file already exists; first version does not overwrite it." : `Create ${profile} spec file.`,
      preview: rendered.split(/\r?\n/).slice(0, 12).join("\n"),
    });
  }

  return {
    schemaVersion: 1,
    kind: "workflow-init-spec-plan",
    planId: makePlanId(),
    createdAt: new Date().toISOString(),
    package: { name: "pi-coding-workflow", version: PACKAGE_VERSION },
    project: { root, name: "Project", detectedProfiles: profile === "unity" && (scan?.confidence ?? 0) >= 0.75 ? ["unity"] : [profile], selectedProfile: profile, confidence: scan?.confidence ?? 1 },
    scan: { signals: scan?.signals ?? [], summary: scan ? `Unity confidence ${scan.confidence.toFixed(2)}` : "Generic profile selected." },
    facts,
    operations,
    questions: scan?.questions ?? [],
    assumptions: scan?.assumptions ?? [],
    blockedBy: (scan?.questions ?? []).filter((q) => q.severity === "blocking").map((q) => q.id),
    summary: {
      willCreate: operations.filter((op) => op.op === "create").length,
      willModify: operations.filter((op) => op.op === "modify").length,
      willSkip: operations.filter((op) => op.op === "skip").length,
      blocked: (scan?.questions ?? []).some((q) => q.severity === "blocking"),
    },
  };
}

export async function writeInitSpecPlan(root: string, plan: InitSpecPlan): Promise<string> {
  const ref = `.workflow/.runtime/init-spec/${plan.planId}.json`;
  const abs = resolveInsideRoot(root, ref);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return ref;
}

export async function readInitSpecPlan(root: string, planId: string): Promise<InitSpecPlan> {
  const abs = resolveInsideRoot(root, `.workflow/.runtime/init-spec/${planId}.json`);
  return JSON.parse(await readFile(abs, "utf8")) as InitSpecPlan;
}

export async function executeInitSpecPlan(root: string, planId: string, answers: Record<string, string> = {}, allowModify = false): Promise<{ ok: boolean; planId: string; created: string[]; modified: string[]; skipped: string[]; blockedBy: string[]; summary: string }> {
  const plan = await readInitSpecPlan(root, planId);
  const missingBlockers = plan.questions.filter((q) => q.severity === "blocking" && !answers[q.id]).map((q) => q.id);
  if (missingBlockers.length > 0) {
    return { ok: false, planId, created: [], modified: [], skipped: [], blockedBy: missingBlockers, summary: "Blocking questions require answers before execute." };
  }

  const created: string[] = [];
  const modified: string[] = [];
  const skipped: string[] = [];
  const variables = variablesFromFacts(plan.project.selectedProfile, plan.facts);
  const templateMap = PROFILE_TEMPLATE_MAP[plan.project.selectedProfile];

  for (const op of plan.operations) {
    const abs = resolveInsideRoot(root, op.path);
    if (op.op === "skip") {
      skipped.push(op.path);
      continue;
    }
    if (op.op === "modify" && !allowModify) {
      skipped.push(op.path);
      continue;
    }
    if (existsSync(abs) && op.op === "create") {
      skipped.push(op.path);
      continue;
    }
    const template = templateMap[op.path];
    if (!template) throw new Error(`No template for operation path: ${op.path}`);
    const rendered = renderTemplate(template, variables);
    if (op.contentHash && sha256(rendered) !== op.contentHash) throw new Error(`Template content hash mismatch for ${op.path}`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, `${rendered.replace(/\s+$/g, "")}\n`, "utf8");
    if (op.op === "modify") modified.push(op.path);
    else created.push(op.path);
  }
  return { ok: true, planId, created, modified, skipped, blockedBy: [], summary: `Created ${created.length} spec files.` };
}
