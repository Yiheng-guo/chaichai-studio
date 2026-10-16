# 来源与第三方声明

拆拆研究台是独立扩展项目，通过本地命令行调用 [ChaiChai](https://github.com/hubooooooo/chaichai)，不替换其核心代码，也不代表原项目维护者。

ChaiChai 原作者版权声明：Copyright (c) 2026 morluto；Copyright (c) 2026 hubooooooo。ChaiChai 采用 MIT 许可证，完整文本保留于 `licenses/ChaiChai-MIT.txt`。使用、复制或分发 ChaiChai 时应同时保留其自身的第三方声明与各组件许可证。

本扩展使用 @babel/parser（MIT）解析 JavaScript / TypeScript，使用 diff（BSD-3-Clause）生成文本差异；依赖版本由 package-lock.json 锁定。安装后的原始版权与许可证保留在相应依赖包中。

MCP 接口使用 Model Context Protocol TypeScript SDK 的 server/client 2.3.1（Apache-2.0，Anthropic, PBC）；输入校验使用 Zod 4.4.3（MIT）；HTML 解析使用 parse5 8.0.1（MIT）。客户端 SDK 仅作为开发测试依赖。

本仓库不包含 Ghidra、Hopper、IDA、JEB 等分析引擎，也不授予这些引擎的使用或再分发权。它们的安装及授权由使用者另行提供。示例服务代码由本扩展提供，采用本仓库 MIT 许可证。
