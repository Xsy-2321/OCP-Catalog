# 整合实测报告：B 侧分支对 `origin/main` 的合并

> 此为 B 原始提交时的历史实测报告，以下版本、统计与结论保留原样。项目现由
> 用户独立维护，当前本地整合候选的代码与验收状态见
> [最新验收报告](../team-development/INTEGRATION-ACCEPTANCE.md)；尚未合入 main、未推送。

**日期**：2026-10-07
**被合并方**：`codex/coffee-merchant`（B，8 commit，已推送到 `origin`）
**合并目标**：`origin/main` @ `ce73a60`（A）
**相关**：[CONTRACT.md](./CONTRACT.md) · [HANDOFF-A.md](./HANDOFF-A.md) · [DECISION-REQUEST-A.md](./DECISION-REQUEST-A.md)

---

## 0. 一句话结论

**两侧各自都能跑，但两者之间没有任何一条真实的通路。**

全仓门禁是绿的，但这个"绿"证明的是**两边互不冲突**，不是**两边能合作**：合并后的仓库里，
A 侧代码对 B 的包与 fixtures **零引用**，而全仓仅有的两处跨包依赖都在 B 自己那边。

**解锁需要的可能只是一条 `git fetch` 和一行 workspace 配置。** 下面是可以复现的证据，
以及需要 A 处理的事。

---

## 1. 我做了什么

在 `origin/main` 的一个**独立 worktree** 上真实合并了本分支，跑完全部门禁，
并做了一组决定性实验。**没有改动 A 的任何文件，没有推送到 `main`，没有开 PR。**

```bash
git worktree add <scratch> origin/main --detach
# 在 scratch 里合并本分支，解决唯一的冲突（bun.lock）
bun test
./node_modules/.bin/turbo run typecheck
./node_modules/.bin/turbo run build
bun run site:check
```

---

## 2. 合并结果

| 检查 | 结果 |
|---|---|
| 合并冲突 | **仅 `bun.lock` 一个文件** |
| `bun test`（全仓） | **560 pass / 0 fail / 37 文件** |
| `turbo run typecheck` | 未登记 app 时 **22/22** → 登记后 **24/24** |
| `turbo run build` | **14/14** |
| `bun run site:check` | passed（36 routes） |
| `bun run shopping:check`（A 的门禁） | rc=0 |

测试数的算术是闭合的：**519（基线）+ 35（A 新增）+ 6（B 新增）= 560**。
两侧各自的测试都确实在被执行，没有一边被静默跳过。

唯一的冲突是 `bun.lock`。按 [HANDOFF-A.md](./HANDOFF-A.md) §1.2 的约定取 A 的那一份、
再跑一次 `bun install` 即可，实测 5.75 秒收敛。

---

## 3. 决定性实验：那一行 workspace

[HANDOFF-A.md](./HANDOFF-A.md) §1.1 说 `apps/coffee-merchant-api` 没被 `workspaces` 覆盖。
我把它加上、`bun install`、重跑：

```diff
- "workspaces": ["packages/*", "examples/typescript", "apps/ocp-site-web", ...]
+ "workspaces": ["packages/*", "examples/typescript", "apps/ocp-site-web", ..., "apps/coffee-merchant-api"]
```

| 观察 | 结果 |
|---|---|
| turbo 任务数 | **22 → 24** |
| 新增任务 | `@ocp-catalog/coffee-merchant-api#typecheck`、`@ocp-catalog/merchant-core#build` |
| 依赖链接 | `apps/coffee-merchant-api/node_modules/@ocp-catalog/merchant-core` 自动出现 |
| 配置校验 | `bun src/server.ts --check` → **exit 0** |
| 真实服务 | `LISTENING 127.0.0.1:8787`，discovery / health 均 **200** |

**全程没有手工 junction。** 在此之前 B 只能用手工 junction 验证这个 app。

> 附带发现：`@ocp-catalog/merchant-core#build` **只在登记之后才出现**。
> `typecheck` 的 `dependsOn: ["^build"]` 只构建"被依赖者的依赖"，
> 而 `coffee-merchant-api` 是 `merchant-core` 在这个仓库里的**唯一消费者**。
> 不登记 app，`packages/merchant-core/dist/` 在 typecheck 流水线里根本不会被构建出来。

