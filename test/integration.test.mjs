import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ROOT } from "../src/storage.mjs";

test("真实本地服务完成四种任务、证据导出、访问隔离与重启恢复", { timeout: 180000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-integration-")),
    port = 22000 + Math.floor(Math.random() * 10000),
    base = `http://127.0.0.1:${port}`;
  let child;
  const start = async () => {
    child = spawn(process.execPath, ["src/server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), STUDIO_DATA_DIR: directory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", () => {});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("服务启动超时")), 10000);
      child.stdout.on("data", (data) => {
        if (data.toString().includes("已启动")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code) reject(new Error(`服务退出 ${code}`));
      });
    });
  };
  const stop = async () => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  };
  t.after(async () => {
    await stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await start();
  let boot = await (await fetch(`${base}/api/bootstrap`)).json();
  const request = async (route, data) => {
    const response = await fetch(base + route, {
      method: data ? "POST" : "GET",
      headers: { "X-Studio-Token": boot.token, "Content-Type": "application/json" },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  assert.equal((await fetch(`${base}/api/projects`)).status, 403);
  assert.equal(
    (await fetch(`${base}/api/bootstrap`, { headers: { Origin: "https://foreign.example" } }))
      .status,
    403,
  );
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(
      `${base}/api/bootstrap`,
      { headers: { Host: "foreign.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(foreignHostStatus, 403);
  const examples = boot.examples,
    ids = [];
  for (const mode of ["technology", "product", "delivery", "code"]) {
    const input = {
      mode,
      name: `真实验收 ${mode}`,
      target: examples.left,
      question: mode === "code" ? "calculatePrice" : "",
      ...(mode === "code" ? { rightTarget: examples.right } : {}),
      ...(mode === "delivery"
        ? {
            steps: [
              { name: "查询订单", risk: "low", hasRules: true, hasApi: true, system: "订单系统" },
              { name: "退款", risk: "high", hasRules: true, hasApi: true, system: "订单系统" },
            ],
          }
        : {}),
    };
    const created = await request("/api/projects", input);
    ids.push(created.id);
    let job;
    for (let n = 0; n < 250; n++) {
      job = await request(`/api/projects/${created.id}`);
      if (!["queued", "running", "cancelling"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(
      job.status,
      "completed",
      `${mode}: ${job.error || job.report?.limitations?.join(";")}`,
    );
    assert.ok(job.report.engine.connected);
    assert.ok(job.report.engine.evidenceId);
    assert.ok(job.report.evidence.length);
    if (mode === "delivery") assert.equal(job.report.delivery[1].decision, "人工确认");
    if (mode === "code") {
      assert.ok(job.report.changes.summary.functions >= 4);
      assert.ok(job.report.changes.engineEvidenceId);
      assert.ok(job.report.trace.matches.some((x) => x.name === "calculatePrice"));
    }
    const ev = job.report.evidence.find((e) => e.path === "service.js");
    const source = await request(`/api/projects/${created.id}/source?id=${ev.id}`);
    assert.ok(source.text.includes("createTicket"));
    const exported = await fetch(`${base}/api/projects/${created.id}/export?format=md`, {
      headers: { "X-Studio-Token": boot.token },
    });
    assert.ok((await exported.text()).includes("证据索引"));
  }
  const failed = await request("/api/projects", {
    mode: "technology",
    target: "/this/path/does/not/exist",
  });
  let bad;
  for (let n = 0; n < 30; n++) {
    bad = await request(`/api/projects/${failed.id}`);
    if (bad.status === "failed") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(bad.status, "failed");
  assert.ok(bad.error.includes("找不到"));
  const cancelled = await request("/api/projects", { mode: "product", target: examples.left });
  await request(`/api/projects/${cancelled.id}/cancel`, {});
  let stopped;
  for (let n = 0; n < 50; n++) {
    stopped = await request(`/api/projects/${cancelled.id}`);
    if (stopped.status === "cancelled") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(stopped.status, "cancelled");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "src/mcp.mjs")],
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port) },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "studio-acceptance", version: "1" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    const result = await client.callTool({
      name: "get_research",
      arguments: { id: ids[0], section: "summary" },
    });
    assert.equal(result.structuredContent.status, "completed");
    assert.ok(result.structuredContent.engine.evidenceId);
    const read = await client.callTool({
      name: "get_research",
      arguments: { id: ids[3], section: "functions", offset: 0, limit: 1 },
    });
    assert.equal(read.structuredContent.items.length, 1);
    assert.ok(read.structuredContent.nextOffset);
    const historyResult = await client.callTool({ name: "list_research", arguments: { limit: 2 } });
    assert.equal(historyResult.structuredContent.items.length, 2);
  } finally {
    await client.close();
    await transport.close();
  }
  await stop();
  await start();
  boot = await (await fetch(`${base}/api/bootstrap`)).json();
  const history = await request("/api/projects");
  assert.ok(ids.every((id) => history.some((item) => item.id === id)));
  assert.equal((await request(`/api/projects/${ids[0]}`)).status, "completed");
});
