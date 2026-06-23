import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeInitWorkspace } from "../src/init/initWorkspace.ts";
import { workflowRun } from "../src/engine/run.ts";
import { workflowNext } from "../src/engine/route.ts";

async function setupRagFixture(): Promise<{ root: string; task: string }> {
  const root = await mkdtemp(join(tmpdir(), "pcw-rag-phase1-"));
  await executeInitWorkspace(root, "generic");
  await mkdir(join(root, ".workflow/spec/modules"), { recursive: true });
  await writeFile(join(root, ".workflow/spec/modules/workflow-memory.md"), `# Workflow Memory Retrieval\n\n## Local Lexical Policy\n\nUse local lexical workflow memory retrieval before asking questions already answered by spec.\n`, "utf8");
  const create = await workflowRun(root, { action: "create_from_grill", mode: "execute", title: "Workflow Memory Retrieval", level: "standard", slug: `rag-${Math.random().toString(16).slice(2)}` });
  return { root, task: create.task! };
}

async function enableRag(root: string): Promise<void> {
  const configPath = join(root, ".workflow/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.rag = {
    ...(config.rag ?? {}),
    enabled: true,
    mode: "lexical",
    retrieval: { topK: 8, maxReturnedRefs: 5, maxPreviewChars: 160, minScore: 0.05, writeQueryArtifact: true },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

test("RAG Phase 1 is disabled by default and can build a lexical JSONL index", async () => {
  const { root } = await setupRagFixture();

  const disabled = await workflowNext(root, { includeContext: "signal" });
  assert.equal(disabled.retrieval, undefined, "RAG should not affect workflow_next unless config enables it");

  await enableRag(root);
  const missing = await workflowRun(root, { action: "rag_status", detail: "full" });
  assert.equal(missing.ok, true);
  assert.equal((missing.preflight as any).indexState, "missing");

  const dryRun = await workflowRun(root, { action: "rag_reindex", mode: "dry_run", detail: "full" });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.mutated, false);
  assert.ok(((dryRun.preflight as any).chunkCount ?? 0) > 0);
  assert.equal(existsSync(join(root, ".workflow/.runtime/rag/chunks.jsonl")), false, "dry-run must not write chunks");

  const executed = await workflowRun(root, { action: "rag_reindex", mode: "execute", detail: "full" });
  assert.equal(executed.ok, true);
  assert.equal(executed.mutated, true);
  assert.ok(existsSync(join(root, ".workflow/.runtime/rag/chunks.jsonl")));
  assert.ok(existsSync(join(root, ".workflow/.runtime/rag/index.json")));
  assert.ok(executed.artifacts?.some((artifact) => artifact.kind === "rag-index"));

  const chunks = await readFile(join(root, ".workflow/.runtime/rag/chunks.jsonl"), "utf8");
  assert.match(chunks, /Workflow Memory Retrieval/);
  assert.match(chunks, /Local Lexical Policy/);

  const status = await workflowRun(root, { action: "rag_status", detail: "full" });
  assert.equal((status.preflight as any).indexState, "fresh");
  assert.ok(((status.preflight as any).chunkCount ?? 0) > 0);
});

test("workflow_next returns compact lexical retrieval refs when RAG is enabled", async () => {
  const { root, task } = await setupRagFixture();
  await enableRag(root);
  await workflowRun(root, { action: "rag_reindex", mode: "execute" });

  const next = await workflowNext(root, { task, includeContext: "signal" });
  assert.equal(next.retrieval?.enabled, true);
  assert.equal(next.retrieval?.mode, "lexical");
  assert.equal(next.retrieval?.indexState, "fresh");
  assert.ok((next.retrieval?.topRefs.length ?? 0) > 0, "expected at least one retrieval ref");
  assert.ok(next.retrieval?.queryRef?.startsWith(".workflow/.runtime/rag/queries/"));

  const first = next.retrieval!.topRefs[0] as any;
  assert.equal(first.content, undefined, "workflow_next should return refs/previews, not full chunk content");
  assert.ok(typeof first.ref === "string" && first.ref.length > 0);
  assert.ok(typeof first.score === "number" && first.score > 0);

  const artifact = JSON.parse(await readFile(join(root, next.retrieval!.queryRef!), "utf8"));
  assert.equal(artifact.kind, "pi-coding-workflow.rag-query");
  assert.ok(Array.isArray(artifact.hits));
});
