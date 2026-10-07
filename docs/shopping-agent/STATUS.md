# A 阶段交付记录

日期：2026-10-07。本记录描述 A 的首阶段交付与实际验证结果；提交和推送状态以当前 Git 记录为准。

| 里程碑 | 当前结论 |
|---|---|
| C0 | 未完成：已记录 A 评审需求，B 的共同 schema/fixtures 尚缺，不能宣称共同基线已冻结 |
| C1 | A 的独立 deterministic mock 原型：候选、最终含费报价、明确确认/取消、模拟订单、状态恢复及工具限制已实现；共同契约映射仍待 C0 |
| C2 | 未完成：没有 B HTTP 服务，主运行流程明确为 mock |
| C3 | A 侧确认/预算/重复点击/未知结果/恢复已实现和测试；B 的数据库、库存、支付及联合负面验收尚未完成 |
| C4 | 未完成：Planner/tool loop 已有边界与 mock 测试，没有真实模型配置或模型调用验收 |

修改限于 A 所有目录与根 workspace/lock 集成配置。保留既有协议、原始示例、网站、Skill 和 B 目录。

## 实际验证

环境：Windows、本机 Bun 1.4.2，仓库 packageManager 约定仍为 bun@1.3.13。

- `bun run shopping:check`：通过 Runtime/API/E2E TypeScript 检查及 UI JavaScript 语法/静态文件检查（UI 检查不是 TypeScript 类型检查）。
- `bun run shopping:build`：通过；Runtime/API 用 Bun 直接执行 TypeScript，build 执行类型检查，UI 生成 `dist` 静态副本。
- 最终 `bun test`：118 项通过，0 失败，15 个测试文件。A 新增 35 项：24 项 Runtime、4 项真实本地 HTTP OCP read consumer、7 项 A API HTTP E2E；其余 83 项为原仓库测试。
- Playwright + 本机 Chrome 的独立无头 context：14 项页面检查通过，包括 31 元超预算阻断、28 元含费报价、明确按钮确认、支付/履约分离、刷新原订单恢复、移动端无横向溢出、模拟浏览器响应丢失时锁住新购买/取消/替换、查询原订单及无 JS 异常。
- 已视觉检查桌面报价与移动端订单截图。浏览器 QA 报告和截图在 `.codex-tmp/shopping-browser-qa`；local-only preview 在 `http://127.0.0.1:4310`。
- `git diff --check`：通过。未修改原协议、示例、网站、Skill 或 B 所有目录。

过程中测试目录的 workspace 导入曾导致检查失败，已改为引用本地 Runtime 源码并复验通过。浏览器中发现未知结果时取消/替换按钮与旧成功标题的问题，已修正并通过故障场景复验。

默认命令执行器和内置浏览器控制器受到 sandbox setup refresh 错误影响；命令经已请求的沙箱外执行完成，页面通过独立无头浏览器验证。内置预览打开请求返回 queued，因此不把它记录为已确认可见的桌面窗口。

契约版本：共同 shopping-contracts 尚不存在，没有冻结版本；A 的私有开发模块版本为 0.1.0。`local-mock-v1` 只用于 A 的 mock 签发/验签测试。

未运行/尚缺：B 的共同 schema/fixtures、商家 HTTP 交易联调、商家数据库/库存/支付原子幂等验收、生产账户、真实 LLM 和真实付款。下一步必须先共同冻结 C0，再接 B 的服务和测试配置；需要的字段和语义列在 `C0-REVIEW.md`。
