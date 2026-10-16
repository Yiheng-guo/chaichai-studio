import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { parse } from "parse5";
import { hash } from "./storage.mjs";

export const LIMITS = {
  files: 200,
  bytes: 8 * 1024 * 1024,
  fileBytes: 512 * 1024,
  webBytes: 2 * 1024 * 1024,
  scripts: 12,
};
const SKIP = new Set([
  "node_modules",
  ".git",
  ".data",
  ".next",
  ".cache",
  "coverage",
  "vendor",
  ".venv",
  "dist-tests",
]);
const TEXT = new Set([
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".vue",
  ".svelte",
  ".css",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".php",
  ".md",
  ".yaml",
  ".yml",
  ".toml",
  ".swift",
]);
export function htmlFacts(text) {
  const tree = parse(text, { sourceCodeLocationInfo: true });
  const facts = { title: "", headings: [], controls: [], links: [], forms: [], scripts: [] };
  const content = (n) =>
    (n.childNodes || [])
      .map((x) => (x.nodeName === "#text" ? x.value : content(x)))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  const walk = (node) => {
    const attrs = Object.fromEntries((node.attrs || []).map((a) => [a.name, a.value]));
    const line = node.sourceCodeLocation?.startLine || 1,
      label = content(node);
    if (node.tagName === "title") facts.title = label;
    if (/^h[1-4]$/.test(node.tagName || "") && label) facts.headings.push({ text: label, line });
    if (["button", "input", "select", "textarea"].includes(node.tagName))
      facts.controls.push({
        text:
          label ||
          attrs["aria-label"] ||
          (node.parentNode?.tagName === "label" ? content(node.parentNode) : "") ||
          attrs.placeholder ||
          attrs.name ||
          attrs.type ||
          node.tagName,
        type: attrs.type || node.tagName,
        id: attrs.id || "",
        name: attrs.name || "",
        line,
      });
    if (node.tagName === "a") facts.links.push({ text: label, href: attrs.href || "", line });
    if (node.tagName === "form")
      facts.forms.push({ action: attrs.action || "", method: attrs.method || "get", line });
    if (
      node.tagName === "script" &&
      !["application/ld+json", "application/json", "importmap"].includes(attrs.type)
    )
      facts.scripts.push({
        src: attrs.src || "",
        text: attrs.src ? "" : (node.childNodes || []).map((x) => x.value || "").join(""),
        line: node.sourceCodeLocation?.startTag?.endLine || line,
      });
    for (const child of node.childNodes || []) walk(child);
  };
  walk(tree);
  return facts;
}
export function isPrivateAddress(address) {
  const clean = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(clean)) {
    const [a, b] = clean.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(clean)) {
    if (clean.startsWith("::ffff:")) {
      const tail = clean.slice(7);
      return net.isIPv4(tail) ? isPrivateAddress(tail) : true;
    }
    return !/^2[0-9a-f]{3}:/.test(clean) || /^2001:(db8|0|10|20):/.test(clean);
  }
  return true;
}
export async function fetchPublic(input, signal, redirects = 0) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    throw new Error("网页采集仅支持不含账号信息的 HTTPS 公网地址。");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((x) => isPrivateAddress(x.address)))
    throw new Error("网页采集不访问本机、内网或保留地址；内部系统请使用本地导出资料。");
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    let size = 0,
      settled = false,
      chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "ChaiChai-Studio/0.1 (public-page-research)",
          Accept: "text/html,application/javascript,text/javascript,application/json;q=0.8",
        },
        lookup: (_host, options, callback) =>
          options?.all
            ? callback(null, [selected])
            : callback(null, selected.address, selected.family),
        timeout: 15000,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (redirects >= 4 || !res.headers.location)
            return finish(new Error("网页重定向过多或缺少目标。"));
          fetchPublic(new URL(res.headers.location, url).href, signal, redirects + 1).then(
            (value) => finish(null, value),
            (error) => finish(error),
          );
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return finish(new Error(`网页返回 HTTP ${res.statusCode}，未绕过登录或访问限制。`));
        }
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > LIMITS.webBytes) {
            req.destroy();
            finish(new Error("网页响应超过 2 MB，已停止采集。"));
          } else chunks.push(chunk);
        });
        res.on("error", (error) => finish(error));
        res.on("end", () =>
          finish(null, {
            url: url.href,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] || ""),
            fetchedAt: new Date().toISOString(),
          }),
        );
      },
    );
    const abort = () => {
      req.destroy();
      finish(new Error("任务已取消"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    req.on("timeout", () => req.destroy(new Error("网页采集超时")));
    req.on("error", (error) => finish(error));
  });
}
export async function collectTarget(target, { directory, signal, progress = async () => {} } = {}) {
  const files = [],
    omissions = [];
  let bytes = 0,
    examined = 0;
  const add = (name, text, origin = name) => {
    if (
      Buffer.byteLength(text) > LIMITS.fileBytes ||
      bytes + Buffer.byteLength(text) > LIMITS.bytes ||
      files.length >= LIMITS.files
    ) {
      omissions.push(`${name}：超过文件数量或文本容量限制`);
      return;
    }
    bytes += Buffer.byteLength(text);
    files.push({ path: name, text, origin, sha256: hash(text), size: Buffer.byteLength(text) });
  };
  if (/^https?:\/\//i.test(target)) {
    const page = await fetchPublic(target, signal);
    if (!/text\/html/i.test(page.contentType)) throw new Error("目标不是可解析的 HTML 页面。");
    const safePath = (value) =>
      value
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.replace(/[^\w.-]/g, "_"))
        .filter((segment) => segment !== "." && segment !== "..")
        .join("/");
    const pagePath = new URL(page.url).pathname;
    const htmlName = pagePath.endsWith("/")
      ? `${safePath(pagePath) ? safePath(pagePath) + "/" : ""}index.html`
      : /\.html?$/.test(pagePath)
        ? safePath(pagePath)
        : `${safePath(pagePath) || "index"}.html`;
    add(htmlName, page.body, page.url);
    const scripts = htmlFacts(page.body).scripts;
    for (const [i, script] of scripts.entries()) {
      if (signal?.aborted) throw new Error("任务已取消");
      if (i >= LIMITS.scripts) {
        omissions.push("页面脚本超过 12 项，只采集前 12 项。");
        break;
      }
      if (!script.src) continue;
      const source = new URL(script.src, page.url);
      if (source.origin !== new URL(page.url).origin) {
        omissions.push(`${source.href}：未采集跨域脚本`);
        continue;
      }
      await progress(`读取同源脚本 ${i + 1}/${Math.min(scripts.length, LIMITS.scripts)}`);
      try {
        const result = await fetchPublic(source.href, signal);
        let name = safePath(source.pathname) || `scripts/bundle-${i + 1}.js`;
        if (!/\.[cm]?js$/.test(name)) name += ".js";
        if (files.some((file) => file.path === name))
          name = `scripts/${hash(source.href).slice(0, 12)}.js`;
        add(name, result.body, result.url);
      } catch (error) {
        if (signal?.aborted) throw error;
        omissions.push(`${source.href}：${error.message}`);
      }
    }
    omissions.push(
      "仅采集初始 HTML 与有限同源脚本；未执行页面、登录、点击或观察后台。动态渲染内容可能缺失。",
    );
  } else {
    const root = await fs.realpath(path.resolve(target)).catch(() => {
      throw new Error("找不到这个本地路径，请检查路径是否完整。");
    });
    const info = await fs.stat(root);
    if (root.endsWith(".app"))
      return { kind: "native", root, files: [], omissions: [], bytes: 0, examined: 0 };
    if (!info.isDirectory() && !TEXT.has(path.extname(root).toLowerCase()))
      return { kind: "binary", root, files: [], omissions: [], bytes: 0, examined: 1 };
    async function walk(dir, prefix = "", depth = 0) {
      if (signal?.aborted) throw new Error("任务已取消");
      if (depth > 20 || examined >= 5000) {
        omissions.push(`${prefix || "."}：目录遍历达到资源限制`);
        return;
      }
      const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const e of entries) {
        if (signal?.aborted) throw new Error("任务已取消");
        if (examined++ >= 5000) {
          omissions.push("已扫描 5000 个目录项，其余未检查。");
          break;
        }
        const rel = path.posix.join(prefix, e.name),
          full = path.join(dir, e.name);
        if (e.isSymbolicLink()) {
          omissions.push(`${rel}：不跟随符号链接`);
          continue;
        }
        if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
        if (e.isDirectory()) {
          if (files.length < LIMITS.files && bytes < LIMITS.bytes) await walk(full, rel, depth + 1);
          else omissions.push(`${rel}：达到资源限制，未遍历`);
        } else if (e.isFile() && TEXT.has(path.extname(e.name).toLowerCase())) {
          const stat = await fs.stat(full);
          if (stat.size > LIMITS.fileBytes) {
            omissions.push(`${rel}：单文件超过 512 KB`);
            continue;
          }
          add(rel, await fs.readFile(full, "utf8"), full);
        }
      }
    }
    if (info.isDirectory()) await walk(root);
    else add(path.basename(root), await fs.readFile(root, "utf8"), root);
  }
  if (!files.length)
    throw new Error("没有找到可分析的文本文件；请选择网页或含代码、HTML、配置的目录。");
  if (directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const out = path.join(directory, file.path);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, file.text, { mode: 0o600 });
    }
  }
  return {
    kind: "text",
    root: directory,
    files,
    omissions,
    bytes,
    examined,
    capturedAt: new Date().toISOString(),
    limits: LIMITS,
  };
}
