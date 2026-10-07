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

**时点**：`apps/coffee-merchant-api` **代码已经写好**（`src/server.ts`，B 侧
Phase 2 的一部分），但因为这一行缺失，它既不被 `bun install` 解析、也不被
`turbo` 看见，`import '@ocp-catalog/merchant-core'` 无法解析。所以这一行现在是
**让那个 app 能启动**的唯一前提——B 是手工建了一个 `node_modules` junction
才跑通的（`node_modules` 不入库，所以没有改任何受版本控制的文件）。

Phase 1（`packages/shopping-contracts`、`fixtures/shopping`、`docs/coffee-merchant`）
**不依赖**这一行。

### 1.2 锁文件

依据 [AGENT_A.md](../team-development/AGENT_A.md)（line 106）：root lockfile 由 A 集中更新。

B 本地已 `bun install` 使测试可跑，产生的 `bun.lock` 增量**只提交到 B 的
本地分支 `codex/coffee-merchant`，未推送**。Phase 2 增加了第二个包，增量随之
变为 4 处 hunk，全部只是**登记新 workspace 包**：没有新的外部依赖，也没有
任何版本解析变化。

> ⚠ **A 加上 §1.1 那一行再跑 `bun install` 后，增量会再多一处**（登记
> `apps/coffee-merchant-api` 及其 `workspace:*` 依赖），仍然**没有外部依赖**。
> B 这份锁文件里**不含**那一处，因为 B 不能改根 `package.json`，所以也就没有
> 用它跑过 `bun install`。

> 锁文件仍归 A 所有（[AGENT_A.md](../team-development/AGENT_A.md) line 106）。
> B 提交的是**自己这一份**，只为让该分支自洽、可复现。A 侧跑一次
> `bun install` 即可得到等价结果；若与 A 本地已有的锁文件冲突，**以 A 的为准**，
> 直接丢掉 B 这份即可。

| 包 | 依赖 | 版本 | 说明 |
|---|---|---|---|
| `packages/shopping-contracts` | `@ocp-catalog/ocp-schema` | `workspace:*` | 复用既有 OCP schema |
| | `zod` | `^4.1.12` | 与仓库其余包一致 |
| `packages/merchant-core` | `@ocp-catalog/ocp-schema` | `workspace:*` | 复用既有 OCP schema |
| | `@ocp-catalog/shopping-contracts` | `workspace:*` | 上表那个包 |
| | `zod` | `^4.1.12` | 与仓库其余包一致 |
| `apps/coffee-merchant-api` | `@ocp-catalog/merchant-core` | `workspace:*` | 上表那个包 |

`apps/coffee-merchant-api` **没有 devDependencies**，是刻意的：它和
`merchant-core` 一样直接吃根目录已有的 `typescript` 与 `@types/bun`
（`tsconfig.base.json` 的 `"types": ["bun"]` 从子目录向上找到根
`node_modules/@types`）。所以登记这个 app **不会给锁文件带来任何新条目**，
只是多一条 workspace 登记。

> ⚠ 这个 app 的 `typecheck` **依赖 `merchant-core` 先构建**：
> `merchant-core` 的导出走 `"types": "./dist/index.d.ts"`，`dist/` 不存在时
> 直接 `tsc -p apps/coffee-merchant-api` 会报 `TS2307`（找不到
> `@ocp-catalog/merchant-core`）**外加一条行 105 的 `TS18046`**。后者是前者的
> 派生结果（模块解析失败后 `MerchantConfigError` 不再是一个可窄化的类型），
> **不是两个 bug**。`turbo run typecheck` 的 `dependsOn: ["^build"]` 已经保证
> 顺序，所以走 turbo 不会碰到；**只有绕过 turbo 手跑 `tsc` 时才会**——那就先
> `bun run --cwd packages/merchant-core build`。

`merchant-core` 的存储与验签用的是 `bun:sqlite` 与 `node:crypto`，两者都是
Bun/Node 内置，**不产生 lockfile 条目**，所以除 `zod` 外全仓没有引入任何新依赖。

