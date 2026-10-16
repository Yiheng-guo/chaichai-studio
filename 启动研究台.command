#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "请先准备 Node.js 24.15 或更新版本，再运行研究台。"
  read -r "?按回车关闭"
  exit 1
fi
if [[ ! -d node_modules ]]; then
  echo "首次使用请在本目录执行 npm ci。不会自动安装或修改系统软件。"
  read -r "?按回车关闭"
  exit 1
fi
echo "请在浏览器打开 http://127.0.0.1:${PORT:-5197}"
node src/server.mjs
