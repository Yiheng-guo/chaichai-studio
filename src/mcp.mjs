#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { studioRequest, projectView } from "./client.mjs";

const server = new McpServer({ name: "chaichai-studio", version: "0.1.0" });
const shared = {
  name: z.string().max(150).optional(),
  target: z.string().min(1).max(4096).describe("本地路径或 HTTPS 公网地址"),
  question: z.string().max(2000).optional(),
};
const result = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
const error = (value) => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: value.message }) }],
});
function tool(name, description, schema, handler) {
  server.registerTool(name, { description, inputSchema: z.object(schema) }, async (input) => {
    try {
      return result(await handler(input));
    } catch (cause) {
      return error(cause);
    }
  });
}
for (const [name, mode, description] of [
  [
    "research_technology",
    "technology",
    "创建中文技术栈研究，保留证据与未确认项；异步返回研究编号。",
  ],
  ["research_product", "product", "研究页面功能入口、静态流程与可借鉴点；不推断不可见后台。"],
  [
    "assess_ai_takeover",
    "delivery",
    "结合用户填写的业务任务、风险、规则和接口条件，提出 AI 与人工分工建议。",
  ],
  [
    "explain_code_versions",
    "code",
    "定位函数实现，可选比较两个版本；JavaScript/TypeScript 文本代码支持详细解释。",
  ],
]) {
  const extra =
    mode === "delivery"
      ? {
          steps: z
            .array(
              z.object({
                name: z.string().min(1).max(200),
                system: z.string().max(200),
                risk: z.enum(["low", "medium", "high"]),
                hasRules: z.boolean(),
                hasApi: z.boolean(),
              }),
            )
            .min(1)
            .max(40),
        }
      : mode === "code"
        ? { rightTarget: z.string().max(4096).optional() }
        : {};
  tool(name, description, { ...shared, ...extra }, async (input) => ({
    ...(await studioRequest("/api/projects", { method: "POST", data: { ...input, mode } })),
    message: "使用 get_research 查看进度与摘要。研究默认在本机运行，不执行目标程序。",
  }));
}
tool(
  "get_research",
  "按摘要或分页视图读取研究结果。观察、推断、未知分开保留。",
  {
    id: z.string().uuid(),
    section: z
      .enum([
        "summary",
        "technology",
        "features",
        "workflows",
        "delivery",
        "functions",
        "changes",
        "evidence",
      ])
      .default("summary"),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(10),
  },
  async ({ id, section, offset, limit }) =>
    projectView(await studioRequest(`/api/projects/${id}`), section, offset, limit),
);
tool(
  "list_research",
  "列出本机已保存的研究，不重新分析目标。",
  {
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(20),
  },
  async ({ offset, limit }) => {
    const all = await studioRequest("/api/projects");
    return {
      total: all.length,
      nextOffset: offset + limit < all.length ? offset + limit : null,
      items: all.slice(offset, offset + limit),
    };
  },
);
tool(
  "read_source_evidence",
  "读取已保存的来源片段，最多 80 行，不读取任意新路径。",
  {
    id: z.string().uuid(),
    evidenceId: z.string().min(1),
    startLine: z.number().int().min(1).optional(),
    lines: z.number().int().min(1).max(80).default(30),
  },
  async ({ id, evidenceId, startLine, lines }) => {
    const value = await studioRequest(
      `/api/projects/${id}/source?id=${encodeURIComponent(evidenceId)}`,
    );
    const all = value.text.split("\n"),
      start = startLine || Math.max(1, value.line - 3);
    return {
      path: value.path,
      sha256: value.sha256,
      totalLines: all.length,
      startLine: start,
      nextLine: start + lines <= all.length ? start + lines : null,
      text: all.slice(start - 1, start - 1 + lines).join("\n"),
    };
  },
);
tool(
  "cancel_research",
  "取消指定研究任务；保留已有记录和快照。",
  { id: z.string().uuid() },
  async ({ id }) => studioRequest(`/api/projects/${id}/cancel`, { method: "POST", data: {} }),
);
serveStdio(() => server);
