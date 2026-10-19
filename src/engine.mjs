import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "./storage.mjs";
import { resolveEngineRoot } from "./engine-root.mjs";

export const engineRoot = resolveEngineRoot(ROOT);
const executable = path.join(engineRoot, "scripts/rea.mjs");
const permitted = new Set([
  "providers",
  "analyze-javascript-application",
  "trace-application-feature",
  "compare-application-versions",
  "inspect-plist",
  "inspect-macho",
  "list-architectures",
  "inspect-binary-layout",
  "function",
]);
export async function callEngine(
  command,
  args = [],
  { signal, directory, stem = command, timeout = 120000 } = {},
) {
  if (!permitted.has(command)) throw new Error("未授权的分析操作");
  await fs.access(executable).catch(() => {
    throw new Error("没有找到拆拆引擎。请设置 CHAICHAI_ROOT 指向已构建的原项目。");
  });
  if (signal?.aborted) throw new Error("任务已取消");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, command, ...args, "--format", "json"], {
      cwd: engineRoot,
      shell: false,
      detached: process.platform !== "win32",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(PATH|HOME|TMPDIR|LANG|LC_|REA_|GHIDRA_|HOPPER_)/.test(key),
        ),
      ),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let size = 0,
      stderr = "",
      chunks = [],
      failure,
      killTimer;
    const kill = () => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
    };
    const stop = (error) => {
      if (failure) return;
      failure = error;
      kill();
      killTimer = setTimeout(() => {
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      }, 2000);
      killTimer.unref();
    };
    const abort = () => stop(new Error("任务已取消"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop(new Error("拆拆分析超过时间限制；任务未被标记为成功，可缩小输入范围后重试。")),
      timeout,
    );
    child.stdout.on("data", (buffer) => {
      size += buffer.length;
      if (size > 64 * 1024 * 1024)
        stop(new Error("分析证据超过 64 MB，已停止接收。请缩小分析范围。"));
      else chunks.push(buffer);
    });
    child.stderr.on("data", (buffer) => {
      stderr = (stderr + buffer.toString()).slice(-32000);
    });
    child.once("error", (error) => stop(error));
    child.once("close", async (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      try {
        if (failure) throw failure;
        const text = Buffer.concat(chunks).toString("utf8");
        let result;
        try {
          result = JSON.parse(text);
        } catch {
          throw new Error(`拆拆未返回有效分析结果（退出码 ${code}）。请检查引擎构建和依赖。`);
        }
        if (directory) {
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          await fs.writeFile(path.join(directory, `${stem}.json`), text, { mode: 0o600 });
        }
        if (code !== 0 || result.error)
          throw new Error(
            `拆拆分析未完成：${result.error?.message || stderr.slice(-600) || `退出码 ${code}`}`,
          );
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
let healthCache;
export async function engineHealth({ refresh = false } = {}) {
  if (!refresh && healthCache && Date.now() - healthCache.at < 30000) return healthCache.value;
  let value;
  try {
    const result = await callEngine("providers", [], { timeout: 15000 });
    value = {
      ready: true,
      version: result.server_identity?.package?.version,
      root: engineRoot,
      tools: result.server_identity?.catalog?.counts?.mcp_tools,
      providers: (result.analysis_provider_candidates || []).map((p) => ({
        id: p.provider.id,
        name: p.provider.name,
        available: p.availability.status === "available",
        reason: p.availability.reason,
      })),
      note: "引擎可调用不等于每个深度分析器已就绪；本次基础分析不执行目标程序。",
    };
  } catch (error) {
    value = { ready: false, root: engineRoot, error: error.message, providers: [] };
  }
  healthCache = { at: Date.now(), value };
  return value;
}
