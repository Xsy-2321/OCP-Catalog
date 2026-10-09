# 工程验收问题整改 · 2026-10-09

依据 `.codex-tmp/engineering-acceptance-20261008/REPORT.md`，核对并修复两项保留发现、A01–A03 及两项维护建议。工作始于 10 月 8 日，最终验收跨至北京时间 10 月 9 日。保留原有未提交成果；未提交、推送、部署，未重启原演示服务或修改原数据、密钥、登录及 agent 配置。交易验收均为隔离本地模拟。

## 本轮修复

| 项目 | 结果与保护 |
| --- | --- |
| 保留 P1：CLI update Windows 参数边界 | 独立 `process-execution.ts` 解析原生程序或已知 npm/ocp 包声明的 JS 入口，始终 `shell:false`；不执行 `.cmd/.bat` 内容。安装完成后再解析更新后的 ocp；两阶段失败仍停止并报错。完整本地伪包链路验证空格、引号、命令符号、环境变量样式及副命令陷阱均保持为参数，不执行额外命令 |
| CLI 前导连字符目标 | 子进程使用单个 `--target=<literal>` argv，CLI 支持按第一个等号拆分 `--key=value`。`--folder`、含后续等号/空格的目录在父、实际子 CLI dry-run 中保持一致，不默默变为 auto；dry-run 不创建安装目录 |
| 保留 P2：参考节点查询能力语义 | TypeScript/Python/Go 的最小 keyword 节点明确拒绝不支持的 pack、filter/semantic/hybrid mode 和非空 filters，统一结构化 HTTP 400；`false`、`0` 也视为请求筛选。空 filters、keyword、分页保持兼容，三语言共用 31 项语义 fixture |
| A01：canonical skill 缓存输入 | Turbo 全局输入增加 `skills/ocp-catalog/**` 和 `scripts/sync-skill-copies.ts`。隔离副本动态验证输入变化后两发行任务 hash 改变、普通 build 均 MISS，并更新分发内容；未变化时 HIT，删除发行目录也能恢复正确内容 |
| A02：源码测试缺生成资源 | `shopping:test` 显式执行 `shopping:ui:prepare`。只复制当前源码、安装冻结依赖的隔离副本不含 contracts.js，不预先 build；直接运行此根入口通过并生成资源 |
| A03：自然到期提示不刷新 | 时间事件从同一份 view 同时刷新倒计时、确认按钮和规划提示；候选控件及表单保留。真实五秒自然到期浏览器验证旧确认建议移除，保留重新报价/编辑建议，0 购买请求、0 页面错误 |
| 恢复草稿的数据流 | `draftFromSession` 纯函数先生成独立草稿，再展示表单；不经 DOM 写入再读回。单品旧格式、标准单项、混合篮子、配送/自取、原模式和 agent 消息均有回归保护；草稿编辑不修改服务端快照 |
| 内部购物篮维护约束 | Intent/Quote 不再继承 Legacy 输入模型；内部 items 属性、数组与商品行增加 readonly。修改走完整归一化值替换，六个新增编译负例防止原地改行、增删行及仅替换明细。非空仍由既有边界运行时验证，不引入复杂深度泛型 |

CLI 进程执行与安装文件系统仍是两个独立模块；本轮没有把命令启动放入共享安装核心，也没有运行真实 npm 全局安装或用户 skill 安装。测试的伪 npm/ocp 只写临时 argv 记录和 dry-run 计划。已验证标准 npm、local node_modules/.bin 与默认 Bun global 布局；未知或自定义 batch 布局没有可验证入口时会明确失败。多套 CLI 共存仍按 PATH 优先级选择，不承诺选择某个包管理器刚更新的那一套。

参考节点的 manifest 仍只声明 `ocp.query.keyword.v1` / `keyword`，没有新增筛选能力。协议 schema 合法不等于节点支持。省略 mode 的空查询保留历史列举全部商品行为；SDK 当前推断 filter 并拒绝这两项兼容样本，fixture 单独记录此差异。SDK 调用者可显式指定 `query_mode: "keyword"`；不能将此差异表述为全部请求的 SDK/节点判定一致。

## 隔离源码与普通缓存验证

新增 `bun run engineering:inputs`，复制 Git 当前源码至短路径临时副本并安装冻结依赖，避免依赖原工作区生成物。它只在副本改规范源文件/同步脚本及删除发行目录，保留原工作区内容。每次生成独立 JSON 和日志；缓存只使用副本本地目录。

| 顺序 | 两发行任务缓存结果 | 验证 |
| --- | --- | --- |
| 首次普通 build | MISS / MISS | 两个分发目录与规范源 hash 相同 |
| 不改源码，删除发行目录再 build | HIT / HIT | 缓存恢复完整内容，hash 不变 |
| 仅修改副本规范 SKILL.md | MISS / MISS | 两个任务 hash 改变，两个发行 payload 均更新 |
| 仅修改副本同步脚本 | MISS / MISS | 两个任务 hash 再改变，新增脚本探针实际执行 |
| 不再改源码，删除发行目录再 build | HIT / HIT | 恢复最新 payload，不返回旧内容 |

