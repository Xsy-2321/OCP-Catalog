# C0 契约：购物交易接口（冻结版）

- **契约版本**：`SHOPPING_CONTRACT_VERSION = 0.1.0`
- **冻结日期**：2026-10-07
- **维护者**：Agent B（商家侧）
- **审查方**：Agent A（用户侧）
- **落地代码**：`packages/shopping-contracts/`、`fixtures/shopping/`

> ⚠️ **本文件描述的一切都是 demo 应用扩展，不是 OCP Catalog 标准的一部分。**
> 它不新增任何协议能力，也不修改 `packages/ocp-schema`、`packages/ocp-client`、
> `packages/ocp-cli` 与 `examples/`。原始协议行为保持不变。

本文对应 [AGENT_B.md](../team-development/AGENT_B.md) §3 要求"与 A 一起冻结 C0"。
下面每条决策都给出理由；A 若不同意某条，请在此**推翻它并说明**，而不是各自实现
一个不同版本——两边长出两套 schema 正是这个包存在的理由。

---

## 0. 契约的可执行部分

文字描述会腐烂，代码不会。以下内容是**唯一真源**，双方都从这里导入，不要重新实现：

| 内容 | 位置 |
|---|---|
| 两个必须逐字节一致的函数 | [`src/terms.ts`](../../packages/shopping-contracts/src/terms.ts)、[`src/authorization.ts`](../../packages/shopping-contracts/src/authorization.ts) |
| 报价与 `terms_hash` | [`src/quote.ts`](../../packages/shopping-contracts/src/quote.ts) |
| 金额换算 | [`src/money.ts`](../../packages/shopping-contracts/src/money.ts) |
| 错误码与 HTTP 映射 | [`src/errors.ts`](../../packages/shopping-contracts/src/errors.ts) |
| 四个端点的请求/响应 | [`src/http.ts`](../../packages/shopping-contracts/src/http.ts) |
| 固定测试数据 | [`fixtures/shopping/`](../../fixtures/shopping/README.md) |

**两个函数绝对不能各写一份**：

- `computeTermsHash(terms)` — 规范化序列化 + SHA-256
- `authorizationSigningBytes(payload)` — 规范化序列化 + UTF-8 编码

第二份实现迟早会与第一份不一致，而症状看起来像"签名莫名验不过"，
排查成本远高于共用一行 import。

---

## 1. 交易流程

```
A 从 Catalog 搜到商品
        │
        ├─► POST /ocp/query        拿候选（OCP 既有形状）
        ├─► POST /ocp/resolve      拿到商品详情 + checkout ActionBinding
        │
        ├─► POST /commerce/v1/quotes           B 返回最终报价（含全部费用）+ terms_hash
        │                                      报价由 B 存库；报价不锁库存
        │
   A 取得用户批准，用私钥对授权载荷签名
        │
        ├─► POST /commerce/v1/checkouts        带 Idempotency-Key 头 + 授权证明
        │      ├─ 200 confirmed   ─► 付款完成，订单已存在
        │      └─ 202 processing  ─► 结果未知，请轮询 attempt
        │
        ├─► GET /commerce/v1/purchase-attempts/:id
        └─► GET /commerce/v1/orders/:id
```

**B 只维护事实**：价格、库存、能否成交、付款状态、订单记录。
**B 不替 A 理解需求，也不替用户决定是否购买。**

---

## 2. D1 — 金额：整数分，边界显式换算

新增的交易金额一律为整数最小单位，字段名以 `_minor` 结尾（人民币分，30 元 = `3000`）。

| 场景 | 表示 |
|---|---|
| OCP `attributes.price` | **保持既有契约**：`currency` 三位大写 + `amount` 十进制数字 |
| 报价、订单、授权、预算 | 一律 `*_minor` 整数 |

依据 [AGENT_B.md](../team-development/AGENT_B.md) §3："OCP price.amount 保持已有契约，
新增交易金额使用整数分。"

换算只在 Catalog 边界发生一次：

```ts
yuanToMinor(25)      // -> 2500
yuanToMinor(9.9)     // -> 990
yuanToMinor(0.001)   // -> 抛错，不静默取整
```

`yuanToMinor` 对超过 2 位小数的输入**直接报错而非四舍五入**。静默取整会让
"报给用户的价"与"收用户的钱"悄悄分叉，而这种分叉在 demo 里不会被发现、
在真实系统里是财务事故。

