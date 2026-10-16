import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
for (const dir of ["src", "public", "scripts"])
  for (const name of await fs.readdir(dir))
    if (/\.(mjs|js)$/.test(name))
      execFileSync(process.execPath, ["--check", `${dir}/${name}`], { stdio: "inherit" });
console.log("源码语法检查完成。");
