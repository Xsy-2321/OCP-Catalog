# 工程优化记录 · 2026-10-08

本记录保存该轮实施与验收结果。后续保留问题、A01–A03 和维护建议的最新整改及验证见 [工程验收问题整改](ENGINEERING-FOLLOWUP-2026-10-09.md)。

依据 `.codex-tmp/project-reaudit-20261008/ENGINEERING-REVIEW.md` 的 E01–E08 实施本地工程优化。报告中的证据先与源码核对，再逐步移动职责；保留既有未提交成果、模拟付款、用户明确确认、原购买幂等键和未知结果恢复规则。未提交、推送、部署，未启动或修改原有演示服务和数据目录。

## 已落实的八项方向

| 编号 | 最终变化 | 主要位置 |
| --- | --- | --- |
| E01 | 运行时需求、选择和报价统一为非空商品行；单品是一行。query/quantity、报价首商品等保留为只读的兼容展示字段，由边界归一化及一致性检查约束。协调器不再按 items 是否存在走两条报价流程 | `agent-runtime/basket-model.ts`、`merchant-adapter.ts`、`types.ts`、`coordinator.ts` |
| E02 | 公共纯规则集中未决购买、可重新报价、可选择和模型停止条件；确认和购买尝试有明确类型与转换入口。支付、履约、流程阶段和 attempt 仍是独立事实 | `shopping-contracts/session-rules.ts`、`agent-runtime/session-state.ts` |
| E03 | 独立 SessionView、ConfigView、AgentRunView 和商家列表/详情 DTO；服务端明列公开字段，嵌套校验也限制输出；浏览器消费同一套响应校验与类型 | `shopping-contracts/views.ts`、`browser.ts`、`agent-runtime/session-view.ts`、两 API handler |
| E04 | 原生 DOM 保留；表单事件更新 draft，API 更新 serverSession，请求更新 uiStatus，纯 deriveViewModel 统一计算数量、过期、提示和动作；渲染不再读取按钮状态来决定业务行为 | 购物前端 `view-model.js`、`app.js`、`dom.js`、`api-client.js`、`merchant.js` |
| E05 | 启动工厂负责 scope、存储识别、旧格式迁移和完整性验证；File 兼容后端在构造时确定，普通 CRUD 不热切换；SQLite 不再依赖 File | `session-store-factory.ts`、`session-scope.ts`、`session-record.ts`、`sqlite-storage.ts`、两 store |
| E06 | orderInconsistency 统一金额、逐行乘积、安全整数累加、条款 hash、唯一商品和时间规则；消费者读取、商家列表/详情和 owned read 使用同一入口 | `shopping-contracts/order.ts`、`agent-runtime/http-transport.ts`、商家 `orders.ts`/`merchant-read.ts` |
| E07 | 两安装入口复用同一份 Node 零依赖复制、hash、标记、替换和回滚核心；各自 auto 目标顺序及 marker 所有权策略仍由薄入口决定 | `shared/skill-installer-core.mjs`、CLI installer、独立 `ocp-skill.mjs` |
| E08 | 购物前端 typecheck 使用 checkJs/JSDoc/DOM 类型；lint 使用真实 ESLint。语法与资源检查独立为 check。另为本轮 29 个 TS、3 个安装器 JS 实现接入工程 lint | 购物前端 `tsconfig.json`/`eslint.config.js`、根 `eslint.engineering.config.js` |

E01 的旧格式兼容集中在请求、存储解码和旧商家端口边界；旧单品订单缺少 items 时，仅旧端口补展示行，原始总金额/数量与已确认报价仍接受绑定检查。HTTP、整篮与配送校验没有降为仅字段检查。归一化不改签名条款或 terms_hash，也不对价格进行四舍五入。

E02 的 SQL generated pending 列仍由 SQLite 表达；同一份 phase × attempt 样本验证它与共享规则一致。合法的“attempt 已确认、订单暂不可读、phase 为 unknown”继续锁定原购买，不开放新幂等键。

E03 将签名/金额逻辑与纯字段 schema 分开。浏览器入口只包含 schema、页面 DTO 和纯规则；Bun 的 browser target 构建保护此边界，未引入 SQLite、Node crypto、签名私钥或服务器实现。商家列表继续禁止收件人信息，详情仍有独立投影；分页、金额和币种校验保留。

## 存储恢复与兼容

默认运行时通过 `createSessionStore(directory, scope)` 得到准备完成的固定 SQLite 后端。完整的上一轮 v1 数据库经过表/索引、元数据、scope 和全部记录验证后，以事务升级到 v2；保留未决交易、原 attempt/key 和旧 JSON 快照，不重新导入过时 JSON。

v2 的 SQLite 元数据与外部 marker 绑定 storage_id、scope 和 revision。零字节或空数据库、缺表、缺必要元数据、不同数据库替换、数据库单侧回退、marker 丢失及 DB/marker 不一致均停止恢复，不创建空库继续交易。

