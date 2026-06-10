import type { ProfileName } from "../types.ts";
import { createInitSpecPlan, executeInitSpecPlan, writeInitSpecPlan } from "./specPlan.ts";

export async function initSpecDryRun(root: string, profile: ProfileName): Promise<{ ok: boolean; planId: string; artifactRef: string; plan: unknown }> {
  const plan = await createInitSpecPlan(root, profile);
  const artifactRef = await writeInitSpecPlan(root, plan);
  return { ok: true, planId: plan.planId, artifactRef, plan };
}

export async function initSpecExecute(root: string, planId: string, answers: Record<string, string> = {}, allowModify = false) {
  return executeInitSpecPlan(root, planId, answers, allowModify);
}