---

## 4. 两侧之间的通路状况

实测：**A 侧全部代码对 B 的包与 fixtures 零引用。**

```
packages/agent-runtime/src/mock-transport.ts:13
  // A-owned development fixtures. They are NOT B's facts or the shared fixtures/shopping.
packages/agent-runtime/src/types.ts:1
  /** A-side internal port/read models, NOT a frozen shopping-contracts wire protocol.
```

全仓仅有的两处跨包依赖，都在 B 一侧：

```
packages/merchant-core/package.json    → @ocp-catalog/shopping-contracts
apps/coffee-merchant-api/package.json  → @ocp-catalog/merchant-core
```

**A 的 commerce 路径是 `MockMerchantTransport`**，从本地 JSON 文件读写；
唯一真实的 `fetch` 在只读的 OCP catalog 路径上（`ocp-consumer.ts:26`），
而它指向的是 A 自己的 `MOCK_ORIGIN`。

**当前没有任何一方在写连接两侧的那个 HTTP 客户端。**
按 `docs/team-development/AGENT_A.md`（line 87），它是 A 的 C1 任务；
B 只提供服务器，不提供客户端。这一项不在任何人的"已完成"里。

---

## 5. 需要 A 处理的事（按代价从低到高）

| # | 动作 | 代价 |
|---|---|---|
| 1 | `git fetch origin codex/coffee-merchant`，读本文件、[CONTRACT.md](./CONTRACT.md)、[HANDOFF-A.md](./HANDOFF-A.md)、[DECISION-REQUEST-A.md](./DECISION-REQUEST-A.md) | 一条命令 |
| 2 | 根 `workspaces` 加 `"apps/coffee-merchant-api"` + `bun install` | 一行（已实测通） |
| 3 | 回答 O1 / O2 / O3 | 三条，代价分别为主版本号 / 零 / 次版本号 |
| 4 | 放开 `MerchantPort`（见 §7）与硬编码的商家白名单（见 §7） | 小，但在写 HTTP 适配器**之前**必须先做 |
| 5 | 写 `HttpMerchantTransport` 实现 `MerchantPort` | **真正的工作量** |
| 6 | 双方联合 E2E：A 的适配器 → B 的真实服务 | 最后一步 |

### 关于 A 侧文档的一处时点问题

`docs/shopping-agent/C0-REVIEW.md` 的"当前状态"一节写着
"尚无 `packages/shopping-contracts`、`fixtures/shopping`、
`apps/coffee-merchant-api` 或 `packages/merchant-core`"。

这四个目录 B 在 **14:47–15:45** 之间提交、约 **15:46** 推送；
而那份文档随 `ce73a60` 提交于 **15:55:03**。
**B 的产物在 A 提交文档时已经在远端上了。**

A 的自述是诚实的（C0/C2/C4 都明写未完成），本文件不是要指出谁做错了什么 ——
只是说：**`C0-REVIEW.md` 里"需要 B 交付的共同基线"那张表，B 已经逐条答完并推上去了**
（对应关系见 §7），一次 fetch 就能核对。

---

## 6. B 侧自己欠的（我认领）

| # | 问题 | 说明 |
|---|---|---|
| B1 | **契约 §11 承诺的清空工具不存在** | [CONTRACT.md](./CONTRACT.md) 写着"清空数据工具只作用于显式测试存储，默认不自动清空"，但全仓没有任何实现。**一条有契约条款、无实现的承诺。** |
| B2 | **契约字段名与实现漂移** | 契约 D5 把订单的两个状态轴写作 `payment_status ⊥ fulfillment_status`；实际 schema 与 fixture 是 `payment: { status, updated_at }` + `fulfillment_status`。**`payment_status` 这个字段不存在**，值域是对的、只有名字错。 |
| B3 | **契约没有回答 A 要的 `audience`** | A 在 `C0-REVIEW.md` 要"issuer / audience / key ID"。签名载荷有 `issuer`、可信公钥按 `key_id` 索引，但没有 `audience`。实际承担该作用的是 `merchant_id`（已在载荷内），只是契约没把这层等同写明。 |
| B4 | Windows 外部信号关库**未验证** | 已如实写进 `apps/coffee-merchant-api/README.md` 的 "What is not done"：进程能被信号终止，但 JS handler 不跑 ⇒ 那条路径上数据库不会被关。不宣称 shutdown 可用。 |
| B5 | `bun.lock` 提交了自己那一份 | 合并时是唯一冲突点。按 [HANDOFF-A.md](./HANDOFF-A.md) §1.2 以 A 的为准，直接丢掉 B 这份即可。 |

