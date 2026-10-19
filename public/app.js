const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const modes = {
  technology: {
    name: "技术说明",
    icon: "◇",
    title: "看懂一个软件，用中文讲清楚。",
    description: "从依赖、文件与原始证据入手，了解用了什么技术，以及结论能确定到哪一步。",
    expects: ["识别技术栈及其来源", "中文说明技术分别负责什么", "保留可回看的证据与未知项"],
  },
  product: {
    name: "产品研究",
    icon: "▧",
    title: "拆解产品，把线索变成判断。",
    description: "梳理能观察到的功能入口、事件与接口线索，整理值得借鉴的设计。",
    expects: ["提取页面栏目和操作入口", "梳理静态事件与请求链路", "输出可借鉴点与证据索引"],
  },
  delivery: {
    name: "AI 接管评估",
    icon: "⌘",
    title: "从现有系统，找到 AI 的切入点。",
    description: "结合系统线索与业务条件，判断哪些任务适合试点，哪些动作需要人工接手。",
    expects: ["按任务评估 AI 与人工分工", "明确规则、接口与权限条件", "形成接入建议和验收方向"],
  },
  code: {
    name: "代码与版本",
    icon: "⤨",
    title: "追到代码，看清功能与变化。",
    description: "定位函数实现、参数和调用；比较两个版本的文件与函数差异，保留原文。",
    expects: ["定位函数与关键代码位置", "解释分支、调用、返回及异常", "比较文件、函数与声明变化"],
  },
};
const statusNames = {
  queued: "排队中",
  running: "分析中",
  cancelling: "取消中",
  completed: "已完成",
  partial: "部分完成",
  failed: "未完成",
  cancelled: "已取消",
  interrupted: "服务曾中断",
};
let mode = "technology",
  projects = [],
  selected = null,
  reportTab = "overview",
  bootstrap,
  health,
  taskPoll,
  searchQuery = "",
  evidenceQuery = "",
  pageLimit = 25;
let viewGeneration = 0,
  evidenceGeneration = 0;
const drafts = new Map();
const badge = (text, color = "") => `<span class="badge ${color}">${esc(text)}</span>`;
const statusBadge = (status) =>
  badge(
    statusNames[status] || status,
    ["completed"].includes(status)
      ? "green"
      : ["partial", "interrupted"].includes(status)
        ? "orange"
        : ["failed", "cancelled"].includes(status)
          ? "red"
          : "blue",
  );
const authority = (kind) =>
  badge(
    kind === "observed" ? "已观察" : kind === "unknown" ? "待确认" : "推断建议",
    kind === "observed" ? "green" : kind === "unknown" ? "orange" : "blue",
  );
