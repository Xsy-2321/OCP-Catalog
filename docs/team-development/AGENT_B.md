# Agent B：商家侧目录与交易负责人

负责人：商家模块维护者。建议分支：`codex/coffee-merchant`。

先阅读同目录 `README.md`。本文是未来开发任务说明；仅阅读本文不会自动授权提交、推送、真实支付或真实下单。

## 1. 你的目标

提供一个可靠的本地 Coffee Merchant：能搜索商品、给最终报价、验证购买授权、完成模拟交易、返回可信订单状态。

你相当于“咖啡店收银台”：商品价格和库存、能否成交、付款状态、订单事实都由你维护。你不替用户理解需求或决定是否购买。

## 2. 唯一负责的目录

- `apps/coffee-merchant-api/**`
- `packages/merchant-core/**`
- `packages/shopping-contracts/**`（共同确认后由你落地）
- `fixtures/shopping/**`（共同确认后由你落地）
- `docs/coffee-merchant/**`

这些是规划目录。开工前核对现有文件和 Git 状态。不改 A 的 UI、Runtime、用户授权签发和 E2E 目录。根 workspace/锁文件/CI 变更由 A 集成：提供明确 patch 或依赖清单，不在分支里各自更新共享配置。

不直接改原始 Catalog 示例和协议包；新的商家服务参考它们另建，避免破坏原教学/协议行为。

## 3. 你必须实现的模块

### Shopping Contracts：双方接头规则

优先交付新增交易 schema、request/response、状态枚举、错误码、授权验证约定、固定 fixtures。明确这些是 demo 扩展，不是现有 OCP 标准。

与 A 一起冻结 C0。每次字段/语义变化先说明影响和版本；不能静默破坏 A，也不能让两边维护两套 schema。

### Coffee Catalog：商品目录

提供 discovery、manifest、health、query、resolve；使用现有 OCP schema 验证。至少有 CNY 拿铁、超预算和缺货样例。

真正执行声明的 keyword/query mode、currency、max_amount、in_stock_only 等筛选；未实现的能力不写入 manifest。OCP price.amount 保持已有契约，新增交易金额使用整数分。

商品对象来自你维护的商业事实。Resolve 返回可用商品详情、freshness/expiry、checkout ActionBinding 及输入要求；它不直接下单。

### Quote Service：最终报价

提供 `POST /commerce/v1/quotes`，核对选中 entry、数量、履约选项，返回完整费用与最终总价、有效期和 terms_hash。

报价不锁库存。条款不可由 A 自报；服务端保存报价。Checkout 时再次检查，条款或库存改变时拒绝或要求重新报价。

### Checkout Service：模拟结账

提供 `POST /commerce/v1/checkouts`，顺序验证调用者身份、资源归属、报价/条款、授权、预算、库存、幂等，再执行本地模拟支付与订单流程。

验证 A 的可信授权证明，绑定用户/商家/quote/hash/currency/amount/attempt/expiry。公钥来自受控配置，不能相信请求自带的 key；不能接受模型字符串或 approved:true 当许可。

### Idempotency Store：重复购买防护

使用可持久化存储和数据库原子唯一约束，对调用者/商家/key 保存请求摘要、attempt、状态和订单结果。

- 同 key 同业务请求返回原结果。
- 同 key 不同业务请求拒绝为 idempotency_conflict。
- 并发重复请求只产生同一订单。
- 同一个授权不允许换 attempt 重放。
- 进程重启后原 key 和订单仍可查。

请求摘要应定义业务字段与授权绑定，避免仅因传输重试细节导致误判；具体算法和字段在 C0 固定。

### Mock Payment：本地模拟付款

只实现成功、失败、处理中及结果查询等本地模拟行为；不会发送真实支付请求。支付引用与状态持久化，模拟“已成功但响应丢失”。

支付执行使用稳定 key，不能因为 HTTP 重试再次扣款。mock 也要验证支付幂等，不能仅断言订单数量。

### Order / Event：订单与办事记录

提供 attempt 与 order 查询，区分 `payment` 和 `fulfillment_status`。成功订单只能由服务端验证后的支付/交易状态产生。

保存商品和报价快照、关键交易事件、更新时间。事件采用追加记录并脱敏；第一版只能称应用过程记录，未做防篡改验证时不得宣传不可篡改账本。

## 4. 并行开发方式

不等 A 的页面和 LLM。先用普通 HTTP 测试客户端和签名授权 fixtures 验证全部接口。

1. 先共同冻结 C0 schema/fixtures，由 A 同步必要 workspace 配置。
2. 提供可启动的 Coffee Catalog 和固定数据。
3. 实现 Quote，再实现授权验证与 Checkout。
4. 加持久化幂等、模拟支付、订单/attempt 查询。
5. 提供超时/失败/涨价/缺货等可控故障模拟，仅在本地测试模式启用。
6. 给 A 启动命令、端点、环境变量、契约版本、测试数据和联调说明。

清空数据工具只能作用于显式测试存储，默认不自动清空。端口、数据库路径、允许来源和授权可信 key 必须通过配置明确，不读取生产配置。

## 5. 你的验收

- Catalog 响应符合现有 OCP schema，声明的 filters 实际生效。
- 一杯拿铁的完整报价可以在 30 元内；超预算/缺货样例真实拒绝。
- 未授权、越权、授权过期、条款不匹配、quote 过期无法 Checkout。
- 同 key 的顺序与并发请求只产生一笔模拟支付和一笔订单。
- 同 key 改请求冲突，换 attempt 重放旧授权拒绝。
- mock payment 失败不出现 paid/confirmed 成功状态。
- 已成功但响应丢失后，A 能通过 attempt 查询拿回原订单。
- 重启后查询和幂等结果保持一致。
- 用户不能靠猜 ID 查询或修改他人的 quote/attempt/order。
- 查询接口和事件不泄漏授权证明、签名秘密、支付秘密。
- 商家单元/集成测试实际运行；共同 E2E 由 A 主持，你修复商家侧失败。

## 6. 不属于你的任务

LLM、Agent planner/tool loop、用户 UI、用户是否批准、授权签发私钥、用户侧重试流程、根配置和锁文件、Registry/MCP/browser 扩展。

你可以评审 A 的调用契约，但不能替用户自动批准购买，也不能自行把 A 的预算改宽以让 demo 成功。

## 7. 给 Agent B 的启动提示

```text
你负责商家侧 Coffee Catalog 与本地 demo 交易服务。
先读 docs/team-development/README.md 和 AGENT_B.md，检查分支与 Git 状态。
第一件事是提出并与 A 冻结 shopping-contracts 和 fixtures；你是唯一维护者。
只实施 B 所有的目录，根配置需求交给 A，不修改原始协议/教学示例。
先用 HTTP 测试客户端独立验证，再向 A 提供稳定端点联调。
真实执行报价、授权校验、原子幂等、mock payment、订单查询和归属检查。
禁止 approved:true 充当授权，禁止内存 Map 充当最终持久化幂等保障。
不得接真实支付或商业 API，不得擅自提交/推送/真实下单。
每个里程碑报告改动、实际测试、契约版本、启动方式、对 A 的依赖和限制。
```
