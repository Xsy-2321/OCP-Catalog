# 一杯之间：购物应用

项目由用户独立维护。主运行路径为本地 **HTTP**：A 页面/API 通过 OCP 搜索与 Resolve 访问 B Coffee API，在用户明确确认后签发共同 Ed25519 授权。B 使用持久 SQLite 保存库存、购买尝试、模拟支付、订单及幂等结果。付款为本地模拟。Agent 模式支持用户在演示入口填写模型 API 配置，首次使用默认为未配置。

## 一条命令启动

使用 **Bun 1.3.13**，在仓库根目录执行：

```powershell
bun install --frozen-lockfile
bun run shopping:demo:check
bun run shopping:demo
```

打开 http://127.0.0.1:4310/demo，在“模型 API 配置”填写自己的密钥并保存，然后进入用户演示。需要修改端口或数据目录时才复制 `.env.example` 为 `.env`，已有文件保留。统一启动器运行 A/B，自动生成并保留本地签名密钥，数据默认位于 `.codex-tmp/shopping-demo`。普通重启保持库存、会话与订单；`bun run shopping:demo --new-session` 创建独立排练目录并保留原资料。新目录不能作为旧未知购买失败的证据。停止使用 Ctrl+C。

关闭会等待请求和底层会话写入结束，再停止商家并释放目录锁；即使 Agent 已返回超时，也会等待后台取消清理落盘。

A 会话默认保存在 `agent/sessions/sessions.sqlite`，按用户和待处理状态索引。首次打开旧 JSON 目录会一次性事务导入，并保留原 JSON 作为迁移快照；迁移后 SQLite 是会话事实来源，旧 JSON 不会在重启时覆盖新状态。损坏记录或迁移后数据库缺失会停止操作，不能据此认定未知购买失败。回滚运行程序前应同时保存整个数据目录，并使用迁移前备份，避免旧版程序读取过时快照。

## 用户端和商家端的本地预览

在仓库根目录运行：

```powershell
bun run shopping:preview
```

请安装并使用仓库约定的 Bun 1.3.13。启动器读取已有 `.env` 的端口和数据目录配置；模型 API 在演示门户填写，旧 `.env` 中的模型密钥不再自动使用。恢复预览时设置 `SHOPPING_PREVIEW_DATA_DIR` 后再次运行同一命令。

它沿用统一 A/B 启动器，自动选取两个空闲端口，并在 `.codex-tmp/shopping-dual-preview/run-*` 新建这一轮的独立数据目录。终端会给出三个可直接打开的网址：**演示门户、用户演示入口、商家演示入口**。两个页面位于同一网址下，分别是 `/` 与 `/merchant`；后台仍在电脑本机运行。不需要部署服务器，也不会清空或替换原 `.codex-tmp/shopping-demo` 的数据、签名或未决购买记录。

首次打开门户 `/demo`，分别在两个标签页打开用户和商家入口。用户沿用现有购物身份；商家入口另发一个仅用于本地只读演示的身份标记，不会更换用户身份。这不是正式的账号注册或登录，任何能访问这台电脑本地网址的人都能进入演示商家页。页面及接口限于 `127.0.0.1`，只适用于本机预览，不用于公开经营。

商家页展示当前商家的商品名称、价格、库存、履约方式和配送费，以及订单商品、数量、费用、配送资料、付款与履约状态。商品信息来自已有商家服务目录，库存和订单来自该服务已打开的 SQLite；历史订单按当时保存的内容展示。确认购买前只有报价，不产生订单；用户确认后，点击商家页“刷新数据”可看到新订单和库存减少。付款成功显示“模拟已付款”，履约仍为“待履约（模拟）”，不会自动显示已送达。订单列表不展示电话和地址，打开详情后才显示。

商家接口只接受读取请求，不能编辑商品、补库存、接单、退款或推进付款恢复。商家刷新也不会替用户查询或结算未决购买；用户仍需在原用户身份下恢复原购买。完整登录、店员权限和真实物流留到后续。

Ctrl+C 停止后，恢复**同一轮**预览需保留目录、原签名、浏览器用户标记及端口。把启动时输出的路径代入：

```powershell
$env:SHOPPING_PREVIEW_DATA_DIR='<启动时输出的数据目录>'
bun run shopping:preview
```

恢复会读取该目录的 `preview.json` 并使用原来的两个端口；端口被占用或原数据、签名、会话绑定文件缺失时停止，不自动换端口或重建空数据。若要开始另一轮独立演示：

```powershell
Remove-Item Env:SHOPPING_PREVIEW_DATA_DIR -ErrorAction SilentlyContinue
bun run shopping:preview
```

现有 `bun run shopping:demo` 同样增加 `/demo` 和 `/merchant` 入口，默认仍用 4310/8787 和原数据目录；只有新命令 `shopping:preview` 默认选择新目录及空闲端口。分开启动的 `shopping:start` 没有商家读取能力，页面会隐藏双端导航。

