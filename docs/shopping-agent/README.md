# 本地购物助手

项目由用户独立维护。默认主运行路径为本地 **HTTP**：A 页面/API 通过 OCP 搜索与 Resolve 访问 B Coffee API，在用户明确确认后签发共同 Ed25519 授权。B 使用持久 SQLite 保存库存、购买尝试、模拟支付、订单及幂等结果。付款仍为本地模拟；真实 LLM 尚未配置。

## 启动

使用根 packageManager 固定的 **Bun 1.3.13**：

```powershell
bun install --frozen-lockfile
bun run shopping:check
bun run shopping:test
bun run shopping:build
```

先按 [Coffee API 说明](../../apps/coffee-merchant-api/README.md) 在独立目录启动 B，配置 MERCHANT_DB_PATH、MERCHANT_PUBLIC_BASE_URL 与受信公钥。MERCHANT_TRUSTED_KEYS_PATH 是 JSON 文件，每个 key ID 对应 `{ "public_key_pem": "公钥 PEM", "issuer": "agent_a_demo" }`。不接受只有 PEM 的旧配置。

A 环境变量见 [配置样例](../../apps/shopping-agent-api/.env.example)。在启动 A 的终端设置 SHOPPING_MODE=http、商家 origin/merchant/catalog、issuer/key ID 和后端私钥文件路径，再运行 `bun run shopping:start`，打开 http://127.0.0.1:4310。公钥只由 B 读取，私钥只由 A 后端读取；签名证明仅存在于明确确认到 Checkout 之间的内存，不进入持久会话或 UI。商户来源和操作路径由配置限定；HTTP 配置或服务失败不会自动切换 mock。

两份配置样例统一指向 B 的 `http://127.0.0.1:8787`。本地模拟可使用公开测试 seed 的 key（只能用于测试）：

```powershell
bun fixtures/shopping/keys/derive-test-keys.ts
New-Item -ItemType Directory -Force .codex-tmp/shopping-http | Out-Null
Copy-Item fixtures/shopping/keys/agent_a_test.private.pem .codex-tmp/shopping-http/agent-private.pem
```

B 按其 README 生成 trusted-keys.json；双方保持 `agent_a_test` / `agent_a_demo` 一致。上述脚本生成的私钥文件和运行目录已忽略。B 的环境文件位于 Coffee app 工作目录；A 的样例需在 A 启动终端设置，私钥/数据路径建议用绝对路径，避免工作目录不同导致读不到文件。

可显式设置 SHOPPING_MODE=mock 运行 A 独立固定样例。此模式的经典拿铁含费28元；B的拿铁自取报价为25元。UI 根据 /api/config 显示实际 transport 和模拟付款。

默认 A 会话在 .codex-tmp/shopping-agent，建议 HTTP 联调设置独立 SHOPPING_DATA_DIR。同一 A 数据目录只允许一个 API 进程。正常关闭释放 server.lock；异常退出可能留下锁，先检查锁记录 PID 和原进程，确认退出后手动移除锁或改用新目录。不得清空原会话来绕过未知购买状态。

会话目录绑定 mode、商家 origin、merchant_id 和 catalog_id。改变其中任何一项会拒绝复用该目录；切换环境时选择新的独立目录，并保留旧环境的未决交易恢复资料。同一配置可以轮换签发 key/issuer，但 B 必须同步信任配置。

## 使用与恢复

1. 输入商品关键词、杯数和包含全部收费的人民币总预算。当前流程使用固定关键词检索，页面不提供真实自然语言理解。
2. 从目录候选取得最终报价；目录筛选后仍复核币种、库存和整数分金额。
3. 检查条款，明确点击确认才会签发授权和结账。模型说“已批准”和取消操作都不能购买。
4. 分开查看付款与履约状态。B 的 pending 显示“待履约”；付款成功不表示咖啡开始制作或已经取餐。
5. 确定拒绝后可选择候选重新报价，旧失败尝试保存到历史，新条款必须重新确认。旧确认或许可不能购买新报价。
6. 202、响应丢失、5xx、协议/订单校验故障或查询404都保持未知，保留原 attempt/key，并在同一用户的所有会话中锁住新购买、取消及商品替换。刷新和“查询原购买结果”只恢复原尝试。已经收到的合法 confirmed attempt 不会因为后续畸形订单或倒退状态而被当作可重买的失败。

浏览器使用随机 HttpOnly cookie 标识本地用户。A 将同一个后端会话身份作为 B caller 和授权 user；这只是本地开发身份，不能当作生产登录。localStorage 仅保存会话 ID。

## 验证

`bun run shopping:integration` 运行真实 A HTTP 确认路由 → B 正式 bootstrap socket → 独立 SQLite 的联合测试；shopping:test 同时保留 A 独立 mock 和 transport 边界回归。B 单侧测试包含跨连接/进程库存争抢、异常退出、幂等与旧库迁移。

页面验收可启动 `bun tests/shopping-e2e/browser-http-server.ts`，使用独立 SHOPPING_BROWSER_DATA_DIR。将输出的 A URL 设置为 SHOPPING_PREVIEW_URL，然后执行 `node tests/shopping-e2e/browser-http-check.mjs`。它需要已有 Playwright/Chrome，可设置 SHOPPING_PLAYWRIGHT_PATH 和 SHOPPING_BROWSER_EXE，使用独立无头 context，验证用户确认、真实 B 报价、付款/履约分离以及成交响应丢失后的刷新恢复。证据默认写入 .codex-tmp/integration/browser-evidence。

共同契约版本为0.1.0，共享 schema、authorizationSigningBytes、computeTermsHash 和精确金额函数。仅属于 demo 应用扩展，不修改 OCP 标准。真实 LLM、生产身份、外部支付和生产部署不在本轮范围内。当前完成情况和实际门禁见 [验收报告](../team-development/INTEGRATION-ACCEPTANCE.md)。
