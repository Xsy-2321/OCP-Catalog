# 购物助手整合状态

日期：2026-10-09。项目由用户独立维护，当前交付基线为 `codex/shopping-integration` 的 `dccac90`，已在本地提交。推送和合入 main 通过 PR 审查与 CI 门禁执行，远端状态以 PR 结果为准。本页汇总当前实现、已验证行为和可复现检查；使用与恢复方法见 [项目说明](README.md)。

| 里程碑 | 当前结论 |
|---|---|
| C0 | 共同应用契约为 shopping-contracts 0.2.0、商家 SQLite schema 3；保留旧单商品自取接口与历史订单 |
| C1 | A/B 各自可运行；独立 mock 保留为显式开发模式 |
| C2 | 默认 HTTP 路径已接 B：OCP 搜索/Resolve、最终报价、明确确认、Ed25519 授权、模拟结账和订单查询 |
| C3 | 联合 HTTP、持久库、并发幂等、库存、授权拒绝、响应丢失和重启恢复已有验收；实际 A/B 路径由联合测试覆盖 |
| C4 | 默认 deepseek-flash，支持混合商品与配送；真实模型曾完成针对性验收，自动门禁使用本地模型协议 fixture |
| 本地双端 | 统一启动器提供门户、用户入口与商家只读入口；独立预览及原订单恢复已有验收；继续使用 schema 3 |
| 最新工程门禁 | 全源码测试 1246 pass / 0 fail，构建、类型检查与 lint 通过；包含共享契约、CLI、官网、三语言示例和购物整合回归 |
| 最新前端回归 | 步骤卡片、门户、商家展示及快捷示例回归通过；覆盖提交中的示例保护、单杯需求重置、旧报价失效、连接状态、响应式布局与重试按钮对比度 |

页面支持手动关键词与Agent自然语言规划，同商家最多10行需求、合计1–20杯。可选择自取或配送，配送信息通过表单填写，整单报价包含配送费。商家只读页展示原服务目录、SQLite库存和历史订单，付款及履约分开展示；其刷新不会结算未决购买。付款及履约为本地模拟。模型不能确认或购买；用户与商家演示身份不构成生产账户系统。当前没有Registration跨商户发现、完整账户登录、商品编辑、补库存、接单、退款、店员权限、真实物流、真实支付或生产部署。

已完成未决会话恢复入口、跨标签页同步、重启候选重新验证、表单/报价一致性、实际商家 health 和错误提示；商品页、公布 URL 校验、未知库存策略、单 capability 筛选、三语言分页和网站 lint 已修复。最新界面修复覆盖快捷示例、连接标签、窄窗口布局、重试按钮可读性和背景静态资源。

## 工程与运行约定

门禁统一使用仓库约定的 Bun 1.3.13。CI 在 Windows 与 Ubuntu 执行冻结依赖安装、源码输入检查、构建、类型、lint、完整源码测试、文档、三语言示例、安全检查，以及官网和购物浏览器回归。门户、商家展示及快捷示例三个浏览器入口已纳入 CI。

CI 使用源码中的测试 fixture、临时身份与签名，以及独立测试服务和数据；不配置真实模型凭据。截图与临时报告不通过 artifacts 上传。可复验入口见 [根命令](../../package.json)、[CI 工作流](../../.github/workflows/competition-readiness.yml)、[联合 HTTP 测试](../../tests/shopping-e2e/http-flow.test.ts)、[门户浏览器回归](../../tests/shopping-e2e/portal-entry-browser-check.mjs)、[商家展示回归](../../tests/shopping-e2e/merchant-presentation-check.mjs) 和 [快捷示例回归](../../apps/shopping-agent-web/scripts/presets-browser-check.mjs)。

从仓库根目录使用固定版本 Bun，可复现主要门禁：

```sh
bun install --frozen-lockfile
bun run engineering:inputs
bun run build
bun run typecheck
bun run shopping:check
bun run lint
bun run test:all
bun run site:check
bun run skill:check
bun run security:check
bun run site:browser
bun run shopping:browser
bun run shopping:basket:browser
bun run shopping:expiry:browser
bun run shopping:merchant:browser
bun run shopping:portal:browser
bun run shopping:merchant:presentation:browser
bun run shopping:presets:browser
```

浏览器回归需要已安装的 Playwright 和 Chrome/Chromium；CI 安装独立测试浏览器。Python 和 Go 参考节点检查分别见 [Python 示例](../../examples/python/README.md) 与 [Go 示例](../../examples/go/README.md)。

HTTP 模式必须显式配置受信商家和授权参数，缺配置时拒绝启动。mock 必须显式选择，不能作为 HTTP 故障的自动回退。

会话存储绑定运行模式和商家环境，不能将旧会话复用到不同环境。未知交易保持原购买尝试与幂等键，并在同一用户的所有会话中阻止新购买；只能查询原结果。明确拒绝后可取得新报价，必须重新确认，历史尝试保留。

共同授权证明只在确认后的后端内存中签发，不进入公共会话、模型输入或持久会话。授权配置与旧版本升级要求见 [设置与恢复说明](README.md)。

灾难恢复仍有明确边界：数据库与外部标记同时回退到同一旧快照无法识别；数据库提交后标记更新前崩溃会停止操作，需要人工核对原购买事实。两项 [构建依赖例外](../../scripts/dependency-audit-exceptions.json) 受安全门禁限制，2026-11-07 到期。

后续架构演进按实际需求开展：商家数据库下一次结构升级时拆分迁移步骤，第二调用渠道或商家出现时抽应用用例，第二模型协议前抽传输接口，真实支付接入前重新设计交易登记、外部请求、结算和恢复流程。

## 历史记录

原 A 首阶段在 Bun 1.4.2 上记录 118 项测试与 14 项 mock 页面检查。它们仅描述整合前快照，不能用作当前 HTTP 验收结果；完整原文可从 main 的 Git 历史查看。
