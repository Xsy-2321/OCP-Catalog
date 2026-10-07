# 交接给 Agent A

**分支**：`codex/coffee-merchant`（B 的本地分支，**尚未推送**）
**契约版本**：`SHOPPING_CONTRACT_VERSION = 0.1.0`
**冻结契约**：[CONTRACT.md](./CONTRACT.md)
**日期**：2026-10-07

本文件只列**需要 A 做的事**和**B 做不到的事**。B 侧已完成的模块见
[AGENT_B.md](../team-development/AGENT_B.md) §5 验收清单在
[CONTRACT.md](./CONTRACT.md) §13 的逐条对照。

---

## 1. 必须由 A 做的改动（B 不能碰根配置）

### 1.1 把 `apps/coffee-merchant-api` 纳入 workspace

这是一个**真实的阻塞项**。根 `package.json` 目前是：

```json
"workspaces": ["packages/*", "examples/typescript", "apps/ocp-site-web"]
```

`packages/*` 自动覆盖 `shopping-contracts` 与未来的 `merchant-core`，
但**没有 `apps/*` 通配**，所以 `apps/coffee-merchant-api` 不会被解析、
也不会被 `turbo` 跑。需要 A 加一行：

```json
"workspaces": ["packages/*", "examples/typescript", "apps/ocp-site-web", "apps/coffee-merchant-api"]
```

**时点**：Phase 2 写 `apps/coffee-merchant-api` 之前即可。Phase 1
（`packages/shopping-contracts`、`fixtures/shopping`、`docs/coffee-merchant`）
**不依赖**这一行，现在就能跑。

### 1.2 锁文件

依据 [AGENT_A.md](../team-development/AGENT_A.md)（line 106）：root lockfile 由 A 集中更新。

`packages/shopping-contracts` 需要的依赖：

| 依赖 | 版本 | 说明 |
|---|---|---|
| `@ocp-catalog/ocp-schema` | `workspace:*` | 复用既有 OCP schema |
| `zod` | `^4.1.12` | 与仓库其余包一致 |

B 本地已 `bun install` 使测试可跑，产生的 `bun.lock` 增量**只在 B 本地，
未提交也未推送**（依据 [AGENT_B.md](../team-development/AGENT_B.md) §2）。
增量恰好 10 行，只是登记新 workspace 包，无版本解析变化：

```diff
@@ -107,6 +107,14 @@
       "name": "@ocp-catalog/shared",
       "version": "0.2.1",
     },
+    "packages/shopping-contracts": {
+      "name": "@ocp-catalog/shopping-contracts",
+      "version": "0.1.0",
+      "dependencies": {
+        "@ocp-catalog/ocp-schema": "workspace:*",
+        "zod": "^4.1.12",
+      },
+    },
     "packages/webmcp-adapter": {
@@ -215,6 +223,8 @@
 
     "@ocp-catalog/shared": ["@ocp-catalog/shared@workspace:packages/shared"],
 
+    "@ocp-catalog/shopping-contracts": ["@ocp-catalog/shopping-contracts@workspace:packages/shopping-contracts"],
+
     "@ocp-catalog/site-web": ["@ocp-catalog/site-web@workspace:apps/ocp-site-web"],
```

A 在自己的 clone 上跑一次 `bun install` 即可得到等价结果。

`fixtures/` 不是 workspace，不需要任何条目。

### 1.3 B 没有做的事

- ❌ 未推送任何分支
- ❌ 未改根 `package.json`、`bun.lock`、`turbo.json`、CI
- ❌ 未改 `packages/ocp-*`、`examples/`
- ❌ 未改 A 的 UI / Runtime / 授权签发 / E2E 目录

---

## 2. A 现在就能用的东西

**不需要等 B 的服务跑起来。** 依据 [AGENT_A.md](../team-development/AGENT_A.md) §6.2
（先跑 fixture 驱动流程），全部固定数据已在：

```
fixtures/shopping/
```

关键文件：

| 文件 | A 拿它做什么 |
|---|---|
| `manifest.json` | 决定 query 怎么发、哪些 filter 可用 |
| `query-result.json` | 拿铁的关键词查询结果 |
| `resolve.json` | **从这里取 checkout 的 `ActionBinding`**（URL + 输入要求） |
| `quotes/valid.json` | 一个有 `terms_hash` 的合法报价 |
| `authorization/valid.json` | 一份验得过的授权证明，做请求体的模板 |
| `checkouts/request-valid.json` | 完整的 checkout 请求（含 headers） |
| `orders/confirmed.json` | 成功订单的形状 |

`generate.ts` 无随机、无 `new Date()`，重跑逐字节一致——A 可以放心把它当基准。

