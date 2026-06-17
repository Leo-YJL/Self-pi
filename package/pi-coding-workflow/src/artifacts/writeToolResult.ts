import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { normalizeSlash, resolveInsideRoot } from "../safety/pathPolicy.ts";

export interface ArtifactWriteResult {
  artifactRef: string;
  absolutePath: string;
}

export function stableShortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 10);
}

export async function writeJsonArtifact(root: string, category: string, payload: unknown, id?: string): Promise<ArtifactWriteResult> {
  const safeCategory = category.replace(/[^a-zA-Z0-9_-]/g, "-");
  const artifactId = id ?? `${Date.now()}-${stableShortHash(payload)}-${randomBytes(3).toString("hex")}`;
  const artifactRef = normalizeSlash(`.workflow/.runtime/${safeCategory}/${artifactId}.json`);
  const absolutePath = resolveInsideRoot(root, artifactRef);
  // When a caller passes an explicit (deterministic) id, a file with that id is by
  // construction the same content — skip the rewrite to avoid duplicate I/O and
  // artifact accumulation across repeated identical calls (e.g. workflow_next signal).
  if (id && existsSync(absolutePath)) return { artifactRef, absolutePath };
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { artifactRef, absolutePath };
}
