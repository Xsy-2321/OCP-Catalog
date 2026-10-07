# A/B 本地 HTTP 整合验收报告

日期：2026-10-07。维护者：用户独立维护。

**结论：本地 HTTP 模拟购物整合通过验收，可以审查本地分支。** 最终完整测试 **681 pass / 0 fail，42 文件**，其中实际 A/B 联合 HTTP 用例 39 项；浏览器验收 13 项通过。未合入 main、未推送。真实 LLM、生产账户、真实付款和生产部署不在本轮范围内。

## 1. 基线与交付范围

- 临时整合分支：codex/shopping-integration，从 main 的 ce73a6021bf4a00e7e0f2da4cb2471085ff4a583 创建。
- 整合 B 已推送代码：origin/codex/coffee-merchant 的 161d4d1c247d4e59b7b989c69428d6e4f109732b。
- Git 合并仅 bun.lock 冲突；核对双方 package.json 后登记 Coffee API workspace 和 A 的共享契约依赖，使用 Bun 1.3.13 重新生成锁文件。
- 共同购物契约采用 shopping-contracts 0.1.0；SQLite schema 从1升至2。受信公钥 JSON 现在必须包含 issuer，旧纯 PEM 配置需更新。
- 本轮采用上传的 INTEGRATION-PLAN.md 作为审计和验收参考，原文保留。历史 A/B 目录所有权、双方签收和 PR 建议不作为操作授权；以用户本轮独立维护、仅本地整合的请求为准。
- 代码、测试、报告在本地整合分支交付。main 仍在上述基线；没有发布、推送或创建 PR。

## 2. 审计整改与接入

| 事项 | 最终实现与验证 |
|---|---|
| 库存超卖、重启重置 | SQLite 持久库存；BEGIN IMMEDIATE 内条件预留；processing 保留预留，成功消费，明确付款失败只释放一次。不同连接和实际进程争抢最后一杯最多成交一笔 |
| 旧库迁移补回库存 | 导入已售和未决预留；inventory_debts 记录历史超承诺，旧 pending 失败先抵扣缺口，不能把已售库存重新变为可售 |
| 用户/issuer 未绑定 | 已签名 user 严格等于 quote owner/caller；受信 key 限定 issuer；跨 caller 查询返回404 |
| 分以下金额被舍入 | A/B 共用 decimal/BigInt 精确整数分转换；拒绝25.001、科学计数中的分以下精度和不安全整数；金额运算检查安全范围 |
| 首20条筛选遗漏 | manifest 明确 wire filter 与 field ref 映射；keyword 请求发送已声明 filters；有界游标分页，结果仍本地复核预算、币种和库存 |
| 主流程仅 mock | 默认配置化 HTTP runtime，复用共同 schema 和 Ed25519 待签名字节；HTTP 缺配置/出错时不回退 mock；mock 保留为显式开发模式 |
| 确定拒绝后不能重报价 | 归档旧 attempt/key/quote/revision；新报价递增版本并要求新确认；旧确认不能触发新购买 |
| 畸形错误/订单误判 | 校验 schema、HTTP/业务状态关系和 merchant/catalog/quote/attempt/条款/金额绑定；公共错误固定文案，恢复保留脱敏诊断 |
| 非法订单后遗失成交证据 | 先保留合法 confirmed attempt/order ID，即使其余订单 envelope 非法；后续 failed/processing 倒退不能开放重买 |
| 未知状态跨会话绕过 | 用户级串行队列与持久用户会话扫描，重启后仍阻止同用户通过新会话购买；404、网络、5xx、冲突和协议错误不能证明未成交 |
| 会话指向另一个环境 | 数据目录绑定 mode/origin/merchant/catalog，任意维度改变均拒绝复用，旧会话不被修改为新环境 |
| 报价存储完整性 | 读取和旧库迁移时重新计算金额/hash一致性，损坏存储不能进入交易 |
| 嵌套状态误读 | 分别读取 payment.status 和 fulfillment_status.status；pending 显示待履约，unknown 不映射 paid |
| 同端口重启触达旧实例 | 停机先拒新请求、等待已进入的应用 handler 完成，再首次 stop(true) 关闭 socket，最后关 SQLite；正式 CLI 与导出 bootstrap 共用流程 |

历史已成交超卖无法逆转。迁移检查只在隔离旧库副本中验证，本轮未修改既有业务运行数据。新的库存机制不提供补库存/reset 管理工具。

## 3. 最终工程门禁

统一环境：Windows、**Bun 1.3.13 (bf2e2cec)**，使用整合后的 bun.lock。浏览器为独立无头 Chrome context。

