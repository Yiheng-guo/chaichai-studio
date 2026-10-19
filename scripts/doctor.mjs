#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
export async function inspectEnvironment({
  root = defaultRoot,
  engineRoot = process.env.CHAICHAI_ROOT || path.resolve(root, "../chaichai-main"),
} = {}) {
  const checks = [];
  const add = (name, ok, detail, fix = "") => checks.push({ name, ok, detail, fix });
  const [major, minor] = process.versions.node.split(".").map(Number);
  add(
    "Node.js",
    major > 24 || (major === 24 && minor >= 15),
    process.versions.node,
    "安装 Node.js 24.15 或更新版本，再重新打开终端。",
  );
  try {
    const npm = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], {
      timeout: 10000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    add("npm", true, npm);
  } catch {
    add(
      "npm",
      false,
      "未找到可用的 npm。",
      "安装带有 npm 的 Node.js，并确认 npm --version 可以运行。",
    );
  }
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const require = createRequire(path.join(root, "package.json"));
    const missing = Object.keys(pkg.dependencies || {}).filter((name) => {
      try {
        require.resolve(name);
        return false;
      } catch {
        return true;
      }
    });
    add(
      "研究台依赖",
      !missing.length,
      missing.length ? `缺少：${missing.join("、")}` : "运行依赖可解析。",
      "在研究台目录执行 npm ci。",
    );
  } catch {
    add(
      "研究台依赖",
      false,
      "无法读取项目依赖。",
      "确认项目文件完整，在包含 package.json 的目录执行 npm ci。",
    );
  }
  const engine = path.resolve(engineRoot);
  const entry = path.join(engine, "scripts/rea.mjs");
  let exists = false;
  try {
    await fs.access(entry);
    exists = true;
  } catch {}
  add(
    "拆拆引擎目录",
    exists,
    exists ? engine : `未找到 ${entry}`,
    "按 README 准备相邻的 chaichai-main，或设置 CHAICHAI_ROOT 为原拆拆项目的绝对路径。",
  );
  if (exists) {
    try {
      const output = execFileSync(process.execPath, [entry, "providers", "--format", "json"], {
        cwd: engine,
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      JSON.parse(output);
      add("引擎启动", true, "providers 命令返回有效 JSON；基础引擎可调用。");
    } catch {
      add(
        "引擎启动",
        false,
        "引擎未能在 30 秒内返回有效 JSON。",
        "进入原拆拆目录，执行 HUSKY=0 npm ci 和 npm run build:cached；再用 node scripts/rea.mjs providers --format json 查看错误。",
      );
    }
  }
  return {
    ok: checks.every((c) => c.ok),
    checks,
    note: "检查不会安装或修改系统软件。基础引擎可启动不代表 Ghidra、Hopper 或 IDA 已可用；深度反编译需要另行配置与验证。",
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await inspectEnvironment();
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log("拆拆研究台 · 安装环境检查\n");
    for (const check of result.checks) {
      console.log(`${check.ok ? "通过" : "需处理"}｜${check.name}：${check.detail}`);
      if (!check.ok) console.log(`下一步：${check.fix}`);
    }
    console.log(
      `\n${result.ok ? "基础环境就绪，可以运行 npm start。" : "请处理以上问题，再运行 npm run doctor。"}\n${result.note}`,
    );
  }
  process.exitCode = result.ok ? 0 : 1;
}