Catalog 同时携带 `price`（十进制）与 `price_minor`（整数）两个表示，
`coffeePriceInconsistency()` 在装载数据时校验二者一致——不一致是**摄取 bug**，
不是舍入问题。

## 3. D2 — 授权：Ed25519 签名授权证明

**A 持签发私钥，B 只配置可信公钥。** 公钥按 `key_id` 索引、来自受控配置，
**绝不采信请求自带的公钥**（[README](../team-development/README.md) §5）。

被签名的载荷（规范化 JSON）绑定：

```
v / issuer / user_id / merchant_id / quote_id / terms_hash / currency
max_total_minor / purchase_attempt_id / issued_at / expires_at / jti
```

`purchase_attempt_id` 在**载荷内部**，因此一份授权只对**一次**购买尝试有效。
换一个 attempt 复用旧授权，签名必然验不过。

四道检查互相独立，缺一不可：

| 检查 | 失败时 |
|---|---|
| 签名验得过 | `authorization_invalid` |
| 未过期（`expires_at` 为闭区间） | `authorization_invalid` |
| `merchant_id` 是本商家 | `authorization_invalid` |
| `terms_hash` 与本次报价一致 | `requote_required` / `authorization_invalid` |

### 为什么不是 HMAC

共享密钥方案下 B 拿到密钥即可**凭空伪造授权**——"验签方不能自己造许可"这一性质
完全丢失。非对称方案下 B 只持有公钥，即使 B 的配置被读走也无法签发新授权。

`approved: true`、模型生成的文本、任意 `approval_id` **一律不构成授权**。

Ed25519 由 `node:crypto` 原生支持，零依赖。签名编码为 `base64url`。

## 4. D3 — terms_hash：服务端生成并保存

```
内容 = { v, merchant_id, quote_id, currency, total_minor,
         items[] 按 entry_id 排序, fees[] 按 code 排序, fulfillment }
算法 = SHA-256(canonicalJson(内容))
```

- **由 B 在报价时计算并存库**，Checkout 时重算比对。
- 不一致 → `requote_required`。
- **绝不采信客户端自报的总额或自报的 hash。** 客户端报的总额是待检查的输入，不是事实。

`items` / `fees` 排序**不是**为了可读性，而是因为数组顺序参与哈希：不排序的话，
同一份报价换个顺序就是另一个 hash，A 与 B 会互相认为对方改了条款。

规范化 JSON 规则（**不是 RFC 8785**）：

- 对象键按字典序；无空白；数组保持顺序
- `undefined` 字段丢弃
- UTF-8 编码；**签名/哈希结构内禁止非整数数字**

## 5. D4 — 幂等：数据库原子唯一约束

```sql
UNIQUE(caller_id, merchant_id, idem_key)
```

- `BEGIN IMMEDIATE` 事务内插入
- 唯一约束冲突 → 回读既有行、比对请求摘要：
  - 摘要相同 → 返回原结果
  - 摘要不同 → `idempotency_conflict`
- 持久化为 `bun:sqlite`，**进程重启后原 key 仍可查**
- **请求摘要只覆盖业务字段**（`quote_id`、`terms_hash`、`purchase_attempt_id`、
  quantity、fulfillment），**不含传输层细节**——否则重试时换个 header 顺序
  就被误判成冲突

`Idempotency-Key` 走**请求头**，不走请求体，这样重试时重新序列化的 body
仍配得上同一个 key。

> **禁止用内存 Map 充当最终幂等保障**（[AGENT_B.md](../team-development/AGENT_B.md) §7）。
> 内存 Map 重启即失忆，而"重启后不能重复下单"正是要保证的事情。

**mock 支付也必须验幂等**：只断言"订单只有一笔"不够，必须断言**支付表也只有一行**
（[AGENT_B.md](../team-development/AGENT_B.md) §3）。

## 6. D5 — 状态机：attempt 与 order 分离

```
PurchaseAttempt:  processing ──► confirmed
                             └─► failed

Order:            payment_status      ⊥  fulfillment_status
                  pending | paid          pending  | ready
                  failed  | unknown       completed| cancelled
```

- `paid` **只能**由服务端验证过的模拟支付结果产生，
  **绝不能从 Checkout 请求本身推导**。请求里写着 `approved: true` 不代表收到钱。
- 两个状态**互相独立**：`paid + pending` = 已付款未出餐，是正常状态。
  合并成一个 `status` 字段会让"已付款"被读成"已出餐"。