限制必须保留：v1 升级前没有外部 revision 锚，无法证明历史未回退；数据库和 marker 一起回退到相同旧版本也无法识别。数据库提交成功但 marker 更新前崩溃时，程序停止操作，需要人工核对购买事实并恢复一致记录；不会自动选择某一侧或用旧 JSON 恢复购买。迁移前备份与迁移后备份均应保存整个数据目录。已创建的 File 实例不支持运行中热迁移，应在启动边界重新创建存储实例。

数据库连接继续按操作打开并关闭，保留 Windows 清理能力。商家 schema 仍为原有版本，本轮未接入真实网络支付。

## 构建与发行

- `shopping:ui:prepare` 生成浏览器使用的 `public/contracts.js`；购物启动、演示、预览、三套浏览器检查和全仓测试已接入准备步骤。购物 API 的 start/dev 也先准备资源。
- 购物前端声明共享契约依赖；Turbo 跟踪该依赖并缓存/恢复 `public/contracts.js` 与 dist。根共享安装核心和构建脚本列入缓存输入，避免核心变化后取到旧 CLI bundle。
- 独立安装器的 core 副本由 `sync-core.mjs` 生成，build/prepack 生成、typecheck/lint 检查一致性；CLI bundle 直接打包 canonical core。没有新增运行时安装依赖。
- 通用安装核心先在 staging 写完整内容和 marker，再替换目标；复制、marker 写入及提交前目录替换失败会恢复旧目录。新目录替换成功是提交边界，此后即使备份仅部分清理也保留完整新安装，并明确报告清理失败及残留备份路径；两种入口共用失败样本。没有运行用户真实 skill 安装或卸载。
- 共用浏览器 JS 是只读公开资源，加载它们不会因商家页而创建购物身份；商家 API 的角色边界保持独立。

## 验收

Windows 本机、Bun 1.3.13；浏览器模型响应使用本地协议 fixture，付款与履约均为模拟。

| 门禁 | 结果 |
| --- | --- |
| 完整源码测试 | **1186 pass / 0 fail**，67 文件，5674 断言 |
| 强制构建 | 14/14 tasks，通过 |
| 强制类型检查 | 24/24 tasks，通过；含 7 个前端契约负例及 3 个运行时关键状态/只读字段负例 |
| lint | 15/15 workspace tasks，以及新增工程 ESLint，通过；购物前端与官网各自真实 ESLint 通过 |
| shopping:check / site:check / skill:check | 全通过 |
| 冻结安装 | 377 installs / 388 packages，无改动 |
| 订单共享矩阵 | 同一份 26 项正常/异常订单，覆盖纯规则、owned read、商家列表/详情与消费者读取 |
| 购物前端纯规则/响应负例 | 17 项，57 断言，通过 |
| 安装器专项回归 | 26 项，118 断言；包含两种入口策略的备份部分清理失败 |
| 购物恢复浏览器 | 26 项通过 |
| 混合商品/配送浏览器 | 17 项通过 |
| 商家浏览器及独立测试服务重启 | 32 项通过 |
| 截图与代码空白 | 桌面配送报价、手机订单截图已查看；git diff --check 通过 |
| 依赖安全 | 0 条未登记公告；仍有上一轮 2 条构建依赖限期例外 |

存储覆盖空库、替换库、缺元数据、单侧旧快照、marker 丢失、v1 完整升级、单侧 crash 和已付款丢响应后不得第二次付款。DTO 覆盖顶层和嵌套私密字段隔离、签名形状拒绝未知字段、旧单品端口完整购买及重复确认。浏览器覆盖确认超时、跨标签页恢复、报价过期、整篮、配送、商家请求版本号和失败分页保留记录。

原有 GitHub Actions 已通过根 lint/test/build 命令取得这些门禁，但本轮未提交，因此远端 CI 尚未运行。未再次调用真实模型或真实支付。

依赖例外继承 [上一轮整改记录](AUDIT-REMEDIATION-2026-10-08.md)：braces high、postcss-selector-parser moderate，2026-11-07（北京时间）到期。仍由 `security:check` 拒绝新公告、版本/severity 变化、例外到期及扫描失败，本轮没有扩大例外。

日志、当前机器门禁汇总及开工前工作区补丁/状态记录位于 `.codex-tmp/engineering-optimization-20261008/`。购物截图位于 `.codex-tmp/integration/browser-resilience/`、`browser-basket/`；本轮商家证据位于 `.codex-tmp/merchant-preview-acceptance/run-2bHMzp/`。

## 按新需求再启动的方向

审查报告中“随需求启动”的四项保留为有明确触发条件的后续工作：商家数据库逐版本迁移、第二调用渠道的应用用例、第二种模型协议的传输接口，以及真实支付前的事务外异步结算。这些能力本轮未扩展；现有本地演示的服务、模型和支付范围保持原样。页面也没有迁移到新框架，没有全仓格式化。

常用复验命令为 `bun run shopping:check`、`bun run engineering:lint`、`bun run test:all` 和三套 `shopping:*:browser`。本机全局 Bun 仍为 1.4.2，执行根脚本前需把已验证的 1.3.13 目录放到当前会话 PATH；操作方式见上一轮整改记录。