**B1 与 B2 是我这边的缺陷，A 不需要处理。**

---

## 7. 契约对得上 A 的需求吗

对照 `C0-REVIEW.md` "需要 B 交付的共同基线"逐条核对，**绝大部分已经答完**：

| A 的要求 | 对应 |
|---|---|
| 契约版本与 export | `SHOPPING_CONTRACT_VERSION = 0.1.0`；[CONTRACT.md](./CONTRACT.md) §0 与 §14 |
| Catalog 身份 | discovery / manifest 有 `catalog_id`；`merchant_id` 在**报价响应**里（`quotes/valid.json`）—— 授权载荷需要的 `merchant_id` 与 `terms_hash` 都来自报价响应，顺序自洽 |
| 能力声明与实际执行 | manifest 的 `filterable_field_refs`，每个声明的 filter 单独断言"过滤前后结果不同" |
| Resolve | `resolve.json` 的 `action_bindings` 带 `entrypoint`（POST 入口）、`input_schema`（required + headers）、`live_checks`、`expires_at` |
| Quote | 归属 / 商品 / 数量 / 履约 / 币种 / 单价 / 全部费用 / 含费总额 / 到期 / 服务端 `terms_hash` |
| Caller identity | `x-dev-caller-id`（契约 D8），并明写"不是账户系统" |
| Authorization | 签名算法 Ed25519；载荷见 [CONTRACT.md](./CONTRACT.md) §3；**数量与履约经 `terms_hash` 间接绑定**（见 D3 的内容定义） |
| 幂等 | 契约 D4：key 走请求头、`UNIQUE(caller_id, merchant_id, idem_key)`、摘要只覆盖业务字段 |
| Checkout / Attempt | 契约 D5 / D6 / D7 |
| Order | `orderSchema` 含原 attempt、商品与费用快照、金额、两个状态轴、`created_at` / `updated_at` |
| 测试配置 | `apps/coffee-merchant-api/.env.example`：端口、显式 DB 路径、可信 key 路径、`MERCHANT_TEST_MODE` 与故障开关 |
| 金额 | 契约 D1：整数最小单位，边界显式换算 |

**一条需要 A 留意**：契约没有 `audience` 字段（见 B3）。

---

## 8. 附：A 侧代码审查摘要（独立只读审查，未改动 A 任何文件）

**结论：无 CRITICAL、无 HIGH。** 资金路径是 fail-closed 的 —— attempt 与幂等 key
在调用商家**之前**就落库、并发与重复确认收敛成一次 attempt、
没有任何路径把"结果未知"变成自动重试；授权是**真的 Ed25519 签名**；
无硬编码密钥、无自签名信任、无重复扣款路径、无 XSS。资金安全性质没有问题。

以下供 A 参考，其中前两条**与接 B 直接相关**：

**（a）类型层排除了真实适配器**

```
packages/agent-runtime/src/types.ts:78
  readonly mode: 'mock';
```

`MerchantPort` 把 `mode` 写成了字面量 `'mock'`，真实 HTTP 适配器无法实现这个接口。
**写适配器之前必须先放开它。**

**（b）校验层写死了一个商家白名单**

```
packages/agent-runtime/src/validation.ts:11
  value.merchant_id !== 'coffee-demo'
```

这不只是"夹具标识符不同"（见 §4 的 `MOCK_CANDIDATES`）——**源码里硬编码了一个白名单**。
接上 B 的真实 `merchant_id`（`merchant_coffee_demo`）会被**直接拒绝**，
不需要等到 `terms_hash` 不匹配那一步。

**（c）结账后会话被永久冻结**（`coordinator.ts:101`）

