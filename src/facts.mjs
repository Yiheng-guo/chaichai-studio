import { parse } from "@babel/parser";
import { htmlFacts } from "./collect.mjs";
import { hash } from "./storage.mjs";

export const snippet = (text, length = 240) =>
  text.length > length ? `${text.slice(0, length)}…` : text;
export function walk(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string" && visit(node, parent) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "comments", "tokens", "errors", "extra"].includes(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value === "object") walk(value, visit, node);
  }
}
export function nameOf(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") return String(node.value);
  if (node.type === "ThisExpression") return "this";
  if (["MemberExpression", "OptionalMemberExpression"].includes(node.type))
    return `${nameOf(node.object)}.${nameOf(node.property)}`;
  if (node.type === "AssignmentPattern") return nameOf(node.left);
  if (node.type === "RestElement") return `...${nameOf(node.argument)}`;
  if (node.type === "CallExpression")
    return `${nameOf(node.callee)}(${node.arguments.map((arg) => nameOf(arg) || "?").join(",")})`;
  return "";
}
export function parseCode(file) {
  return parse(file.text, {
    sourceType: "unambiguous",
    errorRecovery: true,
    plugins: [
      ...(/\.[cm]?ts$/.test(file.path) ? [] : ["jsx"]),
      ...(/\.[cm]?tsx?$/.test(file.path) ? ["typescript"] : []),
    ],
  });
}
function describeExpression(node, source, depth = 0) {
  if (!node) return "";
  if (depth > 4) return snippet(source.slice(node.start, node.end), 100);
  const next = (part) => describeExpression(part, source, depth + 1);
  if (node.type === "Identifier") return node.name;
  if (node.type === "NumericLiteral" || node.type === "BooleanLiteral") return String(node.value);
  if (node.type === "StringLiteral") return `「${node.value}」`;
  const operators = {
    "+": "加上",
    "-": "减去",
    "*": "乘以",
    "/": "除以",
    "<": "小于",
    ">": "大于",
    "<=": "不大于",
    ">=": "不小于",
    "===": "严格等于",
    "!==": "不等于",
    "==": "等于",
    "!=": "不等于",
    "&&": "并且",
    "||": "或者",
    "??": "为空时使用",
  };
  if (["BinaryExpression", "LogicalExpression"].includes(node.type) && operators[node.operator])
    return `${next(node.left)} ${operators[node.operator]} ${next(node.right)}`;
  if (node.type === "UnaryExpression" && node.operator === "!")
    return `未提供或为假值的 ${next(node.argument)}`;
  if (node.type === "AwaitExpression") return `等待 ${next(node.argument)}`;
  if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
    const name = nameOf(node.callee),
      args = node.arguments.map(next);
    if (name === "fetch") return `向 ${args[0]} 发起请求并取得响应`;
    if (name === "Math.max") return `调用 Math.max 取 ${args.join("、")} 中的较大值`;
    if (name === "JSON.stringify") return `将 ${args[0]} 编码为 JSON 文本`;
    if (name === "Boolean") return `将 ${args[0]} 转为布尔值`;
    if (name.endsWith(".includes")) return `判断 ${nameOf(node.callee.object)} 是否包含 ${args[0]}`;
    if (name.endsWith(".json")) return `读取 ${nameOf(node.callee.object)} 的 JSON 解析结果`;
  }
  return snippet(source.slice(node.start, node.end), 160);
}
const KNOWN = {
  react: "React 界面库",
  vue: "Vue 界面框架",
  svelte: "Svelte 界面框架",
  next: "Next.js 应用框架",
  nuxt: "Nuxt 应用框架",
  electron: "Electron 桌面容器",
  express: "Express HTTP 服务",
  fastify: "Fastify HTTP 服务",
  vite: "Vite 构建工具",
  typescript: "TypeScript 类型系统",
  "@nestjs/core": "NestJS 服务框架",
  "@angular/core": "Angular 界面框架",
  "@modelcontextprotocol/server": "MCP 服务端",
  prisma: "Prisma 数据访问工具",
};
const ROLES = {
  react: "组织界面组件和界面状态",
  vue: "组织页面组件与响应式状态",
  svelte: "编译与组织界面组件",
  next: "组织页面路由、渲染与服务端逻辑",
  nuxt: "组织 Vue 页面、路由与服务端渲染",
  electron: "将网页界面与桌面运行环境结合",
  express: "处理服务端 HTTP 路由与接口",
  fastify: "处理服务端 HTTP 请求与接口",
  vite: "提供开发构建和资源打包",
  typescript: "为代码增加静态类型检查",
  "@nestjs/core": "组织后端服务模块与依赖",
  "@angular/core": "组织界面组件与应用模块",
  "@modelcontextprotocol/server": "向 AI 助手提供标准化工具接口",
  prisma: "组织数据库访问与数据模型",
};
export function extractFacts(collection) {
  const evidence = [],
    tech = [],
    features = [],
    functions = [],
    apis = [],
    events = [],
    imports = [],
    parseErrors = [],
    documents = [];
  const cite = (file, line = 1, quote = "", kind = "source") => {
    const eid = `source_${hash(`${file.path}:${file.sha256}:${line}:${quote}`).slice(0, 20)}`;
    if (!evidence.some((e) => e.id === eid))
      evidence.push({
        id: eid,
        path: file.path,
        origin: file.origin,
        line,
        sha256: file.sha256,
        quote: snippet(quote, 700),
        kind,
      });
    return eid;
  };
  for (const file of collection.files) {
    if (file.path.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(file.text);
        for (const section of ["dependencies", "devDependencies"])
          for (const [name, version] of Object.entries(pkg[section] || {}))
            if (Object.hasOwn(KNOWN, name)) {
              const position = file.text.indexOf(
                JSON.stringify(name),
                Math.max(0, file.text.indexOf(JSON.stringify(section))),
              );
              const line = position >= 0 ? file.text.slice(0, position).split("\n").length : 1;
              tech.push({
                name: KNOWN[name],
                detail: `通常用于${ROLES[name]}。${section === "devDependencies" ? "开发" : "运行"}依赖清单声明 ${name} ${version}；尚未证明当前运行路径使用了它。`,
                authority: "observed",
                evidence: [cite(file, line, `"${name}": ${JSON.stringify(version)}`)],
              });
            }
        if (pkg.name)
          documents.push({
            name: pkg.name,
            version: pkg.version || "未声明",
            evidence: [cite(file, 1, `name: ${pkg.name}; version: ${pkg.version || ""}`)],
          });
      } catch {
        parseErrors.push({ path: file.path, message: "依赖清单无法解析" });
      }
    }
    if (/\.html?$/.test(file.path)) {
      const html = htmlFacts(file.text);
      for (const item of html.headings)
        features.push({
          name: item.text,
          type: "页面栏目",
          authority: "observed",
          detail: "页面标记中存在此栏目；不据此断言业务已实现。",
          evidence: [cite(file, item.line, item.text)],
        });
      for (const item of html.controls)
        if (item.text)
          features.push({
            name: item.text,
            selector: item.id ? `#${item.id}` : null,
            type: "操作入口",
            authority: "observed",
            detail: `页面存在 ${item.type} 控件；是否可用需要运行验证。`,
            evidence: [cite(file, item.line, item.text)],
          });
      for (const link of html.links)
        if (link.text)
          features.push({
            name: link.text,
            type: "导航链接",
            authority: "observed",
            detail: `链接目标：${link.href || "未填写"}`,
            evidence: [cite(file, link.line, `${link.text} → ${link.href}`)],
          });
      for (const [i, script] of html.scripts.entries())
        if (script.text)
          parseSource(
            {
              ...file,
              path: `${file.path}#inline-${i + 1}.js`,
              text: script.text,
              origin: file.origin,
            },
            file,
            script.line - 1,
          );
    }
    if (/\.[cm]?[jt]sx?$/.test(file.path)) parseSource(file);
    const extension = file.path.split(".").at(-1);
    const language = {
      py: "Python",
      go: "Go",
      rs: "Rust",
      java: "Java",
      cs: "C#",
      php: "PHP",
      swift: "Swift",
      ts: "TypeScript",
      tsx: "TypeScript",
      js: "JavaScript",
      jsx: "JavaScript",
      mjs: "JavaScript",
      cjs: "JavaScript",
      html: "HTML",
      htm: "HTML",
      css: "CSS",
      vue: "Vue 单文件组件线索",
      svelte: "Svelte 组件线索",
    }[extension];
    if (language && !tech.some((t) => t.name === language))
      tech.push({
        name: language,
        detail: `发现 .${extension} 文件。扩展名属于语言线索，尚未验证构建或运行。`,
        authority: "inference",
        evidence: [cite(file, 1, file.path)],
      });
  }
  function parseSource(file, original = file, lineOffset = 0) {
    let ast;
    try {
      ast = parseCode(file);
    } catch (error) {
      parseErrors.push({ path: file.path, message: snippet(error.message) });
      return;
    }
    for (const e of ast.errors || [])
      parseErrors.push({ path: file.path, message: snippet(e.message) });
    walk(ast, (node, parent) => {
      const line = (node.loc?.start.line || 1) + lineOffset;
      if (
        ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(
          node.type,
        ) &&
        node.source?.value
      )
        imports.push({
          name: node.source.value,
          path: original.path,
          line,
          evidence: [cite(original, line, file.text.slice(node.start, node.end))],
        });
      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
          "ObjectMethod",
          "ClassMethod",
        ].includes(node.type)
      ) {
        const declaredName =
          node.id?.name ||
          nameOf(node.key) ||
          (parent?.type === "VariableDeclarator" ? nameOf(parent.id) : "") ||
          (parent?.type === "ObjectProperty" ? nameOf(parent.key) : "");
        const name = declaredName || `匿名函数@${line}`;
        const calls = [],
          conditions = [],
          returns = [],
          throws = [],
          computations = [],
          conditionDescriptions = [],
          returnDescriptions = [],
          errorDescriptions = [];
        function bodyWalk(value) {
          walk(value, (part) => {
            if (
              [
                "FunctionDeclaration",
                "FunctionExpression",
                "ArrowFunctionExpression",
                "ObjectMethod",
                "ClassMethod",
              ].includes(part.type)
            )
              return false;
            if (["CallExpression", "OptionalCallExpression", "NewExpression"].includes(part.type))
              calls.push(nameOf(part.callee) || "动态调用");
            if (part.type === "IfStatement" || part.type === "ConditionalExpression") {
              conditions.push(snippet(file.text.slice(part.test.start, part.test.end), 180));
              conditionDescriptions.push(describeExpression(part.test, file.text));
            }
            if (part.type === "ReturnStatement" && part.argument) {
              returns.push(snippet(file.text.slice(part.argument.start, part.argument.end), 200));
              returnDescriptions.push(describeExpression(part.argument, file.text));
            }
            if (part.type === "ThrowStatement") {
              throws.push(snippet(file.text.slice(part.start, part.end), 180));
              errorDescriptions.push(
                part.argument?.type === "NewExpression" &&
                  nameOf(part.argument.callee) === "Error" &&
                  part.argument.arguments[0]?.type === "StringLiteral"
                  ? part.argument.arguments[0].value
                  : snippet(file.text.slice(part.start, part.end), 100),
              );
            }
            if (part.type === "VariableDeclarator" && part.init && part.id.type === "Identifier")
              computations.push(
                `将 ${describeExpression(part.init, file.text)} 保存为 ${part.id.name}`,
              );
          });
        }
        bodyWalk(node.body);
        const code = file.text.slice(node.start, node.end);
        if (node.type === "ArrowFunctionExpression" && node.body.type !== "BlockStatement") {
          returns.push(snippet(file.text.slice(node.body.start, node.body.end), 200));
          returnDescriptions.push(describeExpression(node.body, file.text));
        }
        if (functions.length < 2000)
          functions.push({
            name,
            anonymous: !declaredName,
            path: original.path,
            line,
            endLine: (node.loc?.end.line || line) + lineOffset,
            params: node.params.map(
              (p) => nameOf(p) || snippet(file.text.slice(p.start, p.end), 80),
            ),
            async: node.async === true,
            calls: [...new Set(calls)],
            conditions,
            returns,
            throws,
            computations,
            conditionDescriptions,
            returnDescriptions,
            errorDescriptions,
            code: code.slice(0, 20000),
            codePartial: code.length > 20000,
            sha256: hash(code),
            evidence: [cite(original, line, snippet(code, 650))],
          });
        else if (
          !parseErrors.some((e) => e.message === "函数显示索引超过 2000 项，其余保留在原始输入中")
        )
          parseErrors.push({
            path: file.path,
            message: "函数显示索引超过 2000 项，其余保留在原始输入中",
          });
      }
      if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
        const callee = nameOf(node.callee),
          arg = node.arguments[0];
        if (callee === "require" && arg?.type === "StringLiteral")
          imports.push({
            name: arg.value,
            path: original.path,
            line,
            evidence: [cite(original, line, file.text.slice(node.start, node.end))],
          });
        if (callee === "fetch" || /\.(get|post|put|delete|patch|request)$/.test(callee)) {
          const endpoint =
            arg?.type === "StringLiteral"
              ? arg.value
              : arg?.type === "TemplateLiteral" && !arg.expressions.length
                ? arg.quasis[0].value.cooked
                : null;
          if (endpoint)
            apis.push({
              endpoint,
              method:
                callee === "fetch"
                  ? node.arguments[1]?.properties?.find((p) => nameOf(p.key) === "method")?.value
                      ?.value || "GET"
                  : callee.split(".").at(-1).toUpperCase(),
              path: original.path,
              line,
              detail: "静态调用声明；未请求该接口。",
              evidence: [cite(original, line, file.text.slice(node.start, node.end))],
            });
        }
        if (/\.(addEventListener|on|handle)$/.test(callee) && arg?.type === "StringLiteral") {
          const object = node.callee.object,
            targetId =
              object?.type === "CallExpression" &&
              nameOf(object.callee) === "document.getElementById" &&
              object.arguments[0]?.type === "StringLiteral"
                ? object.arguments[0].value
                : null;
          const handler = node.arguments[1],
            callbackCalls = [];
          if (["ArrowFunctionExpression", "FunctionExpression"].includes(handler?.type))
            walk(handler.body, (part) => {
              if (["CallExpression", "OptionalCallExpression"].includes(part.type))
                callbackCalls.push(nameOf(part.callee));
            });
          events.push({
            event: arg.value,
            callee,
            targetId,
            handler: nameOf(handler) || "内联回调",
            callbackCalls: uniqueValues(callbackCalls),
            path: original.path,
            line,
            evidence: [cite(original, line, file.text.slice(node.start, node.end))],
          });
        }
      }
    });
  }
  for (const item of imports) {
    const dependency = item.name.startsWith("@")
      ? item.name.split("/").slice(0, 2).join("/")
      : item.name.split("/")[0];
    if (Object.hasOwn(KNOWN, dependency) && !tech.some((t) => t.name === KNOWN[dependency]))
      tech.push({
        name: KNOWN[dependency],
        detail: `通常用于${ROLES[dependency]}。源代码声明导入 ${item.name}；未验证运行。`,
        authority: "observed",
        evidence: item.evidence,
      });
  }
  if (!tech.length && collection.files.some((f) => /\.html?$/.test(f.path))) {
    const f = collection.files.find((f) => /\.html?$/.test(f.path));
    tech.push({
      name: "HTML 网页",
      detail: "存在 HTML 页面标记；不能由此推断后端技术。",
      authority: "observed",
      evidence: [cite(f, 1, "HTML 页面结构")],
    });
  }
  const unique = (items, key) => [...new Map(items.map((x) => [key(x), x])).values()];
  return {
    tech,
    features: unique(features, (x) => `${x.name}:${x.type}`),
    functions,
    apis: unique(apis, (x) => `${x.method}:${x.endpoint}:${x.path}:${x.line}`),
    events,
    imports,
    parseErrors,
    evidence,
    documents,
  };
}
const uniqueValues = (values) => [...new Set(values)];

export function explainFunction(fn) {
  const parts = [`接收${fn.params.length ? `参数 ${fn.params.join("、")}` : "零个显式参数"}`];
  if (fn.computations?.length) parts.push(fn.computations.join("；"));
  if (fn.conditions.length)
    parts.push(`检查条件：${(fn.conditionDescriptions || fn.conditions).join("；")}`);
  if (fn.calls.length) parts.push(`调用 ${fn.calls.join("、")}`);
  if (fn.throws.length)
    parts.push(`显式错误包括：${(fn.errorDescriptions || fn.throws).join("；")}`);
  if (fn.returns.length) parts.push(`返回 ${(fn.returnDescriptions || fn.returns).join("；")}`);
  return `${fn.async ? "异步函数。" : ""}${parts.join("；")}。这是当前函数体的静态语法解释；嵌套回调单独提取，动态调用仍需运行验证。${fn.codePartial ? "源码显示达到 20000 字符，完整内容见输入快照。" : ""}`;
}
