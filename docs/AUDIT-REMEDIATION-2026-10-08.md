# 审计整改记录 · 2026-10-08

本记录保存该轮实施与验收结果；后续独立复核中保留的 CLI update/参考节点问题及当前存储职责见 [工程验收问题整改](ENGINEERING-FOLLOWUP-2026-10-09.md) 和 [工程优化记录](ENGINEERING-OPTIMIZATION-2026-10-08.md)。

依据 `.codex-tmp/project-audit-20261008/REPORT.md` 完成本地整改。保留工作区原有未提交成果，未提交、推送或部署；未重启原有演示服务，未修改原演示数据库、签名密钥或用户配置。验收使用独立临时目录、本地服务、虚构模型响应和模拟支付。

## 已确认问题的修复

| 原问题 | 最终行为 | 主要实现与回归 |
| --- | --- | --- |
| P1 Windows runner 参数被解释为 shell 命令 | 所有启动路径均使用参数数组且 `shell:false`；已知 npm 的 ocp/npx 包装器转到 JS 入口；拒绝任意 batch 和 shell launcher | `skills/ocp-catalog/scripts/ocp-skill-runner.ts`、`packages/ocp-cli/src/skill-runner.test.ts`；npm/plugin 副本已同步 |
| P1 SDK 跨源重定向泄漏 API key | GET、POST、显式 activity 和自动 activity 上报统一禁止重定向 | `packages/ocp-client/src/index.ts`、`redirect.test.ts`；覆盖 301/302/303/307/308、同源重定向和独立 activity key |
| P2 商家等待写锁时引用过期 | 在取得写锁后重新读时钟验证首次交易；开始时间仍用于耗时；完成交易的幂等重放保留 | `packages/merchant-core/src/checkout.ts`、`checkout-expiry.test.ts` |
| P2 官网复制的查询示例协议漂移 | manifest 和请求均使用共享 schema；`query` 是字符串，`query_mode/query_pack` 是顶层字段；生成后校验 | `apps/ocp-site-web/src/lib/useCatalogManifest.ts` 与对应测试；浏览器对实际渲染 JSON 再校验 |
| P2 manifest 首次失败后不能恢复 | 错误不缓存，成功缓存 60 秒；重试、刷新、超时、取消与并发合并；刷新后重开仍可使用成功缓存 | 同上；包含 503 → 重开恢复、刷新 → 重试、缓存到期及取消回归 |
| P2 三语言节点输入校验不足 | 非法 JSON、数组/非对象请求、字段类型、页大小与范围等统一返回结构化 400 | `examples/typescript`、`examples/python`、`examples/go`；共享 `fixtures/query-conformance/cases.json` 87 项矩阵 |
| P2 一个不可表示的目录价格拖垮搜索 | 逐商品验证精确整数分，跳过无效价格并显示数量诊断；有效候选继续可用；最终报价与授权仍严格校验 | `packages/agent-runtime/src/ocp-consumer.ts` 与对应测试；未引入价格四舍五入 |

Unicode 查询长度按当前共享 schema 的 500 个 Unicode code point 统一，正向边界为 500，负向边界为 501。SDK 安全回归在 HTTP handler 中立即记录请求头快照，避免 Bun 请求对象释放后的误判。

## 已落实的优化方向

1. **可重复运行与 CI。** 根启动/验收命令先校验 Bun 1.3.13；1.4.2 会明确拒绝。安装可使用冻结 lockfile。skill installer 测试隔离并恢复 CODEX_HOME/CLAUDE_CONFIG_DIR，新增自定义目录正向验证。CI 增加 Ubuntu/Windows 矩阵、固定 Node/Python/Go、依赖安全扫描以及官网和购物浏览器门禁；浏览器截图和报告可以作为 artifacts，数据库和密钥不在上传范围内。
2. **共享协议事实来源。** 官网采用 `@ocp-catalog/ocp-schema`；三语言消费同一个正负向 fixture。该矩阵与 TypeScript 节点同时校验协议请求及协议响应。
3. **会话与订单索引。** 默认运行时采用 `SqliteSessionStore`，按 user/updated_at 和 user/pending/updated_at 建索引；待处理查询保留 unknown、checkout_pending 及 processing attempt。旧 JSON 一次性事务导入并保留快照，重复启动不重新导入旧状态。损坏记录停止操作；迁移后数据库丢失不会重建空记录。数据库 CHECK 防止非法 phase、owner 或 attempt 被索引遗漏。此前 SQLite 预览库也会在完整校验后事务升级约束，原未决记录保留。商家订单增加 merchant/catalog/created_at/order_id 复合索引和元组游标，回归验证分页使用索引。
4. **官网网络恢复。** 统一请求层约束 headers/body 读取超时并响应取消；目录及 activity 请求结束后再调度轮询，避免重叠。目录搜索失败显示“暂不可用”和未知计数；成功的空数组才表示没有目录。手机竖屏和横屏都保留目录刷新按钮。

真实身份、商家/店员权限、退款、履约状态机、跨商家发现与真实支付属于报告中带条件的后续业务建设。本次保持本机演示范围；这些能力尚未实现，不能据此用于公开经营。扩展时先定义角色与权限、可追溯审计及订单状态迁移，再分别设计支付授权、对账和补偿验收。