const date = (value) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 3200);
}
async function api(route, { method = "GET", data } = {}) {
  const response = await fetch(route, {
    method,
    headers: { "X-Studio-Token": bootstrap?.token || "", "Content-Type": "application/json" },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求未完成");
  return value;
}
const downloadLink = (format, label) =>
  `<button class="button small" data-action="download-report" data-format="${format}">${label}</button>`;
function navigation() {
  $("#navigation").innerHTML = Object.entries(modes)
    .map(
      ([key, item], i) =>
        `<button class="nav-item ${mode === key ? "active" : ""}" data-action="mode" data-mode="${key}"><span class="nav-icon">${item.icon}</span>${item.name}<small class="nav-number">0${i + 1}</small></button>`,
    )
    .join("");
  $("#page-name").textContent = modes[mode].name;
}
function recent() {
  $("#recent-projects").innerHTML = projects.length
    ? projects
        .slice(0, 6)
        .map(
          (p) =>
            `<button class="recent-item" data-action="open" data-id="${p.id}">${esc(p.name)}<small>${statusNames[p.status]} · ${date(p.createdAt)}</small></button>`,
        )
        .join("")
    : '<p class="help-row">第一份研究，从这里开始。</p>';
}
function projectCards(limit = 3) {
  return projects.length
    ? projects
        .slice(0, limit)
        .map(
          (p) =>
            `<div class="project-card" role="button" tabindex="0" data-action="open" data-id="${p.id}"><span class="project-icon">${modes[p.mode]?.icon || "◇"}</span><div class="project-info"><b>${esc(p.name)}</b><p>${esc(p.summary || p.target)}</p></div><span class="project-date">${date(p.createdAt)}</span>${statusBadge(p.status)}</div>`,
        )
        .join("")
    : '<div class="empty-recent">还没有研究记录。完成一项任务后，证据与结果会保存在这里。</div>';
}
function taskRow(step = {}, index = 0) {
  return `<div class="business-step"><div class="business-step-top"><span>业务任务 ${index + 1}</span><button type="button" class="icon-button" data-action="remove-step" aria-label="移除此业务任务">×</button></div><div class="step-row"><input name="stepName" aria-label="业务任务名称" placeholder="例如：查询订单状态" value="${esc(step.name || "")}" required><input name="stepSystem" aria-label="相关系统" placeholder="涉及哪个系统？" value="${esc(step.system || "")}"></div><div class="step-row"><select name="stepRisk" aria-label="任务风险"><option value="low" ${step.risk === "low" ? "selected" : ""}>低风险：只读查询、标准回复</option><option value="medium" ${step.risk === "medium" || !step.risk ? "selected" : ""}>中风险：需要业务判断或写入</option><option value="high" ${step.risk === "high" ? "selected" : ""}>高风险：付款、退款、重要承诺等</option></select><div class="actions"><label class="check-label"><input name="stepRules" type="checkbox" ${step.hasRules ? "checked" : ""}>已有明确规则</label><label class="check-label"><input name="stepApi" type="checkbox" ${step.hasApi ? "checked" : ""}>已知有可用接口</label></div></div></div>`;
}
function formView() {
  const item = modes[mode],
    draft = drafts.get(mode) || {};
  viewGeneration++;
  selected = null;
  clearTimeout(taskPoll);
  reportTab = "overview";
  navigation();
  $("#main").innerHTML =
    `<div class="page-head"><div><div class="eyebrow">${mode === "code" ? "从功能到实现" : "从一个具体问题开始"}</div><h1>${item.title}</h1><p class="page-description">${item.description}</p></div><span class="step-caption"><b>选择目标</b>　·　分析证据　·　形成结论</span></div><div class="workspace-grid"><section class="panel"><div class="panel-head"><h2>新建${item.name}任务</h2><div class="segmented"><button type="button" data-action="example" class="active">加载公开示例</button>${mode === "technology" ? '<button type="button" data-action="native-example">本机计算器</button>' : ""}</div></div><form id="task-form"><div class="field"><label class="label" for="project-name">研究名称 <span class="optional">可选</span></label><input id="project-name" name="name" placeholder="给这次研究起个名字" value="${esc(draft.name || "")}"></div><div class="field"><label class="label" for="target">${mode === "code" ? "当前 / 旧版本目标" : "研究目标"}</label><input id="target" name="target" placeholder="粘贴本地目录、软件路径，或 HTTPS 网页地址" value="${esc(draft.target || "")}" required><small>${mode === "code" ? "版本比较优先选择两个本地代码目录。" : "本地目录直接读取；网页只采集公开 HTML 和同源脚本。"}不会执行目标程序。</small></div>${mode === "code" ? `<div class="field"><label class="label" for="right-target">新版本目标 <span class="optional">可选，填写后比较版本</span></label><input id="right-target" name="rightTarget" placeholder="新版本代码目录或网页地址" value="${esc(draft.rightTarget || "")}"></div>` : ""}<div class="field"><label class="label" for="question">${mode === "code" ? "想追踪的函数或线索" : "这次想研究什么"} <span class="optional">可选</span></label><textarea id="question" name="question" placeholder="${mode === "code" ? "例如：calculatePrice 或 /api/tickets" : "记录你的研究目标，方便后续回看"}">${esc(draft.question || "")}</textarea><small>${mode === "code" ? "按函数名与代码文本定位，并尝试在拆拆应用图中追踪同名字符串。" : "用于记录研究背景；本地规则分析不会把自由文本自动理解成已验证结论。"}</small></div>${mode === "delivery" ? `<div class="field"><label class="label">需要评估的业务任务</label><p class="muted">填写你已了解的条件。评估基于填写信息，不代表接口与权限已验证。</p><div id="business-steps">${(draft.steps?.length ? draft.steps : [{}]).map(taskRow).join("")}</div><button class="button small" type="button" data-action="add-step">＋ 添加业务任务</button></div>` : ""}<div class="form-bottom"><p class="privacy-note">◌ 输入快照和研究报告保存在本机，默认不向外部模型发送材料。</p><button class="button primary" id="start-button" type="submit">开始${item.name} <span>↗</span></button></div><div id="form-feedback" class="feedback" role="alert"></div></form></section><aside class="workspace-aside"><div class="side-note"><h3>这次会得到什么</h3><ul class="expect-list">${item.expects.map((x) => `<li><span>✓</span>${x}</li>`).join("")}</ul><p>结论区分“已观察”“推断建议”和“待确认”，证据可以展开查看。</p></div><div class="outline-note"><h3>分析范围由你掌握</h3><p>当前为本地静态分析。深度原生反编译需要另行配置分析引擎；页面按钮和接口声明不等于业务实际可用。</p><button class="button text small" data-action="engine">查看引擎与支持范围 ↗</button></div></aside></div><div class="section-title"><h2>最近研究</h2><span>本机保存，随时继续</span></div><div id="home-projects">${projectCards()}</div>`;
}
function getForm() {
  const form = $("#task-form");
  if (!form) return null;
  const value = (name) => form.elements.namedItem(name)?.value || "";
  return {
    mode,
    name: value("name"),
    target: value("target"),
    question: value("question"),
    rightTarget: value("rightTarget"),
    steps: [...document.querySelectorAll(".business-step")].map((row) => ({
      name: row.querySelector("[name=stepName]").value,
      system: row.querySelector("[name=stepSystem]").value,
      risk: row.querySelector("[name=stepRisk]").value,
      hasRules: row.querySelector("[name=stepRules]").checked,
      hasApi: row.querySelector("[name=stepApi]").checked,
    })),
  };
}
function evidenceButtons(ids = []) {
  return `<div class="evidence-actions">${ids
    .map((id) => {
      const e = selected?.report?.evidence.find((x) => x.id === id);
      const side = e?.side === "left" ? "旧版 · " : e?.side === "right" ? "新版 · " : "";
      return `<button class="evidence-button" data-action="evidence" data-id="${esc(id)}">↗ ${esc(e ? `${side}${e.path}:${e.line}` : id.slice(0, 24))}</button>`;
    })
    .join("")}</div>`;
}
function finding(item) {
  return `<article class="finding"><div class="finding-top"><h3>${esc(item.name)}</h3>${authority(item.authority)}</div><p>${esc(item.detail)}</p>${evidenceButtons(item.evidence)}</article>`;
}
function empty(message) {
  return `<div class="report-empty">${message}<p>没有观察到不等于不存在，请结合分析范围和原始材料判断。</p></div>`;
}
function reportBody() {
  const r = selected.report;
  if (reportTab === "model") {
    const m = r.interpretation;
    const status = m?.status;
    const result = status === "completed" ? m.answer : null;
    return `<div class="notice">GPT-6.1 Sol 通过本机已登录的 Codex 调用。点击发送后，所选证据和代码片段会交给 OpenAI 处理，并使用你的 Codex 配额。模型解读属于推断，原始拆解结论和人工确认规则保持可见。</div>${status === "running" ? '<div class="panel section-gap"><h3>GPT 正在解读证据…</h3><p>结果会自动刷新，可离开后回看。</p><button class="button small" data-action="model-cancel">取消模型解读</button></div>' : `<button class="button dark section-gap" data-action="model-preview">${result ? "重新选择资料解读" : "预览资料并用 GPT 解读"} ↗</button>`}${m?.error ? `<div class="notice red section-gap">${esc(m.error)}</div>` : ""}${result ? `<section class="panel section-gap"><div class="eyebrow">GPT-6.1 Sol · 模型解读 / 需核实</div><h3>关键结论</h3><p class="report-text">${esc(result.summary)}</p><p class="muted">${esc(date(m.generatedAt))} · 发送 ${m.inputBytes} 字节研究资料${m.omitted ? ` · ${m.omitted} 项资料未纳入本次输入` : ""}</p></section><div class="report-list section-gap">${result.findings.map((f) => `<article class="finding"><h3>${esc(f.claim)}</h3>${evidenceButtons(f.evidence_ids)}${!f.evidence_ids.length ? '<p class="muted">未附来源引用，需人工核实。</p>' : ""}</article>`).join("")}</div><section class="panel section-gap"><h3>可借鉴点与建议</h3><ul class="checklist">${result.recommendations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><h3>仍需确认</h3><ul class="checklist">${result.unknowns.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}`;
  }
  if (reportTab === "overview")
    return `<div class="report-list">${r.tech.length ? r.tech.map(finding).join("") : empty("当前材料不足以确认具体技术栈。")}${r.recommendations.length ? `<div class="section-title"><h2>可借鉴点与试点建议</h2></div>${r.recommendations.map(finding).join("")}` : ""}</div><div class="section-gap panel"><h3>仍需验证</h3><ul class="checklist">${r.unknowns.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;
  if (reportTab === "product")
    return `<div class="table-wrap"><table class="table"><thead><tr><th>观察到的入口</th><th>类型</th><th>证据与范围</th></tr></thead><tbody>${r.features.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.type)}</td><td>${esc(x.detail)}${evidenceButtons(x.evidence)}</td></tr>`).join("") || '<tr><td colspan="3">当前材料未提取到 HTML 功能入口。</td></tr>'}</tbody></table></div><div class="section-title"><h2>静态事件与请求链路</h2><span>尚未验证运行结果</span></div><div class="report-list">${r.workflows.length ? r.workflows.map((w) => `<article class="finding"><div class="finding-top"><h3>${esc(w.name)}</h3>${authority(w.authority)}</div><div class="flowline">${w.steps.map((x) => `<span>${esc(x)}</span>`).join("<i>→</i>")}</div><p>${esc(w.detail)}</p>${evidenceButtons(w.evidence)}</article>`).join("") : empty("当前未提取到可展示的事件链路。")}</div>`;
  if (reportTab === "delivery")
    return `<div class="notice">以下是基于填写条件的建议。自动处理候选必须经过资料、接口、权限与业务验收后才能接管真实工作。</div><div class="report-list">${r.delivery.length ? r.delivery.map((task) => `<article class="finding decision ${task.risk === "high" ? "high" : ""}"><div class="finding-top"><h3>${esc(task.name)}</h3>${badge(task.decision, task.risk === "high" ? "orange" : "green")}</div><p>${esc(task.reason)}</p><p>接入方式：${esc(task.integration)}</p><p>人工兜底：${esc(task.fallback)}</p>${evidenceButtons(task.evidence)}</article>`).join("") : empty("该研究未填写业务任务；请新建 AI 接管评估任务。")}</div><div class="section-gap panel"><h3>正式试点的验收要点</h3><ul class="checklist"><li>先确认正确答案、可执行动作与责任人。</li><li>先人工审核，再开放低风险自动处理。</li><li>比较实际解决率、人工时间、错误率与单位任务总成本。</li></ul></div>`;
  if (reportTab === "code") {
    if (r.native)
      return r.native.available
        ? `<article class="finding"><div class="finding-top"><h3>${esc(r.native.procedure)}</h3>${badge("引擎反编译结果", "green")}</div><p>由 ${esc(r.native.provider)} 返回伪代码；不等于原始源码，具体业务含义还需结合调用和运行证据。</p>${evidenceButtons([r.native.evidenceId])}<pre class="code-block">${esc(r.native.pseudocode || "引擎未返回可显示的伪代码，完整结果见原始证据。")}</pre></article>`
        : `<div class="notice">${esc(r.native.reason)}</div><button class="button small" data-action="engine">查看深度分析器状态</button>`;
    const matches = r.trace?.matches || [];
    const list = r.functions.filter(
      (fn) =>
        (!r.trace || matches.some((m) => m.path === fn.path && m.line === fn.line)) &&
        (!searchQuery ||
          `${fn.name} ${fn.path} ${fn.code}`.toLowerCase().includes(searchQuery.toLowerCase())),
    );
    return `<div class="search-bar"><input id="function-search" placeholder="在本次结果中搜索函数、路径或代码" value="${esc(searchQuery)}" aria-label="搜索函数"></div><p class="muted" style="margin-bottom:15px">匹配 ${list.length} 个函数。${esc(r.trace?.detail || "按源码语法提取，未执行函数。")}</p><div class="report-list">${
      list.length
        ? list
            .slice(0, pageLimit)
            .map(
              (fn) =>
                `<article class="finding"><div class="finding-top"><h3>${esc(fn.name)}</h3>${badge(fn.async ? "异步函数" : "函数", "green")}</div><div class="function-location">${esc(fn.path)}:${fn.line}–${fn.endLine}</div><p>${esc(fn.explanation)}</p>${evidenceButtons(fn.evidence)}<details><summary class="code-summary">展开函数源码</summary><pre class="code-block"><code>${esc(fn.code)}</code></pre></details></article>`,
            )
            .join("")
        : empty("没有找到匹配函数。可以换函数名、接口地址或更具体的代码线索。")
    }</div>${list.length > pageLimit ? '<button class="button small section-gap" data-action="more">加载更多函数</button>' : ""}${r.trace?.engineSummary ? `<div class="notice green">拆拆应用图匹配 ${r.trace.engineSummary.matched_seeds} 个字符串种子，追踪 ${r.trace.engineSummary.traced_nodes} 个节点。字符串图未匹配不表示函数不存在；函数定位结果在上方单独展示。</div>` : ""}${r.trace?.edges.length ? `<div class="section-title"><h2>同名唯一函数的调用候选</h2><span>静态推断，非运行轨迹</span></div><div class="report-list">${r.trace.edges.map((edge) => `<article class="finding"><div class="flowline"><span>${esc(edge.from)}</span><i>→</i><span>${esc(edge.to)}</span></div>${evidenceButtons(edge.evidence)}</article>`).join("")}</div>` : ""}`;
  }
  if (reportTab === "versions") {
    const c = r.changes;
    if (!c)
      return empty("本次没有提供两个版本；新建“代码与版本”任务，填写旧版和新版目标后即可比较。");
    return `<div class="notice green">${c.files.length} 个文件发生变化，${c.summary.functions} 个函数新增、删除或修改。${c.summary.ambiguousFunctions ? `${c.summary.ambiguousFunctions} 组同名函数未强行匹配。` : ""}差异仅覆盖已采集的输入文件。</div><div class="report-list">${c.functions.map((fn) => `<article class="finding"><div class="finding-top"><h3>${esc(fn.name)} <span class="optional">${esc(fn.path)}</span></h3>${badge({ added: "新增函数", removed: "删除函数", changed: "函数修改", unknown: "匹配不确定" }[fn.status], fn.status === "unknown" ? "orange" : "green")}</div>${fn.detail ? `<p>${esc(fn.detail)}</p>` : `<div class="two-columns"><div><div class="subheading section-gap">旧版 ${fn.before ? `· 第 ${fn.before.line} 行` : ""}</div><p>${esc(fn.before?.explanation || "旧版无对应函数")}</p></div><div><div class="subheading section-gap">新版 ${fn.after ? `· 第 ${fn.after.line} 行` : ""}</div><p>${esc(fn.after?.explanation || "新版无对应函数")}</p></div></div>`}</article>`).join("")}</div><div class="section-title"><h2>逐文件差异</h2><span>绿色新增 · 红色删除</span></div>${
      c.files
        .map(
          (file) =>
            `<details class="version-file"><summary>${badge({ added: "新增", removed: "删除", changed: "修改" }[file.status], file.status === "removed" ? "orange" : "green")}<code>${esc(file.path)}</code><span class="file-count">＋${file.addedLines}　−${file.removedLines}</span></summary>${file.displayPartial ? '<div class="notice">大文本只显示片段；完整内容保存在输入快照中。</div>' : ""}<pre class="diff">${file.diff
              .map((part) =>
                part.text
                  .split("\n")
                  .map(
                    (line) =>
                      `<span class="diff-line ${part.type}">${part.type === "add" ? "+" : part.type === "remove" ? "−" : " "} ${esc(line)}</span>`,
                  )
                  .join(""),
              )
              .join("")}</pre></details>`,
        )
        .join("") || empty("在已采集的两个版本中没有发现文件内容变化。")
    }${c.engineSummary ? `<div class="notice">拆拆应用图比较：新增 ${c.engineSummary.added}，删除 ${c.engineSummary.removed}，变化 ${c.engineSummary.changed}，未确认 ${c.engineSummary.unknown}。图节点数量与文件、函数数量口径不同。</div>` : ""}`;
  }
  if (reportTab === "evidence") {
    const list = r.evidence.filter((e) =>
      `${e.path} ${e.origin} ${e.quote}`.toLowerCase().includes(evidenceQuery.toLowerCase()),
    );
    return `<div class="search-bar"><input id="evidence-search" placeholder="搜索文件、来源或证据片段" value="${esc(evidenceQuery)}" aria-label="搜索证据"></div><div class="table-wrap"><table class="table"><thead><tr><th>来源位置</th><th>证据片段</th><th>查看</th></tr></thead><tbody>${list
      .slice(0, pageLimit)
      .map(
        (e) =>
          `<tr><td>${esc(e.path)}:${e.line}<small>${esc(e.id)}</small>${e.side ? badge(e.side === "right" ? "新版" : "旧版") : ""}</td><td>${esc(e.quote.slice(0, 180))}</td><td><button class="button text small" data-action="evidence" data-id="${e.id}">展开 ↗</button></td></tr>`,
      )
      .join(
        "",
      )}</tbody></table></div>${list.length > pageLimit ? '<button class="button small section-gap" data-action="more">加载更多证据</button>' : ""}<div class="section-title"><h2>拆拆原始证据</h2><span>完整 JSON 保存在本机</span></div><div class="actions">${r.engine.files.map((file) => `<button class="button small" data-action="download-raw" data-file="${esc(file)}">下载 ${esc(file)}</button>`).join("") || '<p class="muted">本次没有取得拆拆原始分析结果，请查看分析范围中的原因。</p>'}</div>`;
  }
  if (reportTab === "scope")
    return `<section class="panel"><h3>当前分析范围</h3><p class="muted section-gap">${r.coverage.files} 个文本文件，${(r.coverage.bytes / 1024).toFixed(1)} KB。${r.coverage.status === "partial" ? "存在限制，研究状态为部分完成。" : "分析完成仅指选定输入范围。"}</p><ul class="checklist"><li>单文件最多 512 KB，总文本最多 8 MB，最多 200 个文本文件。</li><li>不跟随符号链接，不采集隐藏目录与 node_modules。</li><li>网页仅初始 HTML 与最多 12 个同源脚本，不执行页面或登录。</li><li>原生应用基础模式仅检查元信息与依赖。</li><li>基础分析保存研究目标；可在 GPT 解读中预览并发送所选资料。</li></ul></section><div class="section-gap panel"><h3>未验证、受限或遗漏事项</h3><ul class="checklist">${[...r.unknowns, ...r.limitations, ...r.coverage.omissions, ...r.coverage.parseErrors.map((e) => `${e.path}：解析不完整（${e.message}）`)].map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div><div class="section-gap panel"><h3>运行记录</h3><ul class="timeline">${selected.timeline.map((e) => `<li>${esc(e.message)}<time>${new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false })}</time></li>`).join("")}</ul></div>`;
  return "";
}
function showReport(job) {
  selected = job;
  mode = job.mode;
  navigation();
  const r = job.report;
  const busy = ["queued", "running", "cancelling"].includes(job.status);
  $("#main").innerHTML =
    `<button class="back-link" data-action="new">← 返回任务中心</button><div class="page-head report-page-head"><div><div class="eyebrow">${modes[mode].name} / 研究记录</div><h1>${esc(job.name)}</h1><p class="page-description">${date(job.createdAt)}　${statusNames[job.status]}</p></div><div class="actions project-head-actions">${busy ? '<button class="button danger small" data-action="cancel">停止分析</button>' : r ? `${downloadLink("md", "导出报告")}${downloadLink("json", "导出研究记录")}<button class="button dark small" data-action="brief">汇报要点 ↗</button>` : '<button class="button primary small" data-action="retry">调整后重试</button>'}</div></div>${
      busy
        ? `<section class="progress-panel"><div class="progress-head"><h2>${esc(job.progress.message)}</h2><span class="badge green">${job.progress.percent}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${job.progress.percent}%"></div></div><p class="progress-label">任务真实运行中，输入快照和阶段记录会保留在本机。</p><ul class="timeline">${job.timeline
            .slice(-5)
            .map(
              (e) =>
                `<li>${esc(e.message)}<time>${new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false })}</time></li>`,
            )
            .join("")}</ul></section>`
        : ""
    }${job.error ? `<div class="notice red">${esc(job.error)}</div>` : ""}${
      r
        ? `<section class="report-top"><div class="eyebrow">关键结论 / 仅限已观察材料</div><h2>${esc(r.summary)}</h2><p>研究目标：${esc(job.target)}${job.rightTarget ? `　新版：${esc(job.rightTarget)}` : ""}</p></section>${job.status === "partial" ? '<div class="notice">部分材料、语法或引擎分析受限。已观察到的结果保留，不能据此推断完整产品没有其他功能。请查看“分析范围”。</div>' : ""}<div class="metrics">${[
            [r.counts.files, "读取文件"],
            [r.counts.technologies, "技术线索"],
            [r.counts.functions, "提取函数"],
            [r.counts.apis, "接口线索"],
            [r.counts.evidence, "证据位置"],
          ]
            .map(
              ([value, label]) => `<div class="metric"><span>${label}</span><b>${value}</b></div>`,
            )
            .join("")}</div><div class="report-tabs">${[
            ["overview", "关键结论"],
            ["model", "GPT 解读"],
            ["product", "功能与流程"],
            ["delivery", "AI 接管"],
            ["code", "代码实现"],
            ["versions", "版本变化"],
            ["evidence", "证据"],
            ["scope", "分析范围"],
          ]
            .map(
              ([key, label]) =>
                `<button class="${reportTab === key ? "active" : ""}" data-action="report-tab" data-tab="${key}">${label}</button>`,
            )
            .join("")}</div><div id="report-body">${reportBody()}</div>`
        : !busy
          ? '<div class="report-empty">已有快照和原始结果仍保存在本机项目目录中。可调整目标后重试。</div>'
          : ""
    }`;
}
async function downloadFile(route, filename) {
  const response = await fetch(route, { headers: { "X-Studio-Token": bootstrap.token } });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error || "导出未完成");
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[\\/<>:\"|?*]/g, "_");
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function refreshProjects() {
  projects = await api("/api/projects");
  recent();
  if (!selected && $("#home-projects")) $("#home-projects").innerHTML = projectCards();
}
async function openProject(jobId, generation = ++viewGeneration) {
  clearTimeout(taskPoll);
  const job = await api(`/api/projects/${jobId}`);
  if (generation !== viewGeneration) return;
  if (selected?.id !== jobId) {
    reportTab =
      job.mode === "delivery"
        ? "delivery"
        : job.mode === "code"
          ? job.rightTarget
            ? "versions"
            : "code"
          : job.mode === "product"
            ? "product"
            : "overview";
    searchQuery = "";
    pageLimit = 25;
  }
  showReport(job);
  history.replaceState(null, "", `#project/${job.id}`);
  if (
    ["queued", "running", "cancelling"].includes(job.status) ||
    job.report?.interpretation?.status === "running"
  )
    taskPoll = setTimeout(
      () =>
        openProject(jobId, generation)
          .then(refreshProjects)
          .catch((error) => toast(error.message)),
      1100,
    );
}
function modal(title, html) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  if (!$("#modal").open) $("#modal").showModal();
}
async function showEvidence(eid) {
  const generation = ++evidenceGeneration;
  const e = selected.report.evidence.find((x) => x.id === eid);
  if (!e) return toast("未找到证据索引");
  modal(
    "证据与来源",
    `<p class="source-meta">${esc(e.origin)}:${e.line}<br>证据编号：${esc(e.id)}<br>SHA-256：${esc(e.sha256)}</p><p class="notice green">${esc(e.kind === "user" ? "用户填写的业务条件，未独立核验。" : e.kind === "engine" || e.kind === "native" ? "原始引擎证据可在“证据”页下载。" : "下方为保留的输入快照，不会重新读取当前目标。")}</p><pre class="code-block">${esc(e.quote)}</pre><div id="full-source"></div>`,
  );
  if (["user", "engine", "native"].includes(e.kind)) return;
  try {
    const source = await api(`/api/projects/${selected.id}/source?id=${encodeURIComponent(eid)}`);
    if (generation !== evidenceGeneration || !$("#modal").open || !$("#full-source")) return;
    const rows = source.text.split("\n"),
      start = Math.max(0, source.line - 8),
      end = Math.min(rows.length, source.line + 45);
    $("#full-source").innerHTML =
      `<p class="muted section-gap">源码片段：第 ${start + 1}–${end} 行 / 共 ${rows.length} 行</p><div class="source-lines">${rows
        .slice(start, end)
        .map(
          (line, i) =>
            `<span class="source-line ${i + start + 1 === source.line ? "highlight" : ""}"><i>${i + start + 1}</i>${esc(line)}</span>`,
        )
        .join("")}</div>`;
  } catch (error) {
    $("#full-source").textContent = error.message;
  }
}
async function showEngine() {
  health = await api("/api/health?refresh=1");
  modal(
    "分析引擎与支持范围",
    `<div class="finding-top"><h3>ChaiChai ${esc(health.version || "未连接")}</h3>${badge(health.ready ? "本地可调用" : "需要配置", health.ready ? "green" : "orange")}</div><p class="source-meta section-gap">${esc(health.root)}</p><div class="notice green">${esc(health.ready ? "本地网页代码、函数语法、版本差异和任务评估不需要额外原生反编译器。" : health.error)}</div><div class="engine-grid">${health.providers.map((p) => `<div class="engine-row"><h3>${esc(p.name)}${badge(p.available ? "已发现" : "未配置", p.available ? "green" : "orange")}</h3><p>${p.available ? "已发现配置；具体目标和实际反编译仍需另行验证。" : `${esc(p.id)} 尚不可用，请按原项目说明自行配置。`}</p></div>`).join("")}</div><p class="muted section-gap">本版没有自动安装或运行第三方深度分析器。目标程序不会被执行。项目内容默认不发送给外部模型。</p>`,
  );
}
function brief() {
  const r = selected.report;
  return `这次我完成了${modes[selected.mode].name}：\n\n1. ${r.summary}\n\n2. 研究记录保留了 ${r.counts.evidence} 处证据位置，结论和推断分开，可查看来源和原始代码。${r.changes ? `两个版本的文件和函数变化也已整理。` : ""}\n\n3. 下一步需要补充实际操作或业务验证。当前${selected.mode === "delivery" ? "接管建议基于填写的业务条件，接口与权限尚未核验" : "结果来自静态材料，没有证明后台实现或运行效果"}，可以据此确定需要进一步验证的方向。`;
}
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "task-form") return;
  event.preventDefault();
  const data = getForm();
  drafts.set(mode, data);
  $("#start-button").disabled = true;
  $("#form-feedback").textContent = "";
  try {
    const value = await api("/api/projects", { method: "POST", data });
    await refreshProjects();
    await openProject(value.id);
  } catch (error) {
    if ($("#form-feedback")) $("#form-feedback").textContent = error.message;
    if ($("#start-button")) $("#start-button").disabled = false;
  }
});
document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  try {
    const action = el.dataset.action;
    if (action === "model-preview") {
      const jobId = selected.id;
      const { packet } = await api(`/api/projects/${jobId}/interpret`);
      if (selected?.id !== jobId) return;
      modal(
        "确认本次发送的研究资料",
        `<p>仅发送下方预览中的问题、证据、函数片段和规则分析结果。不会发送整个目录、原始引擎 JSON 或登录凭据。接收方为 OpenAI，使用本机 Codex 登录与配额。</p><p>本次包含 ${packet.evidence.length} 条证据、${packet.functions.length} 个函数和 ${packet.changes.length} 项函数变化；输入大小 ${new TextEncoder().encode(JSON.stringify(packet)).length} 字节。</p><details><summary>展开完整发送内容</summary><pre class="code-block">${esc(JSON.stringify(packet, null, 2))}</pre></details><button class="button primary section-gap" data-action="model-send" data-id="${jobId}">发送以上资料并开始解读</button>`,
      );
    }
    if (action === "model-send") {
      if (selected?.id !== el.dataset.id) return;
      el.disabled = true;
      try {
        await api(`/api/projects/${el.dataset.id}/interpret`, {
          method: "POST",
          data: { consent: true },
        });
        $("#modal").close();
        reportTab = "model";
        await openProject(el.dataset.id);
      } catch (error) {
        el.disabled = false;
        throw error;
      }
    }
    if (action === "model-cancel") {
      const jobId = selected.id;
      await api(`/api/projects/${jobId}/model-cancel`, { method: "POST", data: {} });
      if (selected?.id === jobId) await openProject(jobId);
    }
    if (action === "mode") {
      const draft = getForm();
      if (draft) drafts.set(mode, draft);
      mode = el.dataset.mode;
      history.replaceState(null, "", `#${mode}`);
      formView();
    }
    if (action === "download-report")
      await downloadFile(
        `/api/projects/${selected.id}/export?format=${el.dataset.format}`,
        `${selected.name}.${el.dataset.format === "md" ? "md" : "json"}`,
      );
    if (action === "download-raw")
      await downloadFile(
        `/api/projects/${selected.id}/raw?file=${encodeURIComponent(el.dataset.file)}`,
        el.dataset.file,
      );
    if (action === "new") {
      history.replaceState(null, "", `#${mode}`);
      formView();
    }
    if (action === "example") {
      const sample = {
        name: `公开示例 · ${modes[mode].name}`,
        target: bootstrap.examples.left,
        question: mode === "code" ? "calculatePrice" : "企业服务工作台的产品设计与实现",
        rightTarget: mode === "code" ? bootstrap.examples.right : "",
        steps:
          mode === "delivery"
            ? [
                {
                  name: "常见问题答复",
                  system: "示例知识库",
                  risk: "low",
                  hasRules: true,
                  hasApi: true,
                },
                {
                  name: "创建服务工单",
                  system: "示例工单系统",
                  risk: "medium",
                  hasRules: true,
                  hasApi: true,
                },
                {
                  name: "退款批准",
                  system: "示例订单系统",
                  risk: "high",
                  hasRules: true,
                  hasApi: true,
                },
              ]
            : [],
      };
      drafts.set(mode, sample);
      formView();
      toast("已载入仓库内的公开示例，可直接开始研究");
    }
    if (action === "native-example") {
      drafts.set(mode, {
        name: "本机计算器 · 技术说明",
        target: bootstrap.examples.native,
        question: "查看框架与运行时依赖",
      });
      formView();
    }
    if (action === "open") {
      if ($("#modal").open) $("#modal").close();
      await openProject(el.dataset.id);
    }
    if (action === "engine") await showEngine();
    if (action === "add-step")
      $("#business-steps").insertAdjacentHTML(
        "beforeend",
        taskRow({}, document.querySelectorAll(".business-step").length),
      );
    if (action === "remove-step") el.closest(".business-step").remove();
    if (action === "cancel") {
      await api(`/api/projects/${selected.id}/cancel`, { method: "POST", data: {} });
      await openProject(selected.id);
    }
    if (action === "retry") {
      drafts.set(mode, { ...selected });
      formView();
    }
    if (action === "report-tab") {
      reportTab = el.dataset.tab;
      pageLimit = 25;
      showReport(selected);
    }
    if (action === "evidence") await showEvidence(el.dataset.id);
    if (action === "more") {
      pageLimit += 25;
      $("#report-body").innerHTML = reportBody();
    }
    if (action === "brief")
      modal(
        "汇报要点",
        `<div class="report-text" id="brief-content">${esc(brief())}</div><div class="actions section-gap"><button class="button primary small" data-action="copy-brief">复制文字</button><button class="button small" data-action="print">打印 / 保存 PDF</button></div>`,
      );
    if (action === "copy-brief") {
      try {
        await navigator.clipboard.writeText(brief());
        toast("汇报文字已复制");
      } catch {
        toast("当前环境未允许复制，可直接选中文字复制");
      }
    }
    if (action === "print") {
      const tabs = [
        "overview",
        selected.mode === "delivery" ? "delivery" : selected.mode === "code" ? "code" : "product",
        ...(selected.report.changes ? ["versions"] : []),
        ...(selected.report.interpretation?.status === "completed" ? ["model"] : []),
        "scope",
      ];
      $("#modal").close();
      const old = reportTab;
      const all = tabs
        .map((tab) => {
          reportTab = tab;
          return `<section class="section-gap">${reportBody()}</section>`;
        })
        .join("");
      reportTab = old;
      $("#report-body").innerHTML = all;
      window.print();
      $("#report-body").innerHTML = reportBody();
    }
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.classList.contains("project-card"))
    openProject(event.target.dataset.id).catch((error) => toast(error.message));
});
document.addEventListener("input", (event) => {
  if (["function-search", "evidence-search"].includes(event.target.id)) {
    const inputId = event.target.id,
      position = event.target.selectionStart;
    inputId === "function-search"
      ? (searchQuery = event.target.value)
      : (evidenceQuery = event.target.value);
    pageLimit = 25;
    $("#report-body").innerHTML = reportBody();
    const input = $(`#${inputId}`);
    input.focus();
    input.setSelectionRange(position, position);
  }
});
window.addEventListener("hashchange", () => {
  const match = location.hash.match(/^#project\/([0-9a-f-]{36})$/);
  if (match) openProject(match[1]).catch((error) => toast(error.message));
  else {
    const route = location.hash.slice(1);
    if (modes[route]) mode = route;
    formView();
  }
});
$("#modal-close").onclick = () => $("#modal").close();
$("#modal").addEventListener("click", (event) => {
  if (event.target === $("#modal") && event.offsetX < 0) $("#modal").close();
});
$("#engine-button").onclick = () => showEngine().catch((error) => toast(error.message));
$("#new-button").onclick = () => {
  history.replaceState(null, "", `#${mode}`);
  formView();
};
$("#history-button").onclick = () => modal("全部研究记录", projectCards(1000));
async function init() {
  bootstrap = await (await fetch("/api/bootstrap")).json();
  document.querySelectorAll("[data-version]").forEach((element) => {
    element.textContent = `v${bootstrap.version}`;
  });
  await refreshProjects();
  const project = location.hash.match(/^#project\/([0-9a-f-]{36})$/);
  if (project) await openProject(project[1]);
  else {
    const route = location.hash.slice(1);
    if (modes[route]) mode = route;
    formView();
  }
  health = await api("/api/health");
  $("#engine-status").textContent = health.ready
    ? `拆拆引擎已连接 · ${health.tools} 工具`
    : "拆拆引擎待配置";
  $(".status-dot").classList.toggle("warning", !health.ready);
}
init().catch((error) => {
  $("#main").innerHTML =
    `<div class="notice red">${esc(error.message)}。请刷新页面或检查本地服务。</div>`;
});