```diff
@@ -54,6 +54,15 @@
         "typescript": "^5.9.3",
       },
     },
+    "packages/merchant-core": {
+      "name": "@ocp-catalog/merchant-core",
+      "version": "0.1.0",
+      "dependencies": {
+        "@ocp-catalog/ocp-schema": "workspace:*",
+        "@ocp-catalog/shopping-contracts": "workspace:*",
+        "zod": "^4.1.12",
+      },
+    },
     "packages/ocp-activity-schema": {
@@ -107,6 +116,14 @@
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
@@ -203,6 +220,8 @@
 
     "@ocp-catalog/example-catalog-typescript": ["@ocp-catalog/example-catalog-typescript@workspace:examples/typescript"],
 
+    "@ocp-catalog/merchant-core": ["@ocp-catalog/merchant-core@workspace:packages/merchant-core"],
+
     "@ocp-catalog/ocp-activity-schema": ["@ocp-catalog/ocp-activity-schema@workspace:packages/ocp-activity-schema"],
 
@@ -215,6 +234,8 @@
 
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
- **`apps/coffee-merchant-api` 写好了，但不在 workspace 里。** 网络入口是
  `apps/coffee-merchant-api/src/server.ts`：读配置 → 开库 → `Bun.serve` →
  收尾关库，路由逻辑一行都没有（都在 `merchant-core` 的 `handleRequest` 里）。
  它能跑通，但**必须先把 §1.1 那一行加上**，否则 `@ocp-catalog/merchant-core`
  无法解析。B 是用手工 junction 验证的，没有改任何受版本控制的文件。
  **监听地址默认 `127.0.0.1`**：`x-dev-caller-id` 是调用方自己写的头，绑到
  `0.0.0.0` 等于让同网段任何人都能冒充任意调用者。
- **端口、数据库路径、CORS 来源、可信公钥全部走配置，无默认值硬编码。**
  见 CONTRACT §10（D10）与 `packages/merchant-core/src/config.ts`。

---

## 6. Phase 2 状态（B 侧）

**已完成**：`packages/merchant-core` 全部模块 —— catalog 与真实 filters、
报价与 `terms_hash`、Ed25519 验签、`bun:sqlite` 幂等、模拟支付、attempt /
order 状态机、事件留痕、故障注入、配置加载。

**验证**（B 本地实测）：

| 门禁 | 结果 |
|---|---|
| `bun test`（全仓） | **519 pass / 0 fail**，33 个文件 |
| `turbo run typecheck` | **18/18 successful** |
| `bun run site:check` | passed（36 routes） |
| 行尾 | `packages/merchant-core/src`、`packages/shopping-contracts/src` 全 LF |

其中 Phase 2 新增的三组测试各自针对一类**单测覆盖不到的失败**：

- `checkout.test.ts` —— 结账状态机、并发同 key、重启后重放、五种故障。
  并发那一条用了**第二个数据库连接**抢同一个 key；`Promise.all` 的形状也
  保留了，但 `bun:sqlite` 是同步的，它只能证明重放路径、证不了竞态，代码里
  写明了这一点。
- `service.test.ts` —— 路由级。**每个 manifest 声明的 filter 单独断言过滤
  前后结果不同**（声明的 filter 不生效就会返回全集，测不过）；`202` 不是
  错误；响应丢失必须是**裸 500 而非错误信封**；CORS 无通配符。
- `smoke.test.ts` —— 一次完整购买：discovery → manifest → query → resolve →
  quote → 验签 → checkout → 轮询 attempt → 取订单，**每一步的输入都是上一步
  的输出**（不手搓 id 或 URL）。最后用**同一个 `Idempotency-Key` 重放一次**，
  断言订单表与支付表各恰好 1 行（只数订单不够——重放时重新扣款、只回放订单体
  的表现是一样的）。

**入口**：`apps/coffee-merchant-api`（`package.json` / `tsconfig.json` /
`.env.example` / `.gitignore` / `README.md` / `src/server.ts`）。它不含任何路由，
只读配置、开库、`Bun.serve`、收尾关库。**没有测试**是刻意的：路由都在
`merchant-core` 里由那 28 条路由级用例覆盖，这正是 `handleRequest` 被写成纯函数
的原因。它在 workspace 之外，所以不在这张表里。

**B 手工验证（junction 链接依赖后）**：`tsc --noEmit` 干净；真实启动并 HTTP
实测 discovery / health / `拿铁` 查询（1 条结果）/ 报价（`total_minor` 2500）/
resolve / CORS 预检 204 / 缺 caller 401 / 未知路由 404；配置失败（缺
`MERCHANT_DB_PATH`、库路径的目录不存在、端口被占、未知 fault 名）**全部 exit 1
并给出原因，而不是抛栈**。

**未做**：任何推送。