## 依赖安全整改

在现有主版本约束内更新依赖并重新解析传递依赖，锁定 Playwright 1.64.0 用于浏览器 CI。冻结安装通过且没有进一步改动 lockfile。React Router 已解析为 7.18.4，PostCSS 为 8.5.29，达到相应上游修补版本要求。[React Router 公告](https://github.com/remix-run/react-router/security/advisories/GHSA-qwww-vcr4-c8h2)、[PostCSS 公告](https://github.com/postcss/postcss/security/advisories/GHSA-fxqj-rqcc-2cmp)。

扫描从 **21 条公告降至 2 条：1 high、1 moderate**，并非零风险：

| 剩余公告 | 当前版本与调用面 | 处置 |
| --- | --- | --- |
| [braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | 3.0.3，Tailwind/micromatch 的仓库构建 glob；站点只服务静态产物 | 上游当前没有修补版本；只允许该版本、该公告及 severity 的临时例外 |
| [postcss-selector-parser GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) | 6.0.10/6.1.4，处理仓库内 CSS；没有在线接收任意 CSS 的构建入口 | 修补版本 7.1.6 超出当前父依赖主版本约束；后续独立升级并复验 Tailwind 工具链 |

例外写在 `scripts/dependency-audit-exceptions.json`，**2026-11-07（北京时间）到期**。`bun run security:check` 对新公告、severity/版本变化、例外到期或扫描失败均拒绝通过；剩余风险不会被普通 audit 输出隐藏。新增线上构建、不可信 CSS 或构建 glob 输入前须重新评估这些例外。

## 验收结果

本机 Windows，Bun 1.3.13：

| 验收 | 结果 |
| --- | --- |
| 完整源码测试 | **1060 pass / 0 fail**，60 文件，5116 断言 |
| 强制 build | 14/14 tasks，0 缓存 |
| 强制 typecheck | 24/24 tasks，0 缓存；SQLite 兼容补充后 shopping:check 也再次通过 |
| 强制 lint | 15/15 tasks，0 缓存 |
| shopping:check / site:check / skill:check | 全通过；官网 36 docs routes / 22 artifacts / 7 updates |
| Python 示例 | 10 tests，通过，包含共享 87 项矩阵 |
| Go 示例 | `go test ./...` 通过 |
| 冻结安装 | 通过，Checked 368 installs across 388 packages，无改动 |
| 依赖安全门禁 | 2 条已登记构建例外，0 条未登记公告 |
| 购物浏览器恢复 | 26 项通过 |
| 篮子购物浏览器 | 17 项通过 |
| 商家浏览器与进程重启 | 32 项通过 |
| 官网浏览器 | 6 组恢复场景通过；桌面、390×844 竖屏、844×390 横屏；0 page errors；桌面/手机截图已人工查看 |
| diff whitespace | `git diff --check` 通过 |

浏览器调用使用本地模型协议 fixture，没有请求真实模型，没有真实付款或外部商家交易。CI 配置已接入，尚未提交触发远端 Ubuntu/Windows 流水线；本机结果不等同于远端 CI 已运行。

官网验收由 Bun 仅提供本地静态服务，Node 负责 Playwright，避免 Windows Bun 直接调用浏览器驱动时的挂起；启动 15 秒、驱动 55 秒、整体 60 秒超时，结束时关闭本次测试服务。此次浏览器检查也验证并修复了“刷新后再次打开详情总是绕过缓存”和手机刷新按钮隐藏的问题。

日志与截图：

- `.codex-tmp/remediation-20261008/`：各门禁日志、依赖原始 JSON、原有工作区补丁快照与状态记录。
- `.codex-tmp/site-browser-recovery/`：report.json、desktop.png、mobile.png。
- `.codex-tmp/integration/browser-resilience/`、`browser-basket/`：购物恢复与篮子证据。
- `.codex-tmp/merchant-preview-acceptance/run-N269GN/`：本次商家浏览器证据。

## 使用和兼容注意

`OCP_CLI_COMMAND` 的旧 shell 表达式改为 JSON argv，例如 `["bun", "/path/to/ocp.js"]`；任意 Windows batch 或 shell launcher 会被拒绝。SDK 同源重定向也被拒绝，调用时使用规范的最终 URL。

会话迁移后 `sessions.sqlite` 是事实来源，原 JSON 是迁移快照。回滚程序前保留整个数据目录并使用迁移前备份，不能让旧版程序用过时 JSON 继续购买。FileSessionStore 在检测到迁移标记后会委派 SQLite，以兼容当前调用者。

本机全局 Bun 仍为 1.4.2。需要运行根脚本时，在当前 PowerShell 会话把已验证的 1.3.13 放到 PATH，确保子命令使用相同版本；未修改全局安装：

```powershell
Set-Location 'E:\OCP-Catalog'
$projectBunDirectory = (Resolve-Path '.\.codex-tmp\integration\runtime\1.3.13\bun-windows-x64').Path
$env:PATH = "$projectBunDirectory;$env:PATH"
bun run runtime:check
bun run test:all
bun run security:check
```

新 checkout/SDK/runner 保护、模拟支付、用户确认、原交易幂等与未知购买阻断由回归覆盖。验收通过不表示已穷尽所有攻击路径。