**公钥**：`fixtures/shopping/keys/agent_a_test.public.pem`。
这是**从公开固定种子派生的测试密钥**，不保护任何东西；私钥由
`keys/derive-test-keys.ts` 本地生成且不入库。真实部署的密钥另起。

---

## 3. 端点契约（A 侧需要知道的）

完整语义见 [CONTRACT.md](./CONTRACT.md)，这里只列 A 会碰到的：

| 方法 | 路径 | 成功 | 要点 |
|---|---|---|---|
| GET | `/.well-known/ocp-catalog` | 200 | discovery |
| GET | `/ocp/manifest` | 200 | 只声明**实际实现**的 filter |
| GET | `/ocp/health` | 200 | |
| POST | `/ocp/query` | 200 | `filters` 是**严格封闭**集合 |
| POST | `/ocp/resolve` | 200 | 从这里取 checkout 入口 |
| POST | `/commerce/v1/quotes` | 200 | 返回含全部费用的最终价 + `terms_hash` |
| POST | `/commerce/v1/checkouts` | **200 或 202** | 见下 |
| GET | `/commerce/v1/purchase-attempts/:id` | 200 | |
| GET | `/commerce/v1/orders/:id` | 200 | |

### 三个最容易踩的点

**① Checkout 的 `202` 不是错误。**

```
200 → status: "confirmed"   付款完成，订单已存在
202 → status: "processing"  结果未知，请轮询 attempt
```

超时**永远不是失败**。若 A 把 202 当失败重试，可能重复扣款。
依据 [README](../team-development/README.md) §5。

**② `Idempotency-Key` 走请求头，不走请求体。**
重试时即使 body 重新序列化了，header 里的 key 仍要对得上。

**③ `/ocp/query` 的 `filters` 是 `.strict()` 的封闭集合。**
可用键只有：`category`、`brand`、`currency`、`availability_status`、
`provider_id`、`sku`、`min_amount`、`max_amount`、`in_stock_only`、`has_image`。
发一个 schema 里没有的键是**硬报错**，不是被忽略。
B 实际实现的是其中一个子集，以 `manifest.json` 的 `filterable_field_refs`
为准——它与 B 的实现是**同一个对象**（见 CONTRACT §0）。

另外 `catalogQueryResultSchema.page.offset` 是 `z.literal(0)`，
**只支持游标分页**，不支持 offset 翻页。

---

## 4. 开放问题（需要 A 拍板）

### O1 — 跨调用者访问返回 404 还是 403？

B 的当前决议（CONTRACT §9 D8）：**返回 404**。

理由：403 会泄漏"该资源存在"这一事实，于是可以靠枚举 ID 探测他人订单；
404 不泄漏任何信息。

**但这条会改变 A 的错误处理分支**：A 需要把 404 也当作"这个 attempt/order
不是我的或不存在"，而不是只处理 403。如果 A 侧更希望区分"不存在"与"不是你的"，
请说明——B 可以改，但需要在 C0 里改，不能等实现完了再发现两边假设不同。

### O2 — 报价有效期多长？

fixture 用的是 **15 分钟**（`10:00:00Z` → `10:15:00Z`），超时样例为
`09:05:00Z` → `09:20:00Z`。

这个值直接影响 A 的交互设计：有效期太短，用户还在犹豫就过期了；
太长，"报价后调价"的场景就永远不触发。**A 觉得多少合适？**

### O3 — 预算单位与来源

demo 预算取 **30 元（`3000` 分）**，是 B 侧的假设，且
[AGENT_B.md](../team-development/AGENT_B.md) §6 明确：
**B 不能自行把预算改宽以让 demo 成功**。预算是 A 侧从用户输入得到的，
请确认 A 传给 B 的形式——目前契约里它只作为授权的
`max_total_minor` 字段出现，**不单独出现在请求里**（B 从授权里读）。
如果 A 希望单独传一个预算字段，那是改契约，需要提版本。

---

## 5. B 承认的局限

- **事件不是账本。** 第一版只是追加的"应用过程记录"，
  **未做防篡改验证，不得宣传为不可篡改账本**。
- **`x-dev-caller-id` 不是账户系统。** 可被随意伪造，仅是 demo 占位。
- **付款是纯本地模拟。** 不发任何真实支付请求，不接任何商业 API。
- **`packages/shopping-contracts` 不是 OCP 标准。** 是 demo 应用扩展，
  不得在任何文档或对外材料里描述成协议能力。
- **Phase 2 未开始。** 当前只有契约、fixtures 与文档；
  任何"服务已实现"的说法都是错的。