| 实际命令/检查 | 最终结果 | 本机证据（.codex-tmp/integration/） |
|---|---|---|
| 完整源码独立副本 bun install --frozen-lockfile | 无 node_modules 起步，680 packages 安装成功；副本锁与最终锁一致 | frozen-install.log、final-clean-install/ |
| bun run build | 14/14 tasks 成功 | build.log |
| bun run typecheck | 24/24 tasks 成功，含 Coffee API | typecheck.log |
| bun run test --force | 24/24 tasks 成功、0缓存；10个测试包共627项通过 | root-test.log |
| bun test packages apps examples/typescript tests | **681 pass / 0 fail，42文件，3032 expect**；含根脚本未涵盖的54项 E2E/config测试 | full-tests.log |
| bun run shopping:check | Runtime/API/E2E 类型检查及 UI JS/静态文件检查通过 | shopping-check.log |
| bun run shopping:build | 通过，生成购物 UI 静态副本 | shopping-build.log |
| bun run coffee:check | 独立库配置检查及类型检查通过；没有开端口 | coffee-check.log |
| bun run site:check | 36 docs routes、22 artifact entries、7 updates 通过 | site-check.log |
| git diff --check | 通过 | Git 检查 |
| 最终 HTTP 页面验收 | **13项通过**，无页面 JS 异常；已查看移动端订单和响应丢失截图 | browser-check.log、browser-evidence/ |

测试启动子进程时清除桌面注入的 CODEX_HOME/CLAUDE_CONFIG_DIR，避免原有 CLI 配置测试读取桌面个人 profile；没有改动原 CLI 行为。本机实际使用 bun .codex-tmp/integration/run-clean-env.ts run test --force 和同 wrapper 的完整 test 命令。普通无此注入的终端可直接使用表中命令。

根构建中 Runtime/API 的 build 只执行类型检查，因此 Turbo 报告没有输出文件的提示；这两个应用由 Bun 直接执行 TypeScript。UI build 会生成 dist。类型检查与测试均通过，不将这两条提示当成编译失败。

首次全仓验证的重启失败、旧配置环境干扰及生命周期测试中 Bun node:http 缓冲部分 body 的问题均已定位并复验。生命周期回归改用真实 TCP 分段请求；最终结果只采用上表输出，未沿用原报告的118或560数量。

## 4. 联合验收矩阵与证据边界

主要套件：[http-flow.test.ts](../../tests/shopping-e2e/http-flow.test.ts)，**39项通过**。路径为 A 实际确认 HTTP 路由 → HTTP transport → B 正式 bootstrap socket → 独立 SQLite；记录真实请求和注入故障响应只用于测试。没有用 A mock 订单代替 B 成交事实。

| 场景 | 实际观测与结论 |
|---|---|
| 拿铁、30元总预算 | B自取最终价2500分；确认前0 checkout/attempt/payment/order；确认后各1、库存12→11；paid与pending分别显示 |
| 未确认、取消、模型声称批准 | 不产生购买；approved/message请求被拒绝；取消后旧确认不能购买 |
| 两杯超预算 | A真实目录过滤得到0候选；0支付/订单/预留 |
| 配送费用超预算 | B报价/checkout单侧测试验证含500分配送费总额和签名预算；A mock另有含费31元阻断回归。**A当前UI/联合购买只支持自取，未把配送UI声明为已验收** |
| 第22条唯一合格商品 | A实际keyword请求携带currency/max_amount/in_stock_only并找到第22条；另一会话搜索不清除已保存候选 |
| 精度25.001、金额溢出 | B入库、共同金额边界与A换算回归拒绝；正常整数分保持一致 |
| 正确签名但错误user/issuer | 实际A checkout wire替换并重签后B拒绝，0支付/订单 |
| 商户、quote、hash、币种、attempt、预算、expiry | 实际wire正确签名的非法绑定被拒绝；旧proof改attempt重放也被拒绝 |
| 数量/履约改变 | B权威测试条款改变且新hash自洽；A旧确认只得到requote_required，0成交 |
| 报价/签名到期、涨价、重报价 | 注入时钟验证TTL与不足1秒授权窗口；明确拒绝归档，旧确认不生新attempt，重新报价/确认才可购买 |
| 最后一杯 | 两个真实独立A会话/不同key最多1成交；B单侧另用两个DB连接及两个实际Bun进程验证同库竞争 |
| 同key顺序、并发、重启后重复 | 实际A生成的wire重放始终同一order/payment；同key改quote/hash/attempt冲突 |
| 明确模拟付款失败 | 无成功订单；失败结果持久化，预留归还一次 |
| 202与跨会话未知锁 | 原attempt/key/预留保留；同用户第二会话及A重启不能绕过；恢复收敛到原订单 |
| 已成交响应丢失 | A/B同配置重启后查询原attempt得到原order，数据库仍1支付/1订单/1库存变化 |
| malformed error/order、404、网络 | 保持unknown与原key；诊断分类脱敏；已confirmed证据不被随后failed/processing覆盖 |
| 资源归属 | 外部cookie不能读/操作A会话；B的quote/attempt/order跨caller仍404 |
| 异常退出 | 正式B CLI进程强制终止后同库/同端口重启，原订单、支付、库存和幂等仍恢复 |
| 优雅应用关闭 | [server.test.ts](../../apps/coffee-merchant-api/src/server.test.ts)真实TCP部分JSON请求：两次stop同promise、handler未结束时DB未关，写入quote后关闭；同端口新实例可继续报价。1项/12 expect通过 |
| 敏感信息 | 公共会话/历史/事件/模型回归不含私钥、可用proof/signature、幂等key或付款凭证；恢复只持久化必要业务信息 |