本轮**无需数据库迁移**，继续使用 SQLite schema 3，没有新增表或更改交易字段。商家页只读取现有数据；启动器保留既有旧库升级机制，不能把启动旧库当作纯只读操作。新命令默认创建独立库，验收也只使用独立库。模型使用演示门户保存的本地配置，启动不会调用模型；自动验收使用本地协议 fixture，不消耗真实模型额度。

`--new-session` 会输出此次数据目录。要继续这一轮排练，设置 `SHOPPING_DEMO_DATA_DIR` 为输出目录，再正常启动；再次使用 `--new-session` 会创建另一个独立目录。

## 模型密钥配置

打开 `/demo`。配置卡片和用户 / 商家演示卡片分成两个展示页：本机未配置时先显示配置卡片，保存成功自动切到两个演示入口；已有配置时直接显示演示入口，点击右上角“更改api配置”可返回修改。`/demo#api-configuration` 是直接进入修改页的链接。首次使用显示“待配置”，不会自动使用你原来填写的 `DEEPSEEK_API_KEY` 或 `SHOPPING_LLM_*`。可以选择预设，再按服务商实际资料填写：

| 字段 | 含义 |
|---|---|
| 服务预设 / API 类型 | DeepSeek、OpenAI、Anthropic、Gemini，或其他兼容服务；类型决定请求协议 |
| 接口地址 | 服务商 API 基础地址，例如 `https://api.deepseek.com` 或 `https://api.openai.com/v1` |
| 模型名称 | 账号可用、支持工具调用的准确模型 ID，可自行修改预设 |
| API Key | 用户自己的密钥，首次保存必填；修改同一接口时留空可保留已保存密钥 |
| 超时时间 | 每次调用的上限，默认 30 秒，可填写 0.1–60 秒 |

支持 OpenAI 兼容 Chat Completions、Anthropic Messages 和 Gemini generateContent 三种协议。API Key 必须匹配服务商、接口和模型，模型必须支持 function calling；其他专有协议需增加适配器。接口使用 HTTPS，本机协议测试允许 loopback HTTP。DeepSeek 专用的非思考参数只用于其官方接口，不发送给其他兼容服务。

“测试连接”会以当前草稿发出一次小型工具调用，可能消耗少量模型额度，但不保存草稿，不创建购物会话或订单。“保存配置”通过校验后立即生效，无需重启。页面会清空输入框，后端仅返回是否已保存密钥。换接口或 API 类型时需重新填写密钥，避免误发旧服务商密钥。

配置保存在项目的 `.codex-tmp/shopping-model/settings.json`，由本地后端读取，已被 Git 忽略；密钥不保存在浏览器 localStorage、cookie 或 URL 中。该文件含密钥明文，应像 `.env` 一样保管，不分享整个 `.codex-tmp`。演示和新预览共用已保存的配置，重启仍保留。“清除配置”删除已保存的模型配置，Agent 恢复未配置状态，不清除购物记录。分开启动 A 也可通过 `/demo` 设置模型。

多个本地服务实例使用同一配置时，每次读取都以磁盘上的最新内容为准。保存和清除通过 `settings.json.lock` 协调，密钥已清除后，旧页面留空保存不会恢复旧密钥。异常退出留下写入锁时，先核对锁内 PID 并确认原进程已退出，再清理该锁；不能根据锁的时间自动抢占。

从购物表单前往 API 配置时，当前标签页临时保存购物草稿，配置页提供“返回购物”。返回后先恢复服务端购物记录，再恢复匹配的可编辑草稿；未决购买仍保持锁定。草稿只在浏览器 sessionStorage 中短时保留，返回后删除，不包含 API 密钥。Gemini 的 `v1` 和 `v1beta` 地址使用各自兼容的工具定义格式。

未配置时仍可使用手动搜索和商家看板。保存后进入用户页选择“Agent 规划”。预算是表单硬上限，语言中更低预算可以收紧；语言杯数与表单冲突时要求修改表单。模型只提取需求、搜索和请求报价，不能批准、签名、购买或修改商户。默认每次模型调用30秒，整轮Agent规划包含模型、目录分页和报价的总时限为110秒，最多8个规划工具步骤。超时中止后续搜索与报价，并停用该轮可确认报价；不会中断已经开始的购买或订单恢复。错误、超时或限流不自动重试或回退mock。

支持同一商家的混合商品购物篮与配送：最多 10 行需求、合计 1–20 杯。手动模式勾选“一次购买不同商品”，逐行填写关键词和杯数，在每组候选中选择商品后查看整单报价；Agent 模式可描述“一杯拿铁和一杯美式”，总杯数填 2。配送需在表单选择并填写收件人、电话和详细地址；这些表单信息不发送给模型。拿铁和美式的 demo 配送费为整单 5 元，仅收一次；不支持配送的商品不能选入配送订单。

每笔整单报价展示全部商品与费用，含配送费的总额不得超过预算，确认后才创建一笔模拟订单。任一项缺货时不能部分成交；未知结果只恢复原尝试。更改商品、数量、履约方式或配送信息后必须取得新报价并重新确认。“任选一种、同款多杯”和“不要配送、自取”仍可正常规划。空候选正常停止；报价失败可在原限制内有限改选。推荐金额与操作说明由实际报价和页面状态生成。配送和付款均属于本地演示，不对接真实物流或支付。

