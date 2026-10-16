#!/usr/bin/env node
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import { studioRequest, projectView } from "./client.mjs";

try {
  const { values } = parseArgs({
    options: {
      mode: { type: "string" },
      target: { type: "string" },
      right: { type: "string" },
      question: { type: "string" },
      name: { type: "string" },
      steps: { type: "string" },
      id: { type: "string" },
      section: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "拆拆研究台命令行\n\n先运行 npm start，再执行：\nnode src/cli.mjs --mode technology|product|delivery|code --target /path [--right /new/path] [--question 函数名] [--steps /业务任务.json]\n\n查看进度或结果：\nnode src/cli.mjs --id 研究编号 [--section summary|technology|features|workflows|delivery|functions|changes|evidence]",
    );
  } else if (values.id)
    console.log(
      JSON.stringify(
        projectView(await studioRequest(`/api/projects/${values.id}`), values.section || "summary"),
        null,
        2,
      ),
    );
  else {
    const data = {
      mode: values.mode,
      target: values.target,
      rightTarget: values.right || "",
      question: values.question || "",
      name: values.name || "",
      steps: values.steps ? JSON.parse(await fs.readFile(values.steps, "utf8")) : [],
    };
    const created = await studioRequest("/api/projects", { method: "POST", data });
    console.log(JSON.stringify({ ...created, message: "研究已提交，使用 --id 查看进度和结果。" }));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