- 两套词表只共享一个词 `pending`（付款的 pending = 未付款，履约的 pending = 未制作），
  这是刻意的，且有测试把守。
- `unknown` ≠ `pending`：`unknown` 是"不知道结果"，`pending` 是"确定还没付"。
  这个区别决定了重试是否安全。超时留下的就是 `unknown`。

## 7. D6 — 超时语义：结果未知 ≠ 失败

Checkout 超过自身内部时限时，返回：

```http
HTTP/1.1 202 Accepted
{ "status": "processing", "purchase_attempt": { "status": "processing", ... } }
```

**这是成功响应，不是错误响应。** 依据 [README](../team-development/README.md) §5：
"Checkout 超时后的状态是'结果未知'，不是'失败'。"

这是整个契约里最容易写错、且写错后果最严重的一处：把超时当失败返回，
A 会认为购买没成功并重试，而钱可能已经付过。正确做法是让 A 拿到
`purchase_attempt_id` 去轮询 `GET /commerce/v1/purchase-attempts/:id`。

## 8. D7 — 错误信封与 HTTP 映射

沿用仓库既有约定（见 `examples/typescript/src/server.ts`）：

```json
{ "error": { "code": "...", "message": "...", "details": { } } }
```

| 错误码 | HTTP | 含义 |
|---|---|---|
| `invalid_request` | 400 | 结构/字段非法 |
| `unauthorized` | 401 | 缺少或无法验证调用者身份 |
| `forbidden` | 401 | 身份已知但无权（**仅用于资源存在性已合法可知的场景**） |
| `quote_expired` | 409 | 报价有效期已过 |
| `requote_required` | 409 | 条款已变（价格/库存/履约），必须重新报价 |
| `budget_exceeded` | 409 | 含费总额超出用户预算 |
| `out_of_stock` | 409 | 库存不足 |
| `authorization_invalid` | 401 | 授权证明不成立 |
| `idempotency_conflict` | 409 | 同 key 不同业务请求 |
| `payment_failed` | 402 | 模拟支付被拒绝 |
| `not_found` | 404 | 资源不存在**或不属于该调用者** |

两条硬约束：

1. **B 必须 2xx 返回 schema 正确的 JSON，所有错误返回非 2xx。**
   依据：`OcpClient` 按 **HTTP 状态码**判定成败，且成功响应体是在 try/catch
   **之外**用 zod 解析的——所以一个 200 配一个不合 schema 的 body，
   会把"业务错误"变成"客户端崩溃"。
2. **需要 A 重新报价的拒绝，绝不塞进 200 的 body 里。**
   `quote_expired` / `requote_required` / `budget_exceeded` / `out_of_stock`
   都是非 2xx，因为 A 先看状态码再决定怎么处理。

## 9. D8 — 调用者身份：本地开发会话（v1）

用 `x-dev-caller-id` 请求头承载调用者身份。

> ⚠️ **这只是一个可被随意伪造的 demo 占位，不是账户系统，也不得被描述成账户系统。**

- quote / attempt / order 均带 `caller_id`，查询按 caller 过滤
- **跨调用者访问返回 404，而不是 403。** 403 会泄漏"这个资源存在"这一事实，
  于是攻击者可以靠猜 ID 探测他人订单。404 不泄漏任何信息。
- `forbidden`（401）留给"资源存在性已合法可知"的场景，v1 基本用不到。

→ 这条规则影响 A 的错误处理分支，**见 [HANDOFF-A.md](./HANDOFF-A.md) 的开放问题 O1**。

## 10. D9 — 故障注入：仅测试模式

`MERCHANT_TEST_MODE=1` 时按 env 启用下列故障；非测试模式一律不可达。
固定名称见 [`fixtures/shopping/faults.json`](../../fixtures/shopping/faults.json)：

| 名称 | 效果 | 验收它证明了什么 |
|---|---|---|
| `payment_timeout_then_succeed` | 超时返回 `202`，随后轮询变为已付款 | 超时不得被报成失败 |
| `payment_declined` | 模拟支付失败，attempt 变 `failed`，无订单 | 失败时不得出现 `paid`/`confirmed` |
| `price_raised_after_quote` | 报价后调价 | 条款变化 → `requote_required`，而不是静默按新价扣款 |
| `stock_exhausted_after_quote` | 报价后最后一件被买走 | Checkout 时 `out_of_stock`，且不产生订单 |
| `response_dropped_after_settlement` | 已扣款、订单已建，但响应未送达 | 同 key 重试拿回原订单，不产生第二笔支付 |