`confirm` 在**调商家之前**就建好并持久化 `session.attempt`。于是**任何**结账结果 ——
包括商家回的、明明没扣钱的 `requote_required` —— 都会让 `session.attempt` 留着，
此后 `search` / `select` / `confirm` 全拒、`cancel` 也抛错，用户只能另开会话。
这与 `AGENT_A.md` §5 要求的"返回 `requote_required` 后重新报价、重新确认"冲突；
而 `select` 时过期的路径是**没有 attempt**、直接进 `requote_required` ——
**两条 requote 路径行为不一致。**

**（d）`recover` 的裸 `catch` 吞掉所有错误类**（`coordinator.ts:161-167`）

真实的集成故障（商家返回过不了校验的 order）会被报成"仍无法确认"的 `unknown`，
永远浮不出来。注释只论证了 `not_found` 那一种，catch 的宽度超过注释声称的范围。

**（e）商家返回的 `result.error` 未校验**（`coordinator.ts:194`）

其它每一个商家字段都做了重绑定或校验，只有这一个例外。

**一条具体的落地陷阱**：`types.ts` 把 `idempotency_key` 建模成 `CheckoutInput` 的**字段**，
mock 也当对象内字段消费 ⇒ **写 HTTP 适配器时最自然的映射就是把它塞进 JSON body，
直接违反契约"key 走请求头"的规则。** 建议在适配器落地前先把它拆成传输层元数据。

**测不到的缺口（最要紧的一条）**：`Idempotency-Key` 走 header、`200`/`202` 的映射，
**现在没有任何测试能捕获，因为 commerce 的 HTTP 面根本不存在。**
这不是测试写得不好，是还没有东西可测 —— 它随 §5 第 5 项一起才能落地。

另有若干 LOW 项（`GuardedReadClient` 只覆盖了 3 个方法、`ocp-consumer.ts` 用
`Date.now()` 而非可注入时钟、`tool-loop.ts` 把工具指纹记在执行之前、
`docs/shopping-agent/README.md` 里嵌了一个本地 Windows 路径），**不影响接 B**，此处不展开。

---

## 9. 本报告的边界（我没验证什么）

诚实起见，以下几点是这份报告的**已知盲区**：

1. **合并状态从未提交、从未推送。** 所有合并结果都在一个临时 worktree 里产生，
   `origin/main` 与本分支都没有被这一轮实验改动过。
2. **A 的测试数我无法复现。** `docs/shopping-agent/STATUS.md` 写"最终 `bun test`：
   118 项通过…15 个测试文件"；实测 A 的路径限定运行（`shopping:test`）是 **35 项 / 3 文件**，
   全仓是 **560 项 / 37 文件**。**118 / 15 这两个数字我都无法从这个提交复现**，不猜测原因。
   另注：A 记的环境是 Bun 1.4.2，而仓库 `packageManager` 是 `bun@1.3.13`，
   跨版本的测试发现行为不保证一致（本仓 `bun test` 扫全树）。
3. **我没有审 B 自己的代码。** §8 是对 A 侧代码的独立只读审查；
   B 侧的正确性依据是 B 自己的测试与 [CONTRACT.md](./CONTRACT.md) §13，
   不在这一轮的审查范围内。
4. **联合 E2E 从未跑过**，因为把它跑起来所需的那个 HTTP 客户端还不存在（§4）。
5. **A 是否 `fetch` 过本分支，我无法从仓库判断。** 本文件 §5 只说
   "产物在 A 提交文档时已经在远端上"，不做动机推断。

---

## 10. 建议的下一步

第 1、2 项几乎零成本，且能把"两侧各自能跑"变成"两侧至少看得见对方"：

1. A `git fetch origin codex/coffee-merchant`
2. A 加那一行 workspace + `bun install`
3. 我修 B1（清空工具）与 B2（`payment_status` 字段名）
4. A 放开 `mode: 'mock'` 与硬编码商家白名单，然后写 `HttpMerchantTransport`
5. 双方跑一次真实 HTTP 的联合模拟购买

第 5 项之前，第 4 项的前半段必须先做完 —— 否则接口在类型上就装不下适配器。
