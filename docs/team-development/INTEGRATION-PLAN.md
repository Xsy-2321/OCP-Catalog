# A/B 下一阶段整合报告

日期：2026-10-07。用途：供浅唱浮柠与协作者安排修改、审查接口和执行联合验收。本文件提出接下来要做的工作，不表示这些修改已经完成，也不自动执行提交、推送或合并。

## 1. 结论

**采纳 B 的工程接入与 HTTP 适配方向，但先把交易事实和接口语义补齐。** 加 workspace 能解决 B API 的依赖解析；完整整合还需要 A 的 HTTP transport、共同授权签发、状态映射，以及真正经过 A 确认路径的联合测试。

B 报告补充了 A 侧的重报价、恢复诊断和错误校验问题；前次审计发现的库存、授权用户绑定、查询筛选和金额精度问题也必须进入本轮整改。两侧单独测试和合并构建通过，不能关闭这些事项。

建议推进方式：先共同确认 C0 及工程基线，随后 **A 实现适配与状态机整改，B 修交易事实与契约问题，两边并行**；用一次成功购买检验通路，再完成异常、并发和重启验收。达到最后一项之前，不把状态标为“整合完成”。

## 2. 本报告依据及验证范围

| 材料 | 固定版本或位置 | 使用方式 |
|---|---|---|
| A / main | `ce73a6021bf4a00e7e0f2da4cb2471085ff4a583` | 当前 A 源码、C0-REVIEW、STATUS 与职责说明 |
| 前次 B 审计代码 | `da2ce91c4a099ec3fb6dae97f31bea3416dece33` | 已复现的四项问题与隔离构建/测试 |
| B 最新整合报告 | `161d4d1c247d4e59b7b989c69428d6e4f109732b` | [INTEGRATION-REPORT.md](https://github.com/Xsy-2321/OCP-Catalog/blob/161d4d1c247d4e59b7b989c69428d6e4f109732b/docs/coffee-merchant/INTEGRATION-REPORT.md) |
| 前次完整审计 | 本机 `.codex-tmp/integration-audit/AUDIT.md` | 真实 HTTP、SQLite 及源码证据 |
| 本轮补充证据 | 本机 `.codex-tmp/integration-audit/b-report-161d4d1/` | B 新提交差异、A 探针与 A 原快照复测日志 |

本轮查询远端确认：main 仍为上述 A 提交，B 已推进至 `161d4d1`。GitHub 比较结果显示，B 的新提交**只增加整合报告，没有修改代码**，所以前次四项问题仍适用。

已由当前审阅实际执行或复核：

| 检查 | 结果 | 含义 |
|---|---|---|
| 原始 A+B 隔离副本全仓测试 | 560 pass / 0 fail，37 文件 | 双方已有用例同时通过；不代表联合购买已实现 |
| 原始副本根构建 | 14/14 任务通过 | 库层及已有应用可构建 |
| 根类型检查 | 未登记 coffee app：22/22；登记后：24/24 | 数量含依赖构建，是任务数，不是包数 |
| 原始副本 coffee app 配置检查 | 找不到 `@ocp-catalog/merchant-core` | 工程接入确实缺 workspace 登记 |
| 仅在副本登记 workspace 后 | 配置检查 exit 0，app 类型检查通过 | 验证那一行登记有效；正式仓库未改 |
| A OcpConsumer → B 本地 HTTP | discovery、manifest、query、Resolve 可读取 | 只读目录能力可与 B 合作；正式 commerce 流程仍是 mock |
| A 原快照单独完整测试，本轮补测 | 118 pass / 0 fail，15 文件 | 复现 A 原 STATUS 的统计 |
| A 路径限定测试 | 35 pass / 0 fail，3 文件 | A 新增购物用例，与全仓统计范围不同 |
| A 重报价探针，本轮新增 | `requote_required` 后同会话重新选择返回 `invalid_state` | B 指出的状态机缺口成立 |
| A 畸形错误探针，本轮新增 | Port 返回数字 code/对象 message，被原样写入公共会话 | 内部类型没有运行时防护；真实 HTTP 接入必须校验 |

A 原快照首次使用源码别名执行全仓测试时，CLI 子进程没有继承别名和依赖，产生 10 项环境失败；在独立副本安装依赖后复测全部通过。采用后一次结果，不将前一次误报为 A 代码缺陷。

B 报告的“实际 Git 合并只有 bun.lock 冲突”“site:check 通过”“正式 bootstrap LISTENING、health/discovery 200”属于 B 提供的实测记录，本轮没有独立重复这些检查。当前审阅的合并测试用 A 快照与 B 所有目录拼合，并在副本重新生成锁文件，不能冒充已经验证了两条 Git 分支原锁文件的合并结果。

上述环境使用 Windows Bun 1.4.2，仓库固定版本仍为 Bun 1.3.13。最终集成门禁应统一 Bun 版本，并验证集成后的锁文件可用于全新安装。

## 3. B 报告中值得采纳的部分

| B 的建议或发现 | 处理意见 | 具体落地 |
|---|---|---|
| 登记 `apps/coffee-merchant-api`，统一处理 workspace/锁文件 | 采纳，已独立验证入口失败与登记后的成功 | 由 A 修改根配置，B 提供依赖清单；让实际 app 进入门禁 |
| 由 A 编写 `HttpMerchantTransport`，再跑联合 E2E | 采纳，是核心整合工作 | 复用 `shopping-contracts`，覆盖请求头、响应码、schema、归属和恢复 |
| `MerchantPort.mode` 只有 mock；校验写死 coffee-demo | 采纳为接入事项 | 同步修改 Port、Session、runtime factory、配置与展示；用配置中的受信商户，保留白名单限制 |
| Checkout 后明确拒绝也永久保留 attempt，不能重报价 | 采纳，已复现 | 确定拒绝后允许重新报价和确认；历史 attempt 保留，未知结果仍锁住 |
| recover 裸 catch 把协议故障与网络/404 混在一起 | 采纳为诊断整改 | 用户状态保持未知，同时保留脱敏的失败分类；不能据格式错误宣布未成交 |
| result.error 没有运行时校验 | 采纳，畸形 Port 错误可进入公共状态 | HTTP 边界先解析共同错误 schema，再规范化 A 的公共错误 |
| Idempotency-Key 必须走 header；200/202 应有 HTTP 测试 | 采纳 | 内部 CheckoutInput 可以保留元数据字段，但明确禁止把整个内部对象直接序列化成 wire body |
| B2：payment_status 与实际字段形状不一致 | 采纳文档修正，保留现有 wire | 明写 `payment.status` 与 `fulfillment_status.status`，同步示例与 A 映射 |
| B3：merchant_id 已承担 audience 作用 | 采纳文档澄清 | 暂不增加独立 audience；继续严格检查已签名 merchant_id，并明确 key/issuer/环境边界 |
| B4：Windows 外部信号关库未验证 | 采纳为验收限制 | 分开验证优雅关闭与异常退出后的 SQLite/订单/幂等恢复；不据 handler 未运行直接推断数据丢失 |
| B1：增加清空测试数据工具 | 放到后续开发便利项 | 当前先使用显式隔离测试存储并修正文档；该作用域约束不等于必须交付清库工具 |

需修正或限制的结论：

- “没有任何真实通路”应收窄为“正式 commerce 路径尚未连接”。只读 OCP consumer 已能通过真实 HTTP 读取 B，这一能力与主运行流程已接入是两件事。
- “一条 fetch 加一行 workspace 解锁”仅指取得源码和解决工程入口，不涵盖授权、状态机和 HTTP 适配工作。
- “B 已逐条答完 C0”可理解为已提交候选接口及说明；不等于 A 已接受、共同冻结，或需求已验收。库存、身份绑定、filters 等仍有实际差距。
- “资金安全性质没有问题”不能作为整合结论。B 报告明确没有审 B 自己的代码，前次审计又已复现超卖等问题。模型不能批准、未知时不重买等 A 侧约束应保留，并继续联合验证。
- “全仓仅两处跨包依赖”应改为“A 的购物交易实现尚未依赖 B 的交易包”；原仓库还有其他跨包依赖。
- 118/15、35/3 与 560/37 分别属于 A 原快照全仓、A 路径限定、A+B 组合，不能直接互相否定。当前本机已复现 A 原来的 118/15。

## 4. C0 建议确认的决定

以下是下一阶段的推荐方案，尚不是双方已经签收的共同决定。A 审查后，由 B 将确定的语义落入 CONTRACT/schema/fixtures，双方记录同一个契约提交。

| 决定 | 推荐方案 | 理由或实现条件 |
|---|---|---|
| O1：跨 caller 查询 | 保持 404 | 不泄漏资源存在性；404 不构成“肯定没买”的证据 |
| O2：报价 TTL | 保持可配置的 900 秒 | 不改 wire；测试用可注入时钟验证边界，不等待 15 分钟 |
| 授权有效期 | 不超过报价到期，初版保留 A 的 60 秒上限 | 转成 Unix 秒后保证 expires_at > issued_at；窗口不足就重新报价，不签发过期证明 |
| O3：预算 | 只使用签名 payload.max_total_minor | 来源为用户确认的预算；不新增可放宽上限的未签名 body 字段 |
| audience | 已签名且被严格比较的 merchant_id | 明确商户标识唯一性及不同环境的 key/issuer 隔离 |
| caller 与 user | 本地第一版建议由 A 后端取会话用户，并明确约定 caller_id = payload.user_id | 这是拟定规则，不是假定现有字符串已相等；B smoke/fixtures 要同步。若保留不同命名空间，必须提供可信映射 |
| issuer 与 key | 配置限定某 key_id 可接受的 issuer | 不能让签名中的任意 issuer 标签替代可信签发方配置 |
| 商品、数量、履约 | 通过共同 terms_hash 绑定 | 使用 B 的 wire terms 和共享函数；不把 A flat read model 另算一套 hash |
| filters | 明确 field refs 到 wire filters 的映射，keyword 可以带已声明 filters | A/B 联合验证 currency/max_amount/in_stock_only；不虚报 hybrid 能力 |
| 版本 | 以 B 的 0.1.0 候选契约为评审起点 | 文档澄清与实现纠错不盲目改 wire；若增加字段或改变语义，按已约定规则更新版本与生成 fixtures |

A 的 `C0-REVIEW.md` / `STATUS.md` 在正式接入时应更新为“B 已在远端交付候选，本地主流程尚未合入/适配”，避免继续把历史本地状态写成当前远端事实。更新时间和已确认提交要明确。

## 5. 修改分工与优先级

### B：交易事实、共同契约及 fixtures

| 编号 | 优先级 | 修改内容 | 最小完成证据 |
|---|---|---|---|
| B-01 | P1，联合验收阻断 | 库存持久化；在事务中条件扣减或预留；明确 processing、失败和恢复时的库存处理 | 初始 1 杯，不同 key 的两个独立购买最多成功一个；重试不再扣减；重启库存不回到初始值 |
| B-02 | P2，联合授权验收阻断 | 绑定签名用户与报价 owner，并限定 issuer/key 的对应关系 | 错误用户的正确签名被拒绝；正确用户通过；quote/attempt/order/恢复归属一致 |
| B-03 | P2 | 入库金额精确换算，不以 Math.round 掩盖分以下精度 | `25.001` 入库拒绝；正确金额与 A 换算一致；同时检查安全整数 |
| AB-01 | P2，双方共同 | B 明确 manifest 的 filter 输入；A 按声明发送 keyword+filters | 22 条目录中，第 22 条唯一合格商品能够被 A 找到 |
| B-04 | 同步文档 | 修正嵌套 payment/fulfillment 字段、audience 说明、当前无 reset 工具及停机限制 | 文档、schema、生成 fixtures 三者一致 |

前次复现：库存 1 杯产生 2 笔订单/支付；quote caller=user_demo_1 但 signed user=different_signed_user 仍 confirmed；22 条目录中 A 得到 0 候选而服务端过滤能返回拿铁；B 接受 price.amount=25.001 / price_minor=2500，A 拒绝。修改后要用同类输入复测，不能用故障开关代替另一笔实际成交。

### A：根工程、transport、签发及用户流程

| 编号 | 优先级 | 修改内容 | 最小完成证据 |
|---|---|---|---|
| A-01 | 接入前置 | 根 workspace 登记 coffee app；集中处理 bun.lock、版本与门禁 | 全新安装可解析 app；实际 app typecheck/check 被执行 |
| A-02 | 接入前置 | 配置化受信商户；同步 Port/Session 模式与 runtime factory | HTTP 模式可装配，mock 仍独立可测试；页面持续明确付款为本地模拟 |
| A-03 | 核心接入 | HttpMerchantTransport + 共同 schema + signer 接口 | 实际 A 确认路由生成 B 格式授权，B 验签成交；主流程没有静默回退 mock |
| A-04 | P2，重报价验收阻断 | 修复确定拒绝后永久冻结；保留历史尝试与未知结果锁 | 商家 requote 后能取得新报价、重新确认；旧确认/proof 不能买新条款 |
| A-05 | P2，HTTP 边界 | 校验错误、attempt/order 字段与状态关系；恢复保留分类诊断 | 畸形 JSON/error/order 进入协议诊断并保持结果未知，不能显示成功或开放新购买 |
| AB-01 | P2，双方共同 | 修复 query filters 与分页策略 | 真实 A 请求携带正确 filters；返回结果仍本地复核预算/币种/库存 |
| A-06 | 联合验收 | tests/shopping-e2e 连接实际 B bootstrap 与独立持久 DB | 经过 A UI/API 确认、B 数据库和实际 HTTP 的成功/异常/恢复证据 |

A 当前 `ShoppingCoordinator` 还直接依赖 LocalMockIssuer。接入时除了扩大 `mode`，也应抽出可配置的签发接口，使用共同 payload、authorizationSigningBytes 和受控 key_id。禁止把 local-mock-v1 字符串包装一下就当 B 的 Ed25519 proof；双方算法相同，待签名字节与封装仍需统一。

HTTP 模式与付款是否模拟要分开表达。B 是真实运行的本地 HTTP 服务，但付款仍是模拟；不使用“真实付款已完成”描述它。

## 6. HTTP 适配必须明确的规则

| 边界 | 必须遵循的规则 |
|---|---|
| URL | 从可信配置确定 origin/catalog/merchant/action，解析 Resolve 后仍检查 origin、标准路径、有效期，拒绝重定向及任意 URL |
| quote 请求 | wire body 仅 entry_id、quantity、fulfillment；caller header 由 A 后端会话生成 |
| checkout 请求 | Idempotency-Key 与 caller 放 header；wire body 仅共同 schema 的 attempt、quote、hash、authorization；不发送 A 的 checkout_url/user_id/idempotency_key 等内部字段 |
| 授权 | 仅用户明确确认后签发；预算/quote/hash/revision 必须来自当前确认；私钥和可用 proof 不进模型、日志、普通 UI 或持久会话 |
| 报价 | 先解析 B wire，再核对商户/目录/entry/数量/履约/币种/总额/费用/expiry/hash；保存必要的不可变条款，生成 A 展示模型 |
| 订单 | payment 是对象；fulfillment_status 也是对象。读取各自的 .status，不能把对象当字符串 |
| 履约值域 | B 是 pending/ready/completed/cancelled，A 原 mock 是 preparing/ready/collected；显式映射或保留共同值域。pending 不足以证明“正在制作”，paid 不等于已取餐 |
| 付款值域 | B 允许 pending/paid/failed/unknown；不得把 unknown 映射成 paid 或确定失败 |
| 200 / 202 | 200 confirmed 需同时满足有效 attempt/order 及绑定；202 processing 只表示待查询，保留原 attempt/key |
| 非 2xx | 解析共同 error schema；根据已约定语义处理，不能用 HTTP 非2xx 一概判定可重买 |
| 格式/网络异常 | 保持未知，保存脱敏诊断分类，查询原 attempt；不新建 key、不改商品、不自动重复付款 |
| 测试价格 | A mock 当前经典拿铁含费 2800 分，B 当前拿铁自取为 2500 分；联合断言以 B 报价/订单为准，不搬用 mock 价格常量或扩大预算 |

内部 CheckoutInput 保留 idempotency_key 并不是协议错误；错误会发生在把内部对象直接当 HTTP body 时。优先划清元数据与 wire body，并用实际 HTTP 断言约束，而不是仅为字段命名改接口。

## 7. 重报价与恢复的状态机要求

必须保留的约束：**旧购买结果未知时，只能查原 attempt，不能以重报价、取消或换商品绕过锁。**

| 结果 | 会话处理 | 是否允许新购买 |
|---|---|---|
| 合法的 quote_expired / requote_required，明确未执行交易 | 归档旧 attempt 结果与原 key、quote/hash/revision；废止旧报价/确认，进入 requote_required | 取得新报价，用户重新确认后才能创建新 attempt/key |
| 明确预算/库存拒绝 | 展示拒绝原因，保留历史记录，按约定开放修改需求或重新报价 | 需要新报价与新确认；不得沿用旧 proof |
| 明确 payment_failed | 记录终止失败，展示付款失败 | 是否再次购买需明确操作和新确认，不能自动重试 |
| 202、超时、响应丢失、5xx、格式/订单校验失败 | 保持当前 attempt 与 unknown，查询原结果 | 不允许 |
| 查询原 attempt 得到 404 | 仍为 unknown：不存在或不归属无法证明未成交 | 不允许 |
| idempotency_conflict | 核查原 attempt/业务绑定；冲突可能对应已有交易 | 不能仅据冲突开放新 key |
| 合法 confirmed，订单绑定正确 | 显示 B 的订单和独立支付/履约状态 | 原逻辑购买终止；新的购买需显式开始 |

实现上可将“当前未决 attempt”与“历史终止 attempt”区分。不得简单删除 session.attempt 来解除全部锁，也不得因任何历史 attempt 存在而永久禁止重报价。

历史保存用于恢复的 IDs、key、报价条款/确认版本及结果；不保存可使用的授权证明或私钥。新报价递增 revision，旧确认请求即使再次到达，也不能触发新购买。

recover 的异常分类用于定位网络、404、schema 错误和金额/归属不匹配；用户仍可看到“结果未知”。诊断不能代替商家交易事实，也不能凭本地异常将结果降成确定未成交。

## 8. 集成顺序与完成条件

| 阶段 | 负责人 | 工作 | 退出条件 |
|---|---|---|---|
| S0：共同基线 | A 主持、B 落共同契约 | 确认第4节决定及版本；A 获取 B 代码、登记 workspace、处理锁文件 | 双方记录同一 C0 提交；app 可解析并配置检查通过 |
| S1：并行修改 | A / B 各自目录 | A transport/signer/映射/状态机；B 库存、身份、金额与 manifest | 各侧新增针对真实问题的用例通过；附修改和实际测试结果 |
| S2：成功通路 | A 主持、B 支持 | 启动独立 A/B 本地服务，从 A 确认路径购买拿铁 | UI → A → B → 订单真实贯通；一次支付/订单/扣库存；未确认不 Checkout |
| S3：负面与恢复 | A 执行、双方修各自问题 | 第9节矩阵，含并发、响应丢失与进程重启 | 每项有 HTTP、A状态、B数据库及恢复证据；无绕过未知锁 |
| S4：可合并交付 | A 汇总、双方提供材料 | 重跑统一版本下门禁、更新文档、提出可审查 PR | 浅唱浮柠审阅测试与剩余限制后决定合并；本报告不执行合并 |

延续原协作约定：联调分支由 A 维护，可使用 `codex/shopping-integration`；A 集中修改根配置，B 修改自己的服务/契约/fixtures。同步已确认的提交，不在主 checkout 随意切换、覆盖或强推。

“采用 A 版 bun.lock，再 install”可作为 B 提议的冲突处理方式；实际执行时需先核对合并后的所有 package.json，再用统一 Bun 版本生成锁文件，并验证 `bun install --frozen-lockfile`。不能未经核对永久丢弃 B 新依赖。

## 9. 联合验收矩阵

全部使用独立测试端口、显式测试数据库和公开测试配置，不操作现有运行中的数据。B 的内部 handler 测试保留，但本矩阵必须经过实际 A HTTP transport 和 B 网络入口。

| 场景 | 必须观察到的结果 |
|---|---|
| 正常拿铁，30 元总预算 | B 含费报价、用户确认后成交；支付/订单各1，库存减1；UI不宣称已取餐 |
| 未确认、取消、模型说“已批准” | 不产生 Checkout、支付、订单或库存扣减 |
| 两杯/履约费用使总额超预算 | 最终报价阶段或 B 授权预算检查拒绝；无成交 |
| 22 条目录，合格商品在首20条之后 | A 能找到合格商品；实际 filters 与本地复核一致 |
| price.amount=25.001 | B 入库拒绝，错误明确；正常整数分金额一致 |
| 错误用户或错误 issuer 的正确签名 | 被拒绝；正确映射通过；跨 caller 查询仍404 |
| 商户/quote/hash/数量/履约/币种/attempt 不匹配 | 授权或条款校验拒绝，不能以更换 key 重放旧授权 |
| 报价或授权过期、报价后涨价 | 拒绝成交；A 可重新报价并重新确认；旧确认不触发新 attempt |
| 初始1杯，不同key独立购买 | 最多1笔成功；另一笔库存拒绝；不是用故障开关假装另一笔成交 |
| 不同连接/进程争抢同库存 | 持久库事务保证不超卖，重启不重置库存 |
| 同key顺序、并发、重启后重复 | 同一支付/订单/库存变化；同key改业务字段冲突 |
| 支付明确失败 | 无 paid/confirmed 成功订单；库存预留正确释放或从未扣减 |
| 202 processing | A 显示待查询并锁新购买；原 attempt 后续收敛，不重复付款/扣库存 |
| 已成交但响应丢失 | A 从原 attempt 查回原订单；数据库仍各1；页面刷新仍恢复 |
| A/B 分别重启；B测试进程异常退出 | 查询与幂等、库存和订单可恢复；优雅关闭与异常恢复分别记录结果 |
| 错误 envelope、非法order、网络异常、查询404 | 保持未知，诊断有分类；无新key、商品替换或假成功 |
| failed 响应后重复旧确认 | 不创建新 attempt；用户拿到新报价并重新确认才允许新购买 |
| 日志、模型输入、公共会话/事件 | 无私钥、可用 proof/签名、支付秘密；错误数据经过规范化 |

除单元/集成用例外，至少运行一次 A 页面成功确认与一次响应丢失后刷新恢复。浏览器证据标注是真实 B 服务、本地模拟付款，不用 A mock 截图代替。

最终工程门禁至少包括：统一 Bun 版本的 frozen 安装、根 build/typecheck/test、A shopping:check、coffee app 的 check/typecheck、site:check，以及上述新联合用例。560 是当前基线，修改后的数量应按实际输出记录，不能强行沿用旧数字。

## 10. 下一次交付应提交什么

A、B 分别提供：具体提交、共同契约版本、修改文件、实际命令与结果、失败或未执行项、对另一侧的要求。A 汇总联合用例的 HTTP 响应、会话/attempt 状态和 B 数据库计数；响应丢失与重启案例必须能证明取回原订单。

本轮完成标准限定为**本地 HTTP 的模拟购物整合**。真实 LLM 仍属 C4，需要另行配置与验收；生产账户和真实支付不在本轮完成结论中。

本次审阅只新增这份计划文档及忽略目录中的审阅证据，没有修改 A/B 正式运行代码、切换主分支、提交、推送、合并或向协作者发送消息。
