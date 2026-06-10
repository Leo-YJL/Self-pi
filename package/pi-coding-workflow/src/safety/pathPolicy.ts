import { relative, resolve, sep } from "node:path";

export function normalizeSlash(path: string): string {
  return path.replace(/\\/g, "/");
}

export function repoRelative(root: string, absolutePath: string): string {
  return normalizeSlash(relative(resolve(root), resolve(absolutePath)) || ".");
}

export function isInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(root, target);
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`) && !resolve(rel).startsWith(".."));
}

export function resolveInsideRoot(root: string, target: string): string {
  if (!isInsideRoot(root, target)) {
    throw new Error(`Path escapes project root: ${target}`);
  }
  return resolve(root, target);
}

export function assertRepoRelative(path: string): void {
  if (!path || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]+/).includes("..")) {
    throw new Error(`Expected repo-relative path inside project root: ${path}`);
  }
}