本次隔离源码 `shopping:test` **395 pass / 0 fail**，17 文件、2362 断言；开始时 `contracts.js` 不存在，结束时已生成。动态证据位于 `.codex-tmp/engineering-inputs/run-a0adf076-62d/report.json`。规范源实际 hash 仍为 `521d840dbd33…`，测试修改只在副本。

首次隔离安装在长临时路径出现依赖文件 ENOENT；缩短路径后冻结安装与全部动态门禁通过。一次分离证据目录后的初始化遗漏已修正；未把失败或未完成尝试当成通过证据。新增命令已接入现有 Windows/Ubuntu CI，远端尚未运行。

## 最终验收

Windows 本机，Bun 1.3.13。模型响应使用本地协议 fixture；付款、库存及履约验证为本地模拟。

| 门禁 | 实际结果 |
| --- | --- |
| 全源码测试 | **1243 pass / 0 fail**，70 文件、6073 断言，33.04 秒；含最终 19 项 CLI 新回归及 31 项查询语义样本 |
| 构建 | 14/14，通过；最终普通构建 13 缓存命中、CLI 新代码重建，bundle 含新 target/等号解析 |
| 强制类型检查 | 24/24，通过；原前端七个负例，运行时原三个及新增六个负例有效 |
| 强制 lint | 15/15 workspace tasks，通过；工程 ESLint 覆盖 33 个指定 TS 实现和 3 个安装器 JS，购物前端/官网各自真实 ESLint 通过 |
| shopping:check / site:check / skill:check | 全部通过 |
| Python 参考节点 | 全套 11 tests 通过，包含原 87 项及新增 31 项 HTTP 样本 |
| Go 参考节点 | `go test ./...` 通过，包含同一批原有及新增样本 |
| 购物恢复浏览器 | 26 项通过 |
| 混合商品/配送浏览器 | 17 项通过 |
| 商家浏览器及服务重启 | 32 项通过，结束时 1 order / 1 payment / 1 attempt；本次测试服务已停止 |
| 自然到期浏览器 | 8 项通过，0 购买请求，0 页面错误；已查看到期后的真实页面截图 |
| 最终 CLI bundle dry-run / git diff --check | 复杂目标完整保留在单个 argv，未运行安装；代码空白检查通过 |
| 依赖安全 | 2 条已登记构建依赖例外，0 未登记公告；例外未扩大 |

源码检查、CLI 日志、最终全仓日志和浏览器证据位于 `.codex-tmp/engineering-followup-20261008/`。Python/Go 的已见工具回执摘要为 `reference-language-verification.md`，不是补造的原始进程日志。商家本轮证据位于 `.codex-tmp/merchant-preview-acceptance/run-Gh92AP/`。

新增 `shopping:expiry:browser` 先准备资源，再运行自然到期验收；该门禁及隔离输入门禁已加入 CI，JSON/截图纳入 artifacts。其他仍以 tsc 为 lint 的包没有被表述为全部接入 ESLint。未再次请求真实模型、真实支付或远端 CI。

## 保留的恢复与演进边界

原 SQLite 截断后重建空库问题维持已关闭结论，回归本次仍通过。以下灾难恢复限制继续存在：v1 升级前没有外部 revision 锚；DB 与 marker 同时回退至相同旧快照无法识别；DB 提交后 marker 更新前崩溃会停止操作，必须人工核对，不能自动选取某一侧。

遇到恢复拒绝时，维护者应先保留现场并停止该实例继续交易；备份整个数据目录，包括 DB、相关 SQLite sidecar、marker、scope 与旧快照。核对原 purchase_attempt/idempotency key 对应的商家交易事实，先解决未决结果；再选择同一次完整备份恢复或制定经核对的恢复方案。重新启动时仍通过存储工厂的 scope/storage_id/revision 校验；不要单独覆盖 DB、手改 marker 冒充一致或用旧 JSON 恢复购买。当前没有修改任何原有实例的数据来演练此过程。

仍有上一轮两条构建依赖例外：braces high、postcss-selector-parser moderate，2026-11-07 北京时间到期；版本、severity、到期、新公告及扫描失败仍受门禁约束。它们尚未消除，不能称为零风险，后续依赖升级仍需独立复验构建工具链。

报告的四个后续架构方向保持原触发条件：商家 DB 下一次结构升级时拆逐版本迁移/seed/backfill；第二调用渠道或商家出现时抽应用用例；第二模型协议前抽小型传输接口；真实支付前重新设计短事务登记、事务外请求、短事务结算与恢复。这些能力本轮没有提前扩展，也不因当前工程验收通过而自动具备。
