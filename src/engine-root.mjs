import { existsSync } from "node:fs";
import path from "node:path";

/** Explicit selection wins; prefer the maintained engine, then the legacy directory. */
export function resolveEngineRoot(root, selected = process.env.CHAICHAI_ROOT) {
  if (selected) return path.resolve(selected);
  const maintained = path.resolve(root, "../chaichai-engine");
  return existsSync(maintained) ? maintained : path.resolve(root, "../chaichai-main");
}