## 11. D10 — 配置、脱敏与清理

- **配置外置**：端口、数据库路径、允许来源（CORS）、可信授权公钥，
  全部走配置/env 显式声明，**不读取生产配置**。
- **脱敏**：查询接口与事件记录**不得泄漏**授权证明、签名材料、支付秘密
  （[AGENT_B.md](../team-development/AGENT_B.md) §5）。因此：
  - `PurchaseAttempt` 与 `Order` 的 schema 里**没有** `authorization` 字段
  - `Order` 里**没有**支付引用（它在查询端点上，是凭证形状的东西）
  - 事件采用追加记录并脱敏
- **清空数据工具只作用于显式测试存储**，默认不自动清空。
- 事件第一版只能称"**应用过程记录**"——未做防篡改验证前**不得宣传为不可篡改账本**。

## 12. D11 — B 不做

真实支付 / 真实商业 API；根 workspace 与 lockfile 集成；协议包与
`examples/` 的改动；用户 UI；LLM；用户侧授权签发；未经确认的提交与推送。

---

## 13. 与 AGENT_B.md §5 验收清单的对应

| 验收项 | 由什么保证 |
|---|---|
| Catalog 响应符合现有 OCP schema，声明的 filters 实际生效 | fixture 逐个过 `catalogManifestSchema`/`catalogQueryResultSchema`/`resolvableReferenceSchema`；`COFFEE_FILTER_MAP` 把 field_ref 与线上 filter 键绑成**同一个对象**，manifest 只准声明 map 的键 |
| 拿铁完整报价 30 元内；超预算/缺货真实拒绝 | `quotes/valid.json` 与 `quotes/valid-delivery.json`（恰好 3000，含运费）断言通过；`quotes/over-budget.json` 断言**结构合法**因而"拒绝"只能由预算规则产生 |
| 未授权/越权/授权过期/条款不匹配/quote 过期无法 Checkout | `authorization/` 六个 fixture，**每个只由一条规则拒绝**（见下） |
| 同 key 顺序与并发只产生一笔支付和一笔订单 | Phase 2：`Promise.all` 并发同 key，断言支付表与订单表**各恰好 1 行** |
| 同 key 改请求冲突；换 attempt 重放旧授权拒绝 | `authorization/replayed-other-attempt.json` 签名验不过（载荷被改） |
| mock payment 失败不出现 paid/confirmed | `orders/failed.json`（`failed` + `cancelled`）、`attempts/failed.json` |
| 成功但响应丢失后能查回原订单 | `attempts/processing.json` 不声称订单也不声称错误；`faults.json` 的 `response_dropped_after_settlement` |
| 重启后查询与幂等一致 | Phase 2：关库再开，重放同 key |
| 不能靠猜 ID 查询他人资源 | D8：跨 caller → 404 |
| 查询接口与事件不泄漏授权证明/签名/支付秘密 | schema 层已无这些字段；fixture 断言 `Order`/`PurchaseAttempt` **不带** `authorization`、`payment_reference` |

### authorization fixtures 的判别力

每个负面样例**只有一列**是"不通过"：

| 文件 | 签名 | 在期内 | 商家 | terms_hash |
|---|---|---|---|---|
| `valid.json` | ✅ | ✅ | ✅ | ✅ |
| `expired.json` | ✅ | ❌ | ✅ | ✅ |
| `wrong-merchant.json` | ✅ | ✅ | ❌ | ✅ |
| `wrong-terms-hash.json` | ✅ | ✅ | ✅ | ❌ |
| `tampered-signature.json` | ❌ | ✅ | ✅ | ✅ |
| `replayed-other-attempt.json` | ❌ | ✅ | ✅ | ✅ |

一个"因为别的原因被拒"的负面样例什么都证明不了——它无法区分"这条规则生效了"
与"别的检查先拦下了"。

---

## 14. 修改契约的规则

1. **加字段** → 提升次版本号（`0.1.0` → `0.2.0`），说明影响，重建 fixtures。
2. **改语义或删字段** → 提升主版本号，**先与 A 确认**。
3. **不得静默破坏 A**（[AGENT_B.md](../team-development/AGENT_B.md) §3）。
4. fixtures 一律由 `bun fixtures/shopping/generate.ts` 重新生成，
   **不要手改 JSON**；`fixtures.test.ts` 会验出漂移。