HTTP transport单独43项覆盖共享schema、实际HTTP测试服务、签发、URL、报价、200/202、非法绑定及成交证据。它们已包含在681总数内，不能全部当作真实B数据库联合验收。根 test 与完整 test 是不同执行入口，不能相加计算唯一用例数。

## 5. 最终浏览器验收

启动 [browser-http-server.ts](../../tests/shopping-e2e/browser-http-server.ts)，运行 [browser-http-check.mjs](../../tests/shopping-e2e/browser-http-check.mjs)。新隔离数据库：.codex-tmp/integration/browser-final-data/merchant.sqlite。本次 A/B URL 分别为 http://127.0.0.1:62310 / http://127.0.0.1:62309，仅为临时验收端口，不作为日常配置。临时验收服务已关闭，数据库和截图证据保留。

13项检查覆盖真实B含费报价、点击确认前无attempt、付款/履约分离、刷新原订单、移动端无横向溢出、成交后浏览器确认响应丢失、锁住新购买与取消、刷新恢复同attempt/order、禁止二次checkout、无JS异常。

| 购买 | B订单 | 原attempt | 金额 |
|---|---|---|---:|
| 正常确认 | ord_5bc8d637-4bbd-461f-80ea-ec6df939d957 | attempt_f1e94b80-5560-4b45-bcdd-f86a37550658 | 2500 |
| 成交响应丢失后恢复 | ord_51d078ee-1367-4557-bdc9-080056ad7735 | attempt_80351db5-6c5e-4f54-8118-2e3d4ad9df9b | 2500 |

只读数据库复核：订单2、模拟付款2、consumed预留2、拿铁剩余10（初始12）。页面分别显示模拟已支付和待履约。签发key只在验收服务内存中生成，没有写入证据。

本机忽略目录的可审查证据：

- .codex-tmp/integration/browser-evidence/report.json
- .codex-tmp/integration/browser-evidence/database.json
- .codex-tmp/integration/browser-evidence/http-quote.png
- .codex-tmp/integration/browser-evidence/http-mobile-order.png
- .codex-tmp/integration/browser-evidence/http-response-lost.png
- .codex-tmp/integration/browser-evidence/http-recovered-order.png

## 6. 维护注意与剩余范围

- 日常A/B启动见 [购物README](../shopping-agent/README.md) 和 [Coffee README](../../apps/coffee-merchant-api/README.md)。两份样例统一B端口8787。HTTP必须同步origin、merchant/catalog、issuer/key和后端私钥配置；key轮换时B同步信任。
- A当前页面使用固定商品关键词，联合购买范围是自取；真实LLM仍属C4，未配置/未验收。付款均为本地模拟。
- 开发caller header与随机cookie仅支持本地资源归属，不是生产认证。测试未访问真实支付或外部商业API。
- 同一A数据目录只允许一个API进程。未知交易锁住同一用户的所有会话；不能删库/换会话/换配置绕过。A异常退出可能留下server.lock，应核查PID后按README处理。
- Windows外部控制台信号能否进入CLI handler未单独确认；本轮分别证明了应用stop排空与真实CLI强制退出的数据恢复。stop(true)可关闭响应socket，handler排空不保证客户端收到最后响应；购买恢复依赖持久attempt/幂等。
- 旧库已成交超卖不能撤销；迁移有缺口保护但不补库存。没有数据reset/补库存工具，测试使用显式隔离目录。
- 本报告仅给出本地分支候选的验收结论。是否合入main、推送或发布由用户检查后决定。
