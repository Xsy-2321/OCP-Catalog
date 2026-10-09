# 参赛问题修复与验收

日期：2026-10-07。基于 `05e2509` 的本地工作区修改。对应应用赛道审查中的 F1—F6、附录缺陷，以及模型和演示入口建议。

## 修复对应表

| 审查问题 | 已完成的修复 | 验证入口 |
|---|---|---|
| F1：未决购买恢复入口丢失 | 当前身份可从后端发现全部未决会话；跨会话取消与新规划受限；前端跨标签同步且保留恢复入口 | coordinator / HTTP / 浏览器恢复回归 |
| F2：A 重启后无法报价 | 重新查询受信目录并按原需求验证候选；移除、库存或预算不再合格时要求重新搜索 | OCP consumer 重启回归 |
| F3：恢复表单与旧报价不一致 | 刷新同步预算、杯数和搜索词；修改表单成为草稿，禁用旧报价确认 | 浏览器刷新与草稿回归 |
| F4：健康状态和错误提示误导 | 实际读取商家健康响应；搜索/报价错误提供相应重试指引；本次操作错误优先显示 | HTTP health / precheckout / 浏览器离线回归 |
| F5：宣告商品页却 404 | 实现只读商品页，显示当前价格、库存和费用，转义文本并设置安全响应头 | merchant 商品页回归 |
| F6：网站 lint 失败 | 移除未使用变量；拆分主题 hook 与组件导出 | 根 lint |
| unknown/preorder 被当现货 | 现货筛选、报价及原子库存预留统一仅接受 in_stock / low_stock；普通查询仍可展示不可购买商品 | merchant 库存语义回归 |
| 商家 URL 无启动校验 | 在配置阶段拒绝非 HTTP(S) origin、路径、查询串或凭据 | config 回归 |
| 筛选能力跨 capability 混用 | 同一个 capability 必须同时支持模式与全部筛选，不把未声明字段当作已接受 | OCP client 回归 |
| 三语言教学示例缺分页 | TypeScript、Python、Go 返回可遍历游标及准确 has_more，拒绝无效游标 | 三语言分页回归 |
| 没有外部模型接入 | 后端 DeepSeek 兼容 Chat Completions、需求提取、真实 search / quote 工具；不允许模型购买、修改硬约束或编造候选 | model 单元与真实 A/B + 本地模型协议 HTTP 回归 |
| 演示启动复杂 | 一条命令运行 A/B，生成并保留本地签名密钥，配置预检、数据目录锁及独立新排练目录 | demo 启动与关闭回归 |
| 参赛入口与门禁缺失 | 首页入口、模型配置、展示脚本、原创范围说明、完整测试与 CI | 文档检查、根检查、GitHub workflow |

复审额外补上：未知购买在模型请求期间出现时立即停止规划；整轮 Agent 总时限贯通模型、目录分页和报价，超时取消外部请求并清理本地报价，不中断已开始购买；停机等待后台取消清理落盘后才关闭商家、释放目录锁；手动更换商品清除旧推荐理由；浏览器验收每次使用独立数据目录。

## 本轮验证

| 检查 | 最终结果 |
|---|---|
| `bun run build --force` | 14/14 tasks 成功 |
| `bun run typecheck --force` | 24/24 tasks 成功 |
| `bun run lint` | 15/15 tasks 成功 |
| `bun run test:all` | 728 pass / 0 fail，45 文件，3352 断言 |
| `bun run shopping:check` | runtime、API、UI、集成测试及演示启动器类型通过 |
| `bun run site:check` | 36 docs routes、22 artifact entries、7 updates 通过 |
| `bun run skill:check` | 发布副本一致 |
| Python `conformance_test.py` | 9 tests，OK |
| Go `go test ./...` | 通过 |
| `bun run shopping:demo:check` | 空密钥配置预检通过，未开放端口或调用模型 |
| `bun run shopping:browser` | 真实 A/B HTTP、Chrome、本地模型协议 fixture：24 项通过，无页面异常 |
| 常规 HTTP 浏览器验收 | 默认数据目录连续运行两次，各 13 项通过，使用不同数据库 |
| 新排练目录重启专项 | 同端口及输出目录重启后恢复同一 confirmed 订单，密钥及原目录资料保留 |
| `git diff --check` | 通过 |

Bun 门禁使用项目固定版本 1.3.13。完整测试通过隔离脚本执行正式 `test:all` 入口，仅移除桌面环境的 CODEX_HOME / CLAUDE_CONFIG_DIR 覆盖，避免 CLI 测试读取宿主配置；不修改用户设置。Python 使用 3.13，本机 Go 使用 1.26.3；CI 按示例 go.mod 安装 1.22，远程 CI 尚未运行。

日志与浏览器证据位于本机 `.codex-tmp/competition-fixes`，包括 `build.log`、`typecheck.log`、`lint.log`、`tests.log`、`browser-final/report.json` 及截图。子集测试与浏览器检查不和728项完整套件累加。构建中两个仅类型检查包的“无输出文件”提示不是失败。

## 密钥与验收边界

根 [.env.example](../../.env.example) 中 `DEEPSEEK_API_KEY` 留空。`SHOPPING_LLM_MODEL=deepseek-flash` 对应 DeepSeek V4.1 Flash，依据 [官方说明](https://api-docs.deepseek.com/news/news260910/)。复制为根 `.env`，填写后重启 `bun run shopping:demo`。

本轮模型自动验收使用本地 HTTP 协议 fixture，真实商家报价、预算、确认和幂等路径实际执行。未使用用户外部密钥，未验证真实 DeepSeek 账号、额度或生产调用。空密钥时页面准确显示未配置，手动搜索仍可运行。

目前仍为单商户、本机演示和模拟付款；生产登录、真实支付、跨店发现与公网部署没有实现。本次没有推送或发布；新增 CI 只完成本地等价检查，没有声称已在 GitHub 跑绿。

参赛展示见 [COMPETITION.md](COMPETITION.md)。路演录像、真实模型调用证据，以及提前开发作品是否允许，需要使用自己的密钥排练并按活动组织者答复准备。
