import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MODEL,
  modelPacket,
  modelArguments,
  interpretReport,
  validateInterpretation,
} from "../src/model.mjs";
const report = {
  mode: "code",
  summary: "价格计算",
  evidence: [{ id: "price", path: "service.js", line: 1, quote: "return n*p" }],
  functions: [],
  limitations: [],
};
const answer = {
  summary: "按数量和单价计算金额。",
  findings: [{ claim: "数量乘单价。", evidence_ids: ["price"] }],
  recommendations: ["验证负数输入"],
  unknowns: ["未执行函数"],
};
async function fixture(t, source) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "studio-fake-codex-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const filename = path.join(folder, "codex.mjs");
  await fs.writeFile(filename, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return filename;
}
test("发送资料完整可解析且限额为 32 KB，不包含整个研究记录", () => {
  const packet = modelPacket({
    ...report,
    evidence: Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, quote: "中文".repeat(1000) })),
    functions: Array.from({ length: 100 }, () => ({ name: "f", code: "x".repeat(10000) })),
    secret: "不应发送",
    engine: { raw: "不应发送" },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 32000);
  assert.ok(packet.omitted > 0);
  assert.equal(packet.secret, undefined);
  assert.equal(packet.engine, undefined);
});
test("拒绝模型伪造证据编号", () => {
  assert.throws(
    () =>
      validateInterpretation(
        { ...answer, findings: [{ claim: "未知", evidence_ids: ["invented"] }] },
        modelPacket(report),
      ),
    /未发送/,
  );
});
test("版本研究优先带上相关函数的新旧证据，不被前置无关记录挤掉", () => {
  const packet = modelPacket({
    ...report,
    evidence: [
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `noise${i}`,
        path: "other.js",
        line: i,
        quote: "other",
      })),
      { id: "old", path: "price.js", line: 1, side: "left", quote: "return n*p" },
      { id: "new", path: "price.js", line: 2, side: "right", quote: "return n*p-discount" },
    ],
    changes: {
      functions: [
        {
          name: "price",
          path: "price.js",
          before: { line: 1, code: "return n*p" },
          after: { line: 2, code: "return n*p-discount" },
        },
      ],
    },
  });
  assert.ok(packet.evidence.some((e) => e.id === "old" && e.side === "left"));
  assert.ok(packet.evidence.some((e) => e.id === "new" && e.side === "right"));
  assert.equal(packet.changes[0].afterCode, "return n*p-discount");
});
test("产品与交付解读保留功能、流程、接口和高风险人工分工", () => {
  const packet = modelPacket({
    ...report,
    mode: "product",
    features: [{ name: "创建工单", evidence: ["price"] }],
    workflows: [{ name: "工单流程", steps: ["按钮", "函数", "请求"], evidence: ["price"] }],
    apis: [{ endpoint: "/api/tickets", method: "POST", evidence: ["price"] }],
    delivery: [{ name: "退款", risk: "high", decision: "人工确认" }],
  });
  assert.equal(packet.features[0].name, "创建工单");
  assert.deepEqual(packet.workflows[0].steps, ["按钮", "函数", "请求"]);
  assert.equal(packet.apis[0].method, "POST");
  assert.equal(packet.tasks[0].decision, "人工确认");
});
test("调用固定模型，隔离项目配置、命令工具、记忆、插件与浏览器", () => {
  const args = modelArguments("/tmp/sample", "/tmp/sample/schema.json");
  assert.equal(args[args.indexOf("--model") + 1], MODEL);
  for (const value of [
    "--ignore-user-config",
    "--ephemeral",
    "read-only",
    "features.shell_tool=false",
    "features.memories=false",
    "features.plugins=false",
    "features.multi_agent=false",
    "features.hooks=false",
  ])
    assert.ok(args.includes(value));
});
test("解析跨数据块的中文响应，保留用量并要求完成事件", async (t) => {
  const row =
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(answer) },
    }) + "\n";
  const command = await fixture(
    t,
    `process.stdin.resume();process.stdin.on("end",()=>{const b=Buffer.from(${JSON.stringify(row)});const i=b.indexOf(Buffer.from("按"))+1;process.stdout.write(b.subarray(0,i));setTimeout(()=>{process.stdout.write(b.subarray(i));console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:12,output_tokens:8}}));},20);});`,
  );
  const result = await interpretReport(report, { command });
  assert.equal(result.answer.summary, answer.summary);
  assert.equal(result.usage.input_tokens, 12);
});
test("工具调用事件会终止解读", async (t) => {
  const command = await fixture(
    t,
    `console.log(JSON.stringify({type:"item.started",item:{type:"command_execution",command:"never-executed"}}));setInterval(()=>{},1000);`,
  );
  await assert.rejects(interpretReport(report, { command }), /工具/);
});
test("超时和取消会终止拥有的模型进程", async (t) => {
  const command = await fixture(t, "setInterval(()=>{},1000);");
  await assert.rejects(interpretReport(report, { command, timeout: 70 }), /超时/);
  const controller = new AbortController();
  const result = interpretReport(report, { command, signal: controller.signal });
  setTimeout(() => controller.abort(), 70);
  await assert.rejects(result, /取消/);
});
test("拒绝没有完成事件的半截输出", async (t) => {
  const command = await fixture(
    t,
    `console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:${JSON.stringify(JSON.stringify(answer))}}}));`,
  );
  await assert.rejects(interpretReport(report, { command }), /没有收到有效/);
});
