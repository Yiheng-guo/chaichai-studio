import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectEnvironment } from "../scripts/doctor.mjs";
import { resolveEngineRoot } from "../src/engine-root.mjs";

test("选择引擎时遵守显式配置，优先维护分支，并兼容旧目录", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "studio-engine-selection-"));
  const root = path.join(parent, "studio");
  try {
    assert.equal(resolveEngineRoot(root, ""), path.join(parent, "chaichai-main"));
    await fs.mkdir(path.join(parent, "chaichai-engine"));
    assert.equal(resolveEngineRoot(root, ""), path.join(parent, "chaichai-engine"));
    const selected = path.join(parent, "chosen-engine");
    assert.equal(resolveEngineRoot(root, selected), selected);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("安装检查指出缺失依赖与引擎，并且不创建或安装文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-doctor-"));
  try {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "studio-missing-dependency-2026": "1" } }),
    );
    const before = await fs.readdir(root);
    const result = await inspectEnvironment({
      root,
      engineRoot: path.join(root, "missing-engine"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((c) => c.name === "研究台依赖").ok, false);
    assert.match(result.checks.find((c) => c.name === "研究台依赖").fix, /npm ci/);
    assert.equal(result.checks.find((c) => c.name === "拆拆引擎目录").ok, false);
    assert.deepEqual(await fs.readdir(root), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("存在引擎入口但未构建时不能误报环境就绪", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-doctor-"));
  try {
    await fs.writeFile(path.join(root, "package.json"), '{"dependencies":{}}');
    await fs.mkdir(path.join(root, "scripts"));
    await fs.writeFile(path.join(root, "scripts/rea.mjs"), "process.exit(1);");
    const result = await inspectEnvironment({ root, engineRoot: root });
    assert.equal(result.ok, false);
    assert.equal(result.checks.find((c) => c.name === "拆拆引擎目录").ok, true);
    assert.equal(result.checks.find((c) => c.name === "引擎启动").ok, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
