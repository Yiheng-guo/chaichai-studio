import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ROOT,
  DATA,
  id,
  jobDir,
  saveJob,
  loadJob,
  listJobs,
  recoverInterrupted,
} from "./storage.mjs";
import { engineHealth } from "./engine.mjs";
import { MODES, runAnalysis, reportMarkdown } from "./analysis.mjs";

const { version } = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
const port = Number(process.env.PORT || 5197),
  token = randomBytes(32).toString("hex");
const jobs = new Map(),
  queue = [],
  controllers = new Map(),
  writes = new Map();
let active = false,
  closing = false;
const persist = (job) => {
  const prior = writes.get(job.id) || Promise.resolve();
  const next = prior.catch(() => {}).then(() => saveJob(job));
  writes.set(job.id, next);
  return next;
};
function safeToken(value) {
  if (typeof value !== "string" || value.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(token));
}
const send = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
async function body(req) {
  let bytes = 0;
  const buffers = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error("请求内容超过 1 MB");
    buffers.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(buffers).toString("utf8"));
  } catch {
    throw new Error("请求内容不是有效 JSON");
  }
}
function validate(input) {
  if (!input || !Object.hasOwn(MODES, input.mode)) throw new Error("请选择有效的任务类型");
  const target = typeof input.target === "string" ? input.target.trim() : "";
  if (!target || target.length > 4096) throw new Error("请填写目标路径或 HTTPS 地址");
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (steps.length > 40) throw new Error("单个项目最多评估 40 项业务任务");
  for (const step of steps)
    if (
      !step ||
      typeof step.name !== "string" ||
      !step.name.trim() ||
      step.name.length > 200 ||
      !["low", "medium", "high"].includes(step.risk) ||
      typeof step.hasRules !== "boolean" ||
      typeof step.hasApi !== "boolean" ||
      typeof step.system !== "string" ||
      step.system.length > 200
    )
      throw new Error("请检查任务名称、风险、规则和接口条件");
  if (input.mode === "delivery" && !steps.length)
    throw new Error("请至少填写一项真实业务任务，或加载公开示例");
  if (input.rightTarget && typeof input.rightTarget !== "string")
    throw new Error("新版本目标格式不正确");
  if (
    String(input.rightTarget || "").length > 4096 ||
    String(input.question || "").length > 2000 ||
    String(input.name || "").length > 150
  )
    throw new Error("目标或问题内容过长");
  return {
    mode: input.mode,
    target,
    name: String(input.name || `${MODES[input.mode]} · ${path.basename(target)}`).trim(),
    rightTarget: String(input.rightTarget || "").trim(),
    question: String(input.question || "").trim(),
    steps: steps.map((s) => ({ ...s, name: s.name.trim(), system: s.system.trim() })),
  };
}
async function pump() {
  if (active || closing || !queue.length) return;
  active = true;
  const job = queue.shift(),
    controller = new AbortController();
  controllers.set(job.id, controller);
  const progress = async (percent, message) => {
    if (controller.signal.aborted) throw new Error("任务已取消");
    job.progress = { percent, message };
    job.updatedAt = new Date().toISOString();
    job.timeline.push({ ...job.progress, at: job.updatedAt });
    await persist(job);
  };
  try {
    job.status = "running";
    await progress(2, "准备研究任务");
    const report = await runAnalysis(job, { signal: controller.signal, progress });
    if (controller.signal.aborted) throw new Error("任务已取消");
    job.report = report;
    job.status = report.coverage.status === "partial" ? "partial" : "completed";
    job.progress = {
      percent: 100,
      message:
        job.status === "partial" ? "研究结果已保存，部分分析范围受限" : "研究完成，证据已保存",
    };
  } catch (error) {
    job.status = controller.signal.aborted ? "cancelled" : "failed";
    job.error = controller.signal.aborted
      ? "任务已取消；已生成的输入快照和原始证据仍保留。"
      : error.message;
    job.progress = { ...job.progress, message: job.error };
  } finally {
    job.updatedAt = new Date().toISOString();
    await persist(job).catch(() => {});
    controllers.delete(job.id);
    active = false;
    void pump();
  }
}
function download(res, filename, type, text) {
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
  });
  res.end(text);
}
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(req.headers.host)) {
    return send(res, 403, { error: "仅允许本机访问" });
  }
  if (
    req.headers.origin &&
    !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(req.headers.origin)
  ) {
    return send(res, 403, { error: "不接受其他网页发起的请求" });
  }
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/api/bootstrap" && req.method === "GET") {
      if (req.headers["sec-fetch-site"] === "cross-site")
        return send(res, 403, { error: "仅允许从本机工作台获取会话" });
      return send(res, 200, {
        token,
        version,
        examples: {
          left: path.join(ROOT, "examples/service-v1"),
          right: path.join(ROOT, "examples/service-v2"),
          native: "/System/Applications/Calculator.app",
        },
      });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!safeToken(req.headers["x-studio-token"]))
        return send(res, 403, { error: "本机会话已失效，请刷新页面" });
      if (url.pathname === "/api/health" && req.method === "GET")
        return send(
          res,
          200,
          await engineHealth({ refresh: url.searchParams.get("refresh") === "1" }),
        );
      if (url.pathname === "/api/projects" && req.method === "GET")
        return send(res, 200, await listJobs());
      if (url.pathname === "/api/projects" && req.method === "POST") {
        if (queue.length >= 8) return send(res, 429, { error: "已有较多任务排队，请稍后再试" });
        const input = validate(await body(req)),
          now = new Date().toISOString();
        const job = {
          ...input,
          id: id(),
          createdAt: now,
          updatedAt: now,
          status: "queued",
          progress: { percent: 0, message: "等待开始" },
          timeline: [],
        };
        jobs.set(job.id, job);
        await persist(job);
        queue.push(job);
        void pump();
        return send(res, 202, { id: job.id });
      }
      const match = url.pathname.match(
        /^\/api\/projects\/([0-9a-f-]{36})(?:\/(cancel|export|source|raw))?$/,
      );
      if (match) {
        const [, jobId, action] = match;
        const job = jobs.get(jobId) || (await loadJob(jobId).catch(() => null));
        if (!job) return send(res, 404, { error: "没有找到这个研究项目" });
        if (action === "cancel" && req.method === "POST") {
          if (job.status === "queued") {
            const i = queue.findIndex((x) => x.id === jobId);
            if (i >= 0) queue.splice(i, 1);
            job.status = "cancelled";
            job.error = "任务在执行前取消";
            await persist(job);
          } else if (job.status === "running") {
            job.status = "cancelling";
            controllers.get(jobId)?.abort();
            await persist(job);
          }
          return send(res, 200, { status: job.status });
        }
        if (action === "export" && req.method === "GET") {
          if (!job.report) return send(res, 409, { error: "报告尚未生成" });
          if (url.searchParams.get("format") === "md")
            return download(
              res,
              `${job.name}.md`,
              "text/markdown; charset=utf-8",
              reportMarkdown(job.report),
            );
          return download(
            res,
            `${job.name}.json`,
            "application/json; charset=utf-8",
            JSON.stringify({ schema: "chaichai-studio-report-v1", project: job }, null, 2),
          );
        }
        if (action === "source" && req.method === "GET") {
          const evidence = job.report?.evidence.find((e) => e.id === url.searchParams.get("id"));
          if (!evidence || ["native", "engine", "user"].includes(evidence.kind))
            return send(res, 404, { error: "该证据没有文本快照，可查看原始证据或填写记录" });
          const source = path.resolve(
            jobDir(jobId),
            evidence.side === "right" ? "right-snapshot" : "snapshot",
            evidence.path,
          );
          const base = path.resolve(
            jobDir(jobId),
            evidence.side === "right" ? "right-snapshot" : "snapshot",
          );
          if (!source.startsWith(base + path.sep)) return send(res, 403, { error: "无效快照路径" });
          return send(res, 200, {
            text: await fs.readFile(source, "utf8"),
            path: evidence.path,
            line: evidence.line,
            sha256: evidence.sha256,
          });
        }
        if (action === "raw" && req.method === "GET") {
          const file = url.searchParams.get("file");
          if (!job.report?.engine.files.includes(file) || path.basename(file) !== file)
            return send(res, 404, { error: "没有找到这份原始证据" });
          return download(
            res,
            file,
            "application/json; charset=utf-8",
            await fs.readFile(path.join(jobDir(jobId), "engine", file), "utf8"),
          );
        }
        if (!action && req.method === "GET") return send(res, 200, job);
      }
      return send(res, 404, { error: "找不到这个操作" });
    }
    if (req.method !== "GET") return send(res, 405, { error: "不支持的请求方式" });
    const allowed = {
      "/": "index.html",
      "/index.html": "index.html",
      "/app.js": "app.js",
      "/style.css": "style.css",
    };
    if (!allowed[url.pathname]) return send(res, 404, { error: "页面不存在" });
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.writeHead(200, {
      "Content-Type": url.pathname.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : url.pathname.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(await fs.readFile(path.join(ROOT, "public", allowed[url.pathname])));
  } catch (error) {
    send(res, 400, { error: error.message || "操作未完成" });
  }
});
await fs.mkdir(DATA, { recursive: true, mode: 0o700 });
await recoverInterrupted();
server.listen(port, "127.0.0.1", () =>
  console.log(
    `拆拆研究台 v${version} 已启动：http://127.0.0.1:${port}\n研究记录只保存在本机，不会随代码发布上传。`,
  ),
);
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `端口 ${port} 已被占用，可设置 PORT 使用其他端口。`
      : error.message,
  );
  process.exitCode = 1;
});
async function shutdown() {
  if (closing) return;
  closing = true;
  for (const controller of controllers.values()) controller.abort();
  server.close();
  await Promise.allSettled([...writes.values()]);
  const timer = setTimeout(() => process.exit(0), 4000);
  timer.unref();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
