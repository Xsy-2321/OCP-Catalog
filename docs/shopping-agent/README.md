# A 侧本地购物助手

这是 `docs/team-development/AGENT_A.md` 的第一阶段实现。界面、API、购买协调、明确确认和恢复逻辑属于 A。默认且唯一可运行模式为 **deterministic mock**：商品与交易来自 A 的固定开发 transport，付款仅为模拟，没有真实 LLM 或外部商业调用。

## 启动

在仓库根目录执行（要求 Bun 1.3+）：

```powershell
bun install --ignore-scripts
bun run shopping:check
bun run shopping:test
bun run shopping:build
bun run shopping:start
```

打开 `http://127.0.0.1:4310`。如果 PowerShell 找不到 Bun，本机可用 `C:\Users\xsy\.bun\bin\bun.exe`；运行根脚本前把它所在目录加入当前终端 PATH。

默认数据保存在仓库 `.codex-tmp/shopping-agent`。其中包含本地会话、用户归属、报价、稳定的购买尝试 ID/幂等键和固定 mock 结果；没有持久化签名私钥或可用的授权证明。目录仅用于开发，请保留它以测试重启恢复。同一个数据目录只允许一个 API 进程使用。

可设置 `SHOPPING_PORT`（默认 4310）和 `SHOPPING_DATA_DIR`（显式本地目录）。服务只监听 `127.0.0.1`，请使用该地址访问。启动时用 `server.lock` 拒绝同目录的第二个实例；正常 Ctrl+C 会释放锁。异常终止留下锁时不会自动删除：先检查锁记录的 PID 与实际进程，确认旧服务已经退出，再手动移除该目录里的 `server.lock`；如果不能确认，换一个新的开发数据目录。不得为了恢复自动清空原会话和订单数据。

## 使用

1. 输入需求、杯数与人民币总预算。预算包含所有收费，默认到店自取。
2. 查看候选目录价格，再点击候选取得最终报价。
3. 检查商品、数量、费用、含费总额、到期时间；只有明确点击确认才会签发 mock 许可并结账。取消不会结账。
4. 分别查看模拟付款状态与制作/取餐状态。“模拟已支付、制作中”不等于已经取餐。
5. 刷新页面会读取原会话。结果未知时只查询原尝试，不换 key 重买。结账已确定拒绝后，需由用户明确发起新需求；旧授权不会用于新报价。

固定样例：经典拿铁目录价 26 元，打包服务费 2 元，总价 28 元；特调拿铁目录价 29 元，含费总价 31 元，会被 30 元总预算拒绝。售罄样例不会进入可购买候选。两杯经典拿铁加费共 54 元，不会被 30 元预算接受。

API 使用本地随机 HttpOnly 会话 cookie 核对资源归属；这不是生产账户系统。浏览器 localStorage 只保存会话 ID。POST 的来源/内容类型受限，不能将模型的 `approved:true` 当作许可。

## 模块

- `apps/shopping-agent-web`：中文静态界面。
- `apps/shopping-agent-api`：仅本机监听的 HTTP API、会话身份、确认路由和静态文件服务。
- `packages/agent-runtime`：内部 read models、MerchantPort、协调状态、文件存储、签名 mock issuer、固定 transport、受限 planner/tool loop 和只读 OCP consumer。
- `tests/shopping-e2e`：通过真实本地 HTTP 验证 A API 的流程与隔离；没有冒充对 B 的联合验收。

Runtime 的模型工具仅能搜索、请求报价、查看状态；确认、签发许可及结账不在工具清单中。`Planner` 是可注入的接口，`DeterministicMockPlanner` 是明确标识的 mock。未提供和验证真实模型配置，因此 C4 尚未完成。

## 验证与限制

`shopping:test` 覆盖用户确认、含费预算、重复点击、失效报价、缺货/改价/模拟付款失败、响应丢失、重启恢复、资源归属、凭证不入持久化及工具边界。故障选项仅供测试构造 transport，不通过普通页面/API 开启。

本地 mock 用串行队列和原子 JSON 替换保存结果，供 A 的流程与恢复测试使用。它不能代替 B 的数据库唯一约束、库存扣减、支付幂等或跨进程保障。商家真实能力及共同端到端验收必须待 B 提供代码后验证。

共同 C0 schema/fixtures 尚未落地。A 的 TypeScript 内部 read models **不是第二套共同交易 schema，也不是 OCP 标准**。mock 的 `local-mock-v1` Ed25519 格式和 ephemeral key 仅供开发验证；B 的最终签名 envelope、可信 key 配置、terms_hash 和请求摘要规则仍待共同冻结。不会自动把 mock transport 切到未知 HTTP 服务。

只读 `OcpConsumer` 采用 OcpClient API 的受保护子类及现有 schema/查询校验器：无凭据、拒绝重定向，强制预配置 origin 与第一版标准路径。它根据真实 manifest 声明选择 pack 和 filters；声明不足时仅复核返回页并明确警告，不能保证目录召回全部合适商品。checkout action ID 需由共同契约显式配置。现阶段不实现或猜测 commerce HTTP wire contract，也不向 HTTP 地址发送购买授权。

可选浏览器检查：`tests/shopping-e2e/browser-check.mjs` 用 Playwright 和独立无头浏览器 context 操作已启动的本地 mock 预览；需要本机已有 Playwright/Chromium，或通过 `SHOPPING_PLAYWRIGHT_PATH`、`SHOPPING_BROWSER_EXE` 指定已有安装。它不会读取用户浏览器 profile。截图和 `report.json` 保存在 `.codex-tmp/shopping-browser-qa`。这不是日常启动的前置条件。

参见 [C0 接口评审](./C0-REVIEW.md) 与 [本阶段交付](./STATUS.md)。
