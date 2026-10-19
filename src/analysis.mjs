import fs from "node:fs/promises";
import path from "node:path";
import { diffLines } from "diff";
import { collectTarget } from "./collect.mjs";
import { extractFacts, explainFunction, snippet } from "./facts.mjs";
import { callEngine } from "./engine.mjs";
import { atomicJson, jobDir, hash } from "./storage.mjs";

export const MODES = {
  technology: "技术说明",
  product: "产品研究",
  delivery: "AI 接管评估",
  code: "代码与版本",
};
const emptyFacts = () => ({
  tech: [],
  features: [],
  functions: [],
  apis: [],
  events: [],
  imports: [],
  parseErrors: [],
  evidence: [],
  documents: [],
});
const unique = (values) => [...new Set(values)];
const observation = (name, detail, evidence = [], authority = "inference") => ({
  name,
  detail,
  evidence,
  authority,
});

export function assessTasks(steps) {
  return steps.map((step, index) => {
    const high = step.risk === "high",
      ready = step.hasRules && step.hasApi;
    const decision = high
      ? "人工确认"
      : !step.hasRules
        ? "先补规则"
        : ready && step.risk === "low"
          ? "可做自动处理试点"
          : "AI 辅助处理";
    const reason = high
      ? "涉及高风险判断或重要写入，AI 可收集信息与起草，最终动作交给有权限的人。"
      : !step.hasRules
        ? "处理标准尚未明确，先整理资料、正确答案与异常处理规则。"
        : ready && step.risk === "low"
          ? "按填写条件具备试点基础；还需验证接口、身份权限、失败回退和业务验收。"
          : "可先做信息收集、分类与建议；接口或适用条件未验证，实际办理仍由人承接。";
    return {
      ...step,
      decision,
      reason,
      authority: "inference",
      evidence: [`business_${index + 1}`],
      integration: step.hasApi
        ? `对接 ${step.system || "待确认系统"}：核实接口协议、鉴权、字段、读写权限与失败重试。`
        : `${step.system || "现有系统"} 尚未提供已确认接口；先保留人工办理入口，评估授权 API 或人工辅助。`,
      fallback: high
        ? "授权负责人确认后办理；保留操作记录。"
        : "依据不足、接口失败或客户异议时，携带问题、依据和已执行动作转人工。",
    };
  });
}

export function compareFacts(left, right) {
  const fileChanges = [],
    leftFiles = new Map(left.files.map((f) => [f.path, f])),
    rightFiles = new Map(right.files.map((f) => [f.path, f]));
  for (const name of unique([...leftFiles.keys(), ...rightFiles.keys()]).sort()) {
    const before = leftFiles.get(name),
      after = rightFiles.get(name);
    if (before?.sha256 === after?.sha256) continue;
    const parts = diffLines(before?.text || "", after?.text || "");
    fileChanges.push({
      path: name,
      status: !before ? "added" : !after ? "removed" : "changed",
      leftSha256: before?.sha256 || null,
      rightSha256: after?.sha256 || null,
      addedLines: parts.filter((p) => p.added).reduce((n, p) => n + p.count, 0),
      removedLines: parts.filter((p) => p.removed).reduce((n, p) => n + p.count, 0),
      diff: parts.map((p) => ({
        type: p.added ? "add" : p.removed ? "remove" : "context",
        text:
          p.value.length > 60000
            ? `${p.value.slice(0, 60000)}\n[显示片段达到 60000 字符；完整文件保留在输入快照中]`
            : p.value,
      })),
      displayPartial: parts.some((p) => p.value.length > 60000),
    });
  }
  const l = extractFacts(left),
    r = extractFacts(right),
    functions = [];
  const group = (list) => {
    const map = new Map();
    for (const fn of list) {
      const key = `${fn.path}:${fn.anonymous ? "anonymous:" + fn.sha256 : fn.name}`;
      map.set(key, [...(map.get(key) || []), fn]);
    }
    return map;
  };
  const lg = group(l.functions),
    rg = group(r.functions);
  for (const key of unique([...lg.keys(), ...rg.keys()])) {
    const old = lg.get(key) || [],
      next = rg.get(key) || [];
    const filepath = old[0]?.path || next[0]?.path;
    if (leftFiles.get(filepath)?.sha256 === rightFiles.get(filepath)?.sha256) continue;
    if (old.length > 1 || next.length > 1) {
      functions.push({
        key,
        name: old[0]?.name || next[0]?.name,
        path: old[0]?.path || next[0]?.path,
        status: "unknown",
        detail: "存在同名函数，未自动假定一一对应。",
      });
      continue;
    }
    const before = old[0],
      after = next[0];
    if (before?.sha256 === after?.sha256) continue;
    functions.push({
      key,
      name: after?.name || before.name,
      path: after?.path || before.path,
      status: !before ? "added" : !after ? "removed" : "changed",
      before: before
        ? {
            line: before.line,
            params: before.params,
            explanation: explainFunction(before),
            code: before.code,
          }
        : null,
      after: after
        ? {
            line: after.line,
            params: after.params,
            explanation: explainFunction(after),
            code: after.code,
          }
        : null,
    });
  }
  return {
    files: fileChanges,
    functions,
    summary: {
      added: fileChanges.filter((x) => x.status === "added").length,
      removed: fileChanges.filter((x) => x.status === "removed").length,
      changed: fileChanges.filter((x) => x.status === "changed").length,
      functions: functions.filter((x) => x.status !== "unknown").length,
      ambiguousFunctions: functions.filter((x) => x.status === "unknown").length,
    },
    leftEvidence: l.evidence.map((e) => ({ ...e, side: "left", id: `left_${e.id}` })),
    rightEvidence: r.evidence.map((e) => ({ ...e, side: "right", id: `right_${e.id}` })),
  };
}