常规自动测试使用本地模型协议 fixture，不使用开发者的真实密钥或订单。需要验证外部模型时，在本地配置自己的密钥，且不要提交或上传相关日志和运行数据。

## 分开启动 A/B

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

1. 选择手动关键词或 Agent 自然语言，设置各商品杯数和包含全部收费的人民币总预算。Agent 模式先在演示入口填写模型 API；支持单商户混合商品、自取及商品声明支持的配送。
2. 从目录候选取得最终报价；目录筛选后仍复核币种、库存和整数分金额。
3. 检查条款，明确点击确认才会签发授权和结账。模型说“已批准”和取消操作都不能购买。
4. 分开查看付款与履约状态。B 的 pending 显示“待履约”；付款成功不表示咖啡开始制作或已经取餐。
5. 确定拒绝后可选择候选重新报价，旧失败尝试保存到历史，新条款必须重新确认。旧确认或许可不能购买新报价。
6. 202、响应丢失、5xx、协议/订单校验故障或查询404都保持未知，保留原 attempt/key，并在同一用户的所有会话中锁住新购买、取消及商品替换。刷新和“查询原购买结果”只恢复原尝试。已经收到的合法 confirmed attempt 不会因为后续畸形订单或倒退状态而被当作可重买的失败。

7. “查找未决购买”按当前身份从后端找到原会话，跨标签页或localStorage指针变化后仍能恢复。旧成功订单不能替代未决购买指针。
8. 刷新还原会话的预算、杯数和关键词；改变输入只是新需求草稿，会停用旧报价确认，需重新提交或重新报价。A重启后会重新向受信目录验证旧候选；商品移除或不再符合库存/预算时要求重新搜索。

浏览器使用随机 HttpOnly/SameSite cookie 标识本地用户，保留30天。A 将同一个后端会话身份作为 B caller 和授权 user；这是本地开发身份，不能当作生产登录。清除cookie或换浏览器不能找回原身份。localStorage只作为便捷指针，未决会话由后端查询。

## 验证

`bun run shopping:settings:browser` 在独立 A/B 服务和本机模型协议样例上验证配置页面的首次引导、连接测试、保存立即生效、重载、清除与手机布局，不读取或调用真实密钥。`node apps/shopping-agent-web/scripts/model-settings-browser-check.mjs` 额外验证换服务重填密钥、失败草稿不保存、跨标签页刷新和浏览器存储隔离。

`bun run shopping:configuration:browser` 验证从购物表单前往配置再返回时的草稿恢复，以及未付报价、未知购买、原会话恢复失败和禁用 sessionStorage 的边界；全部使用本地固定样例。

`bun run test:all` 单次执行完整源码套件；根 `bun run test` 也包含shopping-e2e，不应累加两个重复入口的用例数。GitHub Actions已有构建、类型、lint、完整测试、文档和三语言示例门禁。

`bun run shopping:integration` 运行真实 A HTTP 确认路由 → B 正式 bootstrap socket → 独立 SQLite 的联合测试；shopping:test 同时保留 A 独立 mock 和 transport 边界回归。B 单侧测试包含跨连接/进程库存争抢、异常退出、幂等与旧库迁移。

页面验收可启动 `bun tests/shopping-e2e/browser-http-server.ts`，使用独立 SHOPPING_BROWSER_DATA_DIR。将输出的 A URL 设置为 SHOPPING_PREVIEW_URL，然后执行 `node tests/shopping-e2e/browser-http-check.mjs`。它需要已有 Playwright/Chrome，可设置 SHOPPING_PLAYWRIGHT_PATH 和 SHOPPING_BROWSER_EXE，使用独立无头 context，验证用户确认、真实 B 报价、付款/履约分离以及成交响应丢失后的刷新恢复。证据默认写入 .codex-tmp/integration/browser-evidence。

`bun run shopping:browser` 可自动启动隔离A/B并完成浏览器恢复与模型协议验收；支持本机Playwright/Chrome或Codex bundled runtime，缺依赖会给出配置指引。模型fixture与故障控制只存在于测试启动器。

`bun run shopping:merchant:browser` 自动在另一独立目录和空闲端口验收双端页面：混合配送报价、明确确认后商家订单与库存同步、详情、刷新、同目录同端口重启、移动端布局和只读请求。测试控制仅存在于测试启动器，不进入正式页面/API。运行后的截图和报告只保存在本地忽略目录。

`bun tests/shopping-e2e/browser-http-server.ts --basket-check` 可自动验收混合配送页面，覆盖完整选择、一次运费、修改商品/地址后重新报价、确认与刷新恢复。

共同契约版本为0.2.0，共享 schema、authorizationSigningBytes、computeTermsHash 和精确金额函数。仅属于 demo 应用扩展，不修改 OCP 标准。真实模型接口已接入；生产身份、真实物流、外部支付和生产部署仍未实现。当前实现和自动验证入口见 [实现状态](STATUS.md)。[参赛展示脚本](COMPETITION.md) 给出原创范围、准备和演示场景。
