import test from "node:test";
import assert from "node:assert/strict";
import { htmlFacts } from "../src/collect.mjs";
import { extractFacts } from "../src/facts.mjs";
import { hash } from "../src/storage.mjs";
import { projectView } from "../src/client.mjs";
import { compareFacts } from "../src/analysis.mjs";

test("内联脚本保留原始换行和函数所在 HTML 行号", () => {
  const text =
    '<html>\n<script\n type="module">\nfunction hello(){\nreturn 1;\n}\n</script>\n</html>';
  const f = { path: "index.html", text, origin: "index.html", sha256: hash(text) };
  assert.ok(htmlFacts(text).scripts[0].text.includes("\nfunction hello"));
  const facts = extractFacts({ files: [f] });
  assert.equal(facts.functions[0].line, 4);
  assert.equal(facts.functions[0].path, "index.html");
});

test("研究视图按实际数量分页并保留后续位置", () => {
  const evidence = [];
  const job = {
    id: "example",
    status: "completed",
    report: { functions: [{ name: "a" }, { name: "b" }], limitations: [], evidence },
  };
  const view = projectView(job, "functions", 0, 1);
  assert.equal(view.total, 2);
  assert.equal(view.nextOffset, 1);
  assert.deepEqual(view.items, [{ name: "a" }]);
});

test("无法解析的代码保留具体问题，不伪造函数列表", () => {
  const text = "export function broken( {";
  const facts = extractFacts({
    files: [{ path: "bad.js", text, origin: "bad.js", sha256: hash(text) }],
  });
  assert.equal(facts.functions.length, 0);
  assert.ok(facts.parseErrors.length);
});

test("同名函数比较保留匹配不确定性", () => {
  const make = (text) => ({
    files: [{ path: "same.js", text, origin: "same.js", sha256: hash(text) }],
  });
  const result = compareFacts(
    make("function same(){return 1;} function same(){return 2;}"),
    make("function same(){return 3;}"),
  );
  assert.ok(result.functions.some((f) => f.name === "same" && f.status === "unknown"));
});

test("依赖清单证据指向实际依赖行，并忽略对象原型名称", () => {
  const text = '{\n"dependencies": {\n"express": "5.1.0",\n"constructor": "1"\n}\n}';
  const facts = extractFacts({
    files: [{ path: "package.json", text, origin: "package.json", sha256: hash(text) }],
  });
  assert.equal(facts.tech.length, 1);
  assert.equal(facts.evidence.find((e) => e.id === facts.tech[0].evidence[0]).line, 3);
});

test("匿名回调只移动行号时不被误报为删除加新增", () => {
  const make = (text) => ({
    files: [{ path: "same.js", text, origin: "same.js", sha256: hash(text) }],
  });
  const result = compareFacts(
    make('document.addEventListener("click",()=>run());'),
    make('\n\ndocument.addEventListener("click",()=>run());'),
  );
  assert.equal(result.functions.length, 0);
  assert.equal(result.files.length, 1);
});