function recommendations(facts) {
  const results = [];
  if (facts.features.length)
    results.push(
      observation(
        "用任务组织功能入口",
        "可参考已观察到的页面栏目和操作入口来组织导航；正式设计需结合自己的用户任务，避免直接照搬页面。",
        facts.features[0].evidence,
      ),
    );
  if (facts.apis.length)
    results.push(
      observation(
        "把咨询和业务办理连起来",
        "存在接口调用线索。可研究如何将问题收集接到具体业务动作；调用声明不能证明接口当前可用。",
        facts.apis[0].evidence,
      ),
    );
  const f = facts.functions.find((x) => x.throws.length);
  if (f)
    results.push(
      observation(
        "把异常交接放进流程",
        "代码中存在显式错误分支。可借鉴将失败原因、上下文和下一步动作一起交给处理人。",
        f.evidence,
      ),
    );
  if (!results.length)
    results.push(
      observation(
        "先补充可观察的产品流程",
        "当前材料不足以形成可靠的产品借鉴结论。建议补充页面导出、可公开代码或人工记录的流程。",
        [],
        "unknown",
      ),
    );
  return results;
}

export async function runAnalysis(job, { signal, progress }) {
  const root = jobDir(job.id),
    engineDirectory = path.join(root, "engine");
  const limits = [];
  let nativeEvidence = [],
    engineEvidence,
    engineIssue;
  await progress(8, "读取目标并保留输入快照");
  const left = await collectTarget(job.target, {
    directory: path.join(root, "snapshot"),
    signal,
    progress: (message) => progress(12, message),
  });
  await atomicJson(path.join(root, "snapshot-manifest.json"), {
    ...left,
    files: left.files.map(({ text, ...f }) => f),
  });
  let facts = left.kind === "text" ? extractFacts(left) : emptyFacts();
  await progress(28, "提取技术、页面入口与代码位置");
  if (left.kind === "native") {
    for (const command of ["inspect-plist", "inspect-macho"]) {
      try {
        const result = await callEngine(command, [left.root], {
          directory: engineDirectory,
          signal,
        });
        nativeEvidence.push({ command, value: result });
      } catch (error) {
        if (signal.aborted) throw error;
        limits.push(error.message);
      }
    }
    for (const item of nativeEvidence) {
      const raw = JSON.stringify(item.value),
        ref = item.value.evidence_id || `native_${item.command}`;
      facts.evidence.push({
        id: ref,
        path: item.command,
        origin: left.root,
        line: 1,
        sha256: hash(raw),
        quote: "原始分析结果可从原始证据中下载。",
        kind: "native",
      });
      for (const [marker, label, description] of [
        ["SwiftUI", "SwiftUI", "依赖信息中出现 SwiftUI 框架"],
        ["AppKit", "AppKit", "依赖信息中出现 AppKit 框架"],
        ["libswift", "Swift 运行时", "依赖信息中出现 Swift 运行库"],
        ["Electron", "Electron", "应用元数据或依赖路径含 Electron 线索"],
      ])
        if (raw.includes(marker) && !facts.tech.some((t) => t.name === label))
          facts.tech.push(
            observation(
              label,
              `${description}；不代表全部源代码均由此技术实现。`,
              [ref],
              "observed",
            ),
          );
    }
    limits.push(
      "原生应用仅执行元数据与 Mach-O 依赖检查；完整算法和伪代码需要可用的深度分析器。本版不自动执行目标程序。",
    );
  } else if (left.kind === "binary") {
    try {
      const result = await callEngine("inspect-binary-layout", [left.root], {
        directory: engineDirectory,
        signal,
      });
      nativeEvidence.push({ command: "inspect-binary-layout", value: result });
      facts.evidence.push({
        id: result.evidence_id,
        path: "二进制布局",
        origin: left.root,
        line: 1,
        sha256: hash(JSON.stringify(result)),
        quote: "已取得 ELF 布局证据，未反编译函数。",
        kind: "native",
      });
      facts.tech.push(
        observation(
          "ELF 二进制",
          "已取得文件布局证据；编程语言和功能语义仍待进一步分析。",
          [result.evidence_id],
          "observed",
        ),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      limits.push(error.message);
    }
  } else {
    await progress(38, "调用拆拆生成带摘要指纹的静态证据");
    try {
      engineEvidence = await callEngine(
        "analyze-javascript-application",
        [
          left.root,
          "--max-semantic-nodes",
          "25000",
          "--max-semantic-nodes-per-file",
          "12000",
          "--max-heap-mb",
          "512",
          "--analysis-timeout-ms",
          "45000",
        ],
        { directory: engineDirectory, stem: "application", signal },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      engineIssue = error.message;
      limits.push(
        `拆拆应用图未完成：${error.message}。已保留本地来源与语法分析，任务状态为部分完成。`,
      );
    }
  }
  if (signal.aborted) throw new Error("任务已取消");
  const report = {
    version: "0.1.0",
    title: job.name,
    mode: job.mode,
    createdAt: new Date().toISOString(),
    target: job.target,
    question: job.question || "",
    summary: "",
    tech: facts.tech,
    features: facts.features,
    apis: facts.apis,
    events: facts.events,
    functions: facts.functions.map((fn) => ({ ...fn, explanation: explainFunction(fn) })),
    recommendations: [],
    workflows: [],
    delivery: [],
    changes: null,
    trace: null,
    evidence: facts.evidence,
    unknowns: [],
    limitations: limits,
    engine: {
      connected: Boolean(engineEvidence || nativeEvidence.length),
      evidenceId: engineEvidence?.evidence_id || null,
      graphSummary: engineEvidence?.normalized_result?.statistics || null,
      files: [],
    },
    coverage: {
      files: left.files.length,
      bytes: left.bytes,
      examined: left.examined,
      limits: left.limits || {},
      omissions: left.omissions,
      parseErrors: facts.parseErrors,
      status: "partial",
    },
    counts: {},
  };
  report.unknowns.push("未验证的后台实现、运行效果、真实用户数据和业务收益不能从静态材料推断。");
  if (engineEvidence) {
    report.engine.graphCoverage = engineEvidence.normalized_result.graph.coverage;
    report.engine.semanticCoverage = engineEvidence.normalized_result.semantic_graph.coverage;
    report.engine.semanticUnknowns =
      engineEvidence.normalized_result.semantic_graph.unknowns.length;
    if (report.engine.semanticUnknowns)
      report.unknowns.push(
        `拆拆静态语义图保留 ${report.engine.semanticUnknowns} 个未解析事项，详见原始证据。静态可达不等于实际执行。`,
      );
  }
  if (!facts.tech.length) report.unknowns.push("当前证据不足以确认具体技术栈。");
  if (job.mode === "code" && left.kind !== "text") {
    const available = await import("./engine.mjs").then((m) => m.engineHealth());
    const provider = available.providers.find((p) => p.available);
    report.native = {
      available: false,
      procedure: job.question || "",
      reason: "请在函数线索中填写原生函数名或地址，并先配置 Ghidra、Hopper 或 IDA。",
    };
    if (provider && job.question && !job.rightTarget)
      try {
        const value = await callEngine(
          "function",
          [left.root, `--procedure=${job.question}`, `--provider=${provider.id}`],
          { directory: engineDirectory, stem: "native-function", signal, timeout: 180000 },
        );
        const result = value.normalized_result,
          code = result.pseudocode || result.dossier?.pseudocode || "";
        report.native = {
          available: true,
          procedure: job.question,
          provider: provider.id,
          pseudocode: typeof code === "string" ? code : JSON.stringify(code, null, 2),
          evidenceId: value.evidence_id,
        };
        report.engine.connected = true;
        report.evidence.push({
          id: value.evidence_id,
          kind: "native",
          origin: left.root,
          path: "原生函数分析",
          line: 1,
          sha256: hash(JSON.stringify(value)),
          quote: "原生反编译分析器返回的函数证据；伪代码不等于原始源码。",
        });
      } catch (error) {
        if (signal.aborted) throw error;
        report.native.reason = error.message;
      }
    if (!report.native.available) {
      engineIssue = report.native.reason;
      report.limitations.push(report.native.reason);
    }
  }
  if (job.mode === "product") {
    report.recommendations = recommendations(facts);
    report.workflows = [
      ...facts.events.map((e) => {
        const target = facts.features.find((f) => f.selector && f.selector === `#${e.targetId}`);
        const calledNames = unique([...(e.callbackCalls || []), e.handler]);
        const linked = facts.functions.filter((fn) => calledNames.includes(fn.name));
        const calls = facts.apis.filter((api) =>
          linked.some(
            (fn) => fn.path === api.path && api.line >= fn.line && api.line <= fn.endLine,
          ),
        );
        return {
          name: `${e.event === "click" ? "点击" : e.event} · ${target?.name || e.targetId || "事件入口"}`,
          steps: unique([
            target?.name || e.callee,
            ...(linked.length ? linked.map((fn) => fn.name) : [e.handler]),
            ...calls.map((api) => `${api.method} ${api.endpoint}`),
          ]),
          detail: "基于入口标识、回调和源码位置关联的静态链路候选；尚未证明运行时触发或请求成功。",
          authority: linked.length ? "inference" : "observed",
          evidence: unique([
            ...e.evidence,
            ...(target?.evidence || []),
            ...linked.flatMap((fn) => fn.evidence),
            ...calls.flatMap((api) => api.evidence),
          ]),
        };
      }),
      ...facts.apis.map((api) => ({
        name: `${api.method} ${api.endpoint}`,
        steps: ["构造请求", "调用声明", api.endpoint],
        detail: "静态请求链路；不证明后台办理结果。",
        authority: "observed",
        evidence: api.evidence,
      })),
    ];
    report.unknowns.push(
      "页面栏目和按钮只证明入口存在；用户完整操作顺序需要浏览器实测或补充流程资料。",
    );
  }
  if (job.mode === "delivery") {
    const steps = job.steps || [];
    report.delivery = assessTasks(steps);
    steps.forEach((step, index) =>
      report.evidence.push({
        id: `business_${index + 1}`,
        kind: "user",
        path: "业务任务填写",
        origin: "用户提供，尚未独立核验",
        line: index + 1,
        sha256: hash(JSON.stringify(step)),
        quote: JSON.stringify(step),
      }),
    );
    report.unknowns.push(
      "接管结论是基于填写条件的试点建议，尚未验证岗位规则、接口授权、权限隔离、业务责任人与客户验收。",
    );
    report.recommendations = [
      observation(
        "从低风险、规则明确的任务开始",
        "先用脱敏问题和有效资料验收，让 AI 起草、人工确认，再逐步开放低风险自动处理。",
        report.delivery[0]?.evidence || [],
      ),
    ];
  }
  if (job.mode === "code") {
    await progress(65, job.rightTarget ? "分析新版本并比较变化" : "定位功能入口与函数调用");
    if (job.rightTarget) {
      const right = await collectTarget(job.rightTarget, {
        directory: path.join(root, "right-snapshot"),
        signal,
      });
      if (left.kind !== "text" || right.kind !== "text")
        throw new Error(
          "本版版本比较支持文本代码目录或网页导出；原生二进制版本差异需深度引擎工作流。",
        );
      await atomicJson(path.join(root, "right-snapshot-manifest.json"), {
        ...right,
        files: right.files.map(({ text, ...f }) => f),
      });
      report.changes = compareFacts(left, right);
      report.evidence.push(...report.changes.leftEvidence, ...report.changes.rightEvidence);
      report.rightTarget = job.rightTarget;
      report.rightCoverage = { files: right.files.length, omissions: right.omissions };
      if (right.omissions.length)
        report.unknowns.push("新版本存在未采集文件；未发现变化不表示完整应用没有变化。");
      try {
        const rightEngine = await callEngine(
          "analyze-javascript-application",
          [
            right.root,
            "--max-semantic-nodes",
            "25000",
            "--max-semantic-nodes-per-file",
            "12000",
            "--max-heap-mb",
            "512",
            "--analysis-timeout-ms",
            "45000",
          ],
          { directory: engineDirectory, stem: "right-application", signal },
        );
        if (
          engineEvidence &&
          engineEvidence.normalized_result.root_artifact_sha256 !==
            rightEngine.normalized_result.root_artifact_sha256
        ) {
          const input = path.join(root, "version-input.json");
          await atomicJson(input, { left: engineEvidence, right: rightEngine });
          const comparison = await callEngine("compare-application-versions", [input], {
            directory: engineDirectory,
            stem: "version-comparison",
            signal,
          });
          report.changes.engineSummary = comparison.normalized_result.summary;
          report.changes.engineEvidenceId = comparison.evidence_id;
        }
      } catch (error) {
        if (signal.aborted) throw error;
        report.limitations.push(
          `拆拆跨版本图比较未完成：${error.message}；文件和函数差异仍可查看。`,
        );
        engineIssue = error.message;
      }
    }
    const query = (job.question || "").trim().toLowerCase();
    const matched = facts.functions.filter(
      (fn) =>
        !query || fn.name.toLowerCase().includes(query) || fn.code.toLowerCase().includes(query),
    );
    const edges = [];
    for (const fn of facts.functions)
      for (const call of fn.calls) {
        const candidates = facts.functions.filter((f) => f.name === call);
        if (candidates.length === 1)
          edges.push({
            from: fn.name,
            to: call,
            path: fn.path,
            line: fn.line,
            authority: "inference",
            evidence: fn.evidence,
          });
      }
    report.trace = {
      query: job.question || "",
      matches: matched.map((fn) => ({
        name: fn.name,
        path: fn.path,
        line: fn.line,
        evidence: fn.evidence,
      })),
      edges,
      detail: "函数定位基于语法与文本匹配；同名解析、动态分派和运行时执行仍可能未知。",
    };
    if (query && engineEvidence)
      try {
        const input = path.join(root, "trace-input.json");
        await atomicJson(input, {
          application: engineEvidence,
          seed: { kind: "string", value: job.question, match: "contains" },
          direction: "both",
        });
        const traced = await callEngine("trace-application-feature", [input], {
          directory: engineDirectory,
          stem: "feature-trace",
          signal,
        });
        report.trace.engineSummary = traced.normalized_result.summary;
        report.trace.engineEvidenceId = traced.evidence_id;
        report.trace.engineCoverage = traced.normalized_result.coverage;
      } catch (error) {
        if (signal.aborted) throw error;
        report.limitations.push(`拆拆特征图追踪未完成：${error.message}`);
      }
  }
  await progress(90, "整理中文结论、证据和未验证事项");
  report.coverage.status =
    engineIssue ||
    left.omissions.length ||
    facts.parseErrors.length ||
    report.rightCoverage?.omissions.length ||
    (left.kind !== "text" && !nativeEvidence.length)
      ? "partial"
      : "complete-within-selected-inputs";
  report.counts = {
    files: left.files.length,
    technologies: facts.tech.length,
    features: facts.features.length,
    functions: facts.functions.length,
    apis: facts.apis.length,
    evidence: report.evidence.length,
  };
  const labels = report.tech.map((x) => x.name).join("、");
  report.summary =
    job.mode === "technology"
      ? `${labels ? `发现 ${labels} 等技术线索。` : "当前技术栈证据不足。"}${left.kind === "native" ? "已检查原生应用的基础元信息。" : `已读取 ${left.files.length} 个文件，技术结论保留原始位置。`}`
      : job.mode === "product"
        ? `从当前材料识别 ${facts.features.length} 个页面栏目或操作入口、${facts.apis.length} 处接口调用线索，整理可借鉴点与证据。`
        : job.mode === "delivery"
          ? `根据 ${report.delivery.length} 项填写的业务任务，形成 AI 辅助、自动处理试点与人工确认的分工建议。`
          : `定位 ${report.trace.matches.length} 个匹配函数。${report.changes ? `比较发现 ${report.changes.files.length} 个文件、${report.changes.summary.functions} 个函数变化。` : "可查看函数参数、条件、调用、返回与源码。"}`;
  if (report.native)
    report.summary = report.native.available
      ? `已取得 ${report.native.procedure} 的原生函数伪代码与证据，尚未验证完整业务含义。`
      : "原生函数深度分析尚未就绪；已保留可取得的基础元信息和明确的配置条件。";
  report.engine.files = await fs.readdir(engineDirectory).catch(() => []);
  if (engineEvidence)
    report.evidence.push({
      id: engineEvidence.evidence_id,
      path: "拆拆应用图",
      origin: job.target,
      line: 1,
      sha256: hash(JSON.stringify(engineEvidence)),
      quote: JSON.stringify(report.engine.graphSummary),
      kind: "engine",
    });
  report.counts.evidence = report.evidence.length;
  await atomicJson(path.join(root, "report.json"), report);
  return report;
}

export function reportMarkdown(report) {
  const lines = [
    `# ${report.title}`,
    "",
    `研究类型：${MODES[report.mode]}`,
    `时间：${report.createdAt}`,
    `目标：${report.target}`,
    "",
    "## 关键结论",
    "",
    report.summary,
    "",
    "## 分析范围",
    "",
    `读取 ${report.coverage.files} 个文件。结论范围：${report.coverage.status === "partial" ? "部分完成" : "仅限选定输入"}。`,
  ];
  for (const [title, items] of [
    ["技术线索", report.tech],
    ["功能与入口", report.features],
    ["可借鉴点", report.recommendations],
  ])
    if (items.length) {
      lines.push("", `## ${title}`, "");
      for (const x of items)
        lines.push(
          `- ${x.name}：${x.detail} [${x.authority === "observed" ? "观察" : "推断或待确认"}] ${(x.evidence || []).join(", ")}`,
        );
    }
  if (report.delivery.length) {
    lines.push("", "## AI 接管评估", "");
    for (const x of report.delivery)
      lines.push(
        `### ${x.name}`,
        "",
        `建议：${x.decision}`,
        x.reason,
        x.integration,
        `人工兜底：${x.fallback}`,
        "",
      );
  }
  if (report.trace) {
    lines.push("", "## 代码实现", "");
    for (const fn of report.functions.filter((f) =>
      report.trace.matches.some((m) => m.path === f.path && m.line === f.line),
    ))
      lines.push(
        `### ${fn.name}（${fn.path}:${fn.line}）`,
        "",
        fn.explanation,
        "",
        "```javascript",
        fn.code,
        "```",
        "",
      );
  }
  if (report.native) {
    lines.push(
      "",
      "## 原生函数",
      "",
      report.native.available
        ? `分析器：${report.native.provider}；证据：${report.native.evidenceId}`
        : report.native.reason,
    );
    if (report.native.available) lines.push("", "```text", report.native.pseudocode, "```");
  }
  if (report.changes) {
    lines.push("", "## 版本变化", "");
    for (const f of report.changes.files)
      lines.push(
        `- ${f.path}：${{ added: "新增", removed: "删除", changed: "修改" }[f.status]}，新增 ${f.addedLines} 行，删除 ${f.removedLines} 行。`,
      );
  }
  lines.push(
    "",
    "## 未验证事项",
    "",
    ...[...report.unknowns, ...report.limitations, ...report.coverage.omissions].map(
      (x) => `- ${x}`,
    ),
    "",
    "## 证据索引",
    "",
  );
  for (const e of report.evidence)
    lines.push(`- ${e.id}：${e.origin}:${e.line}；SHA-256 ${e.sha256}`);
  const interpretation = report.interpretation;
  if (interpretation?.status === "completed") {
    const result = interpretation.answer;
    lines.push(
      "",
      "## GPT-6.1 Sol 解读",
      "",
      "以下为基于所选资料的模型推断，需结合来源核实。",
      "",
      result.summary,
      ...result.findings.map(
        (f) => `- ${f.claim}（引用：${f.evidence_ids.join("、") || "未附引用"}）`,
      ),
      "",
      "### 建议",
      "",
      ...result.recommendations.map((x) => `- ${x}`),
      "",
      "### 仍需确认",
      "",
      ...result.unknowns.map((x) => `- ${x}`),
    );
  }
  return lines.join("\n");
}
