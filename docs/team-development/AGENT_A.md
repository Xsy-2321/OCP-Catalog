# Agent A：用户侧购物助手负责人

负责人：项目维护者。建议分支：`codex/shopping-agent`。

先阅读同目录 `README.md`。本文是未来开发任务说明；仅阅读本文不会自动授权提交、推送、真实支付或真实下单。

## 1. 你的目标

把用户的话变成可检查、可确认、可追踪的购买流程。你相当于“陪用户购物的助理”：理解需求、找候选、展示最终报价，得到用户许可后调用商家服务，最后报告商家返回的订单结果。

你负责用户是否同意购买，不负责制造价格、库存、支付结果或订单状态。

## 2. 唯一负责的目录

- `apps/shopping-agent-web/**`
- `apps/shopping-agent-api/**`
- `packages/agent-runtime/**`
- `tests/shopping-e2e/**`
- `docs/shopping-agent/**`
- 根 workspace/构建/CI 配置：集中维护，按 B 给出的需求集成。

这些是规划目录。开工前核对现有文件和 Git 状态。原则上不改 B 的商家目录、不直接改共同契约和 fixtures、不重构已有 OCP 协议包、原网站或 examples。

## 3. 你必须实现的模块

### User Interface：用户窗口

需求输入、候选比较、最终报价、明确确认/取消、购买过程、订单状态。必须区分搜索价格和商家最终总价，区分支付状态和制作/交付状态。

### Agent Runtime：执行助理

负责 LLM 接入、工具循环、会话上下文、选中候选、步骤状态及错误处理。限制工具执行次数和重复动作，能够暂停等待用户确认。无模型配置时明确显示 mock 模式，不能冒充真实模型。

LLM 可以提出计划，但模型输出的“已批准”“已付款”“订单成功”不能成为执行授权或业务事实。

### OCP Consumer：使用商品目录

复用 OcpClient 和现有 schema，按 discovery/manifest 获取真实端点，检查声明的 query pack 和字段，再 query/resolve。把用户预算转成受支持的筛选，并再次检查最终报价总额。

不得发明 entry_id、商家 ID、query_pack、能力和操作 URL；不得假设当前原始示例已经执行预算过滤。

第一版直连 B 的已知 Catalog；不以 Registry、MCP 或浏览器为前置任务。

### Purchase Coordinator：购买协调员

创建并持久化 PurchaseIntent、选中 entry、请求 Quote、展示全部费用、保存一次购买的 attempt ID/key、处理结账结果与订单查询。

需要一个 Merchant client abstraction，开发时接固定 fixtures，联调时接 B 的 HTTP 服务；两种实现使用同一契约，mock 模式显式标识。

### Authorization Issuer：用户许可签发

明确确认按钮和报价对应。A 的可信后端根据已确认报价签发 C0 约定的授权证明，绑定用户、商家、条款 hash、金额、货币、attempt ID 和有效期。

签发私钥和可用授权证明不进入 LLM。由服务端/Runtime 注入 Checkout 请求，不允许模型任意给已确认请求换参数。

第一版逐笔确认，不实现无需确认的自动付款。以后增加预授权规则要单独设计和验收。

## 4. 你消费的接口

以 B 维护的 `packages/shopping-contracts` 为准：

1. OCP discovery/manifest/query/resolve。
2. `POST /commerce/v1/quotes`。
3. `POST /commerce/v1/checkouts`。
4. `GET /commerce/v1/purchase-attempts/:id`。
5. `GET /commerce/v1/orders/:id`。

Checkout 入口来自选中对象的 Resolve/action binding；验证商家来源及允许路径。API keys、授权证明不发送给未经信任的 endpoint。

交易金额为整数分；现有 OCP price.amount 的换算在边界显式进行。预算是最终总额上限，包括费用。

## 5. 重试与故障责任

- 一次逻辑购买只生成一个稳定 attempt ID 和幂等 key，先保存再调用 Checkout。
- 重试沿用原 key 和原业务请求；不能因超时换 key。
- Checkout 超时先查 attempt；只在明确无交易且安全的条件下重试同请求。
- 返回 requote_required/quote_expired 后重新报价、重新确认，不沿用旧授权购买新条款。
- Runtime 重启后能够恢复待处理尝试，显示“不确定/查询中”，不自动宣布失败或重新购买。
- 重复点击确认不能制造多个购买尝试。

你负责正确重试；真正原子防重由 B 负责。不能用 UI 按钮禁用代替服务端幂等。

## 6. 实施顺序

1. C0 审查契约/样例并补必要 workspace 配置，双方从同一基线开工。
2. 用固定 transport/fixture 跑通 deterministic 用户流程及确认界面。
3. 接 B 的 Catalog 和交易接口，完成一次真实 HTTP 的模拟购买。
4. 增加超预算、失效授权、结果未知和重启恢复处理。
5. 配置真实 LLM 并验证它确实通过工具循环完成搜索/报价；购买仍为 mock payment。
6. 执行端到端验收，整理联合启动与排障说明。

## 7. 你的验收

- 用户能看到候选及最终含费总额，未确认不会调用 Checkout。
- 授权绑定正确，模型不能扩大预算、换商家或替换商品绕过检查。
- 调用 manifest 声明的能力，消费真实响应而不是永远返回 fixture。
- 超预算、缺货、过期和支付失败均用明确状态展示。
- 响应丢失后查回 B 的原订单，重试没有第二笔交易。
- 本地存储中可恢复购买尝试，但不持久化不必要的支付秘密。
- 实际运行并报告用户侧测试与共同 E2E；缺少模型配置时明确区分 mock-flow 与 LLM 验收。

## 8. 不属于你的任务

B 的商品/报价/订单数据库、库存扣减、模拟支付、商家幂等、交易事实和共同 schema 维护。发现问题给 B 提供请求、错误码和最小复现，不直接改商家实现。

Root lockfile 由你集中更新；B 提供包与依赖清单，避免双方同时安装并修改锁文件。

## 9. 给 Agent A 的启动提示

```text
你负责用户侧购物助手，请先读 docs/team-development/README.md 和 AGENT_A.md。
检查当前分支、Git 状态和本地代码，以共同契约提交为基线。
仅实施 A 所有的模块；共享契约由 B 维护，接口缺口先明确提出。
先完成 fixtures 驱动的流程，再接 B 的真实本地 HTTP 服务。
复用 OcpClient/schema，不修改原始协议和 examples，不接真实付款。
确认、授权签发、稳定幂等 key 和未知结果恢复必须落实到代码与测试。
不得用 mock 成功掩盖联调失败，也不得未经授权提交、推送或真实下单。
每个里程碑报告改动、实际测试、契约版本、对 B 的依赖和限制。
```
