import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectTarget, htmlFacts, isPrivateAddress } from "../src/collect.mjs";
import { extractFacts, explainFunction } from "../src/facts.mjs";
import { assessTasks, compareFacts, reportMarkdown } from "../src/analysis.mjs";
import { ROOT, hash, jobDir } from "../src/storage.mjs";

test("真实示例提取页面、函数、接口与分支，不将栏目当成已实现功能", async () => {
  const collection = await collectTarget(path.join(ROOT, "examples/service-v1"));
  const facts = extractFacts(collection);
  assert.ok(facts.tech.some((t) => t.name === "Express HTTP 服务"));
  assert.ok(facts.features.some((f) => f.name === "创建工单" && f.detail.includes("需要运行验证")));
  assert.ok(facts.apis.some((api) => api.endpoint === "/api/tickets" && api.method === "POST"));
  const fn = facts.functions.find((f) => f.name === "createTicket");
  assert.equal(fn.async, true);
  assert.ok(fn.conditions.length);
  assert.ok(fn.calls.includes("fetch"));
  assert.ok(explainFunction(fn).includes("异步函数"));
  for (const item of [...facts.tech, ...facts.features, ...facts.apis, ...facts.functions])
    for (const id of item.evidence) assert.ok(facts.evidence.some((e) => e.id === id));
});

test("版本比较定位价格规则、工单错误处理与新增质检函数", async () => {
  const left = await collectTarget(path.join(ROOT, "examples/service-v1"));
  const right = await collectTarget(path.join(ROOT, "examples/service-v2"));
  const result = compareFacts(left, right);
  assert.equal(result.summary.changed, 3);
  assert.ok(
    result.functions.some(
      (f) =>
        f.name === "calculatePrice" &&
        f.status === "changed" &&
        f.after.params.includes("discount"),
    ),
  );
  assert.ok(result.functions.some((f) => f.name === "checkAnswer" && f.status === "added"));
  assert.ok(
    result.files
      .find((f) => f.path === "service.js")
      .diff.some((p) => p.type === "add" && p.text.includes("response.ok")),
  );
});

test("相同内容的两个快照不产生版本变化", async () => {
  const value = await collectTarget(path.join(ROOT, "examples/service-v1"));
  assert.equal(compareFacts(value, value).files.length, 0);
});

test("高风险任务始终人工确认，未知规则不能自动接管", () => {
  const steps = [
    { name: "退款", risk: "high", hasRules: true, hasApi: true, system: "订单" },
    { name: "常见咨询", risk: "low", hasRules: true, hasApi: true, system: "知识库" },
    { name: "自由承诺", risk: "low", hasRules: false, hasApi: true, system: "" },
  ];
  const r = assessTasks(steps);
  assert.equal(r[0].decision, "人工确认");
  assert.equal(r[1].decision, "可做自动处理试点");
  assert.equal(r[2].decision, "先补规则");
  assert.ok(r[1].reason.includes("权限"));
  assert.ok(r.every((x) => x.authority === "inference"));
});

test("公网采集拒绝内网、回环、保留和 IPv4 映射地址", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.2",
    "192.168.3.2",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ])
    assert.equal(isPrivateAddress(address), true, address);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("本地扫描不读取符号链接和隐藏文件，容量遗漏保持可见", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-collection-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "app.js"), "export const x = 1;");
  await fs.writeFile(path.join(dir, ".env"), "token=private");
  await fs.writeFile(path.join(dir, "large.js"), "x".repeat(600000));
  await fs.symlink(path.join(dir, "app.js"), path.join(dir, "link.js"));
  const c = await collectTarget(dir);
  assert.deepEqual(
    c.files.map((f) => f.path),
    ["app.js"],
  );
  assert.ok(c.omissions.some((x) => x.includes("符号链接")));
  assert.ok(c.omissions.some((x) => x.includes("512 KB")));
});

test("嵌套回调不被错误归为外层函数的分支或返回", () => {
  const text = "function outer(){ items.map(x => { if(x) return x; }); return 2; }";
  const facts = extractFacts({
    files: [{ path: "nested.js", origin: "nested.js", text, sha256: hash(text) }],
  });
  const fn = facts.functions.find((f) => f.name === "outer");
  assert.equal(fn.conditions.length, 0);
  assert.deepEqual(fn.returns, ["2"]);
});

test("HTML 内容作为资料解析，不执行脚本；行号和控件保留", () => {
  const f = htmlFacts(
    '<h1>产品</h1>\n<button id="x">提交</button><script>throw new Error("不要执行")</script>',
  );
  assert.equal(f.headings[0].text, "产品");
  assert.equal(f.controls[0].line, 2);
  assert.equal(f.scripts.length, 1);
});

test("路径编号拒绝目录穿越", () => {
  assert.throws(() => jobDir("../../private"));
});
