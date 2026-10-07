# A 对 C0 的接口需求与评审

日期：2026-10-07。依据：`docs/team-development/README.md`、`AGENT_A.md` 及当前本地代码。

## 当前状态

尚无 `packages/shopping-contracts`、`fixtures/shopping`、`apps/coffee-merchant-api` 或 `packages/merchant-core`。C0 未冻结，C2 商家 HTTP 联调无法进行。A 不直接建立或维护 B 的 schema/fixtures；本文件给 B 提供明确需求。

## 需要 B 交付的共同基线

| 内容 | A 所需语义 |
|---|---|
| 契约版本和 export 名称 | 请求/响应、校验器、统一错误 envelope 与 HTTP 状态，以及版本兼容策略 |
| Catalog 身份 | 已知 discovery/manifest URL、catalog ID、merchant ID 与 entry/provider 到商家的可信映射 |
| 能力 | 明确 query pack/mode；currency、max_amount、in_stock_only 的字段声明和实际执行 |
| Resolve | checkout action 的明确识别方式、POST 入口、input_schema、有效期、live check 和权限语义 |
| Quote | 归属、商品和数量、履约、币种、单价、全部费用、含费总额、到期、服务端 terms_hash |
| Caller identity | quote/checkout/attempt/order 的本地开发身份传递约定；不信任客户端自报 user ID |
| Authorization | 签名算法、精确 envelope/canonical bytes、issuer/audience/key ID、受控公钥配置；绑定 user/merchant/quote/hash/currency/budget/attempt/expiry，并约定商品数量与履约的绑定方式 |
| 幂等 | key header、caller/merchant 作用域、同请求摘要算法、结果重放规则与原子唯一约束 |
| Checkout/Attempt | 同一个 attempt 的 processing/confirmed/failed 响应；not_found 与“确定未执行”的区别；禁止不确定时新 key 购买 |
| Order | 订单 ID、原 attempt、商品/报价快照、金额、payment_status、fulfillment_status、updated_at 与归属 |
| 测试配置 | 本地端口、显式测试 DB、可信 mock key 配置、故障开关、成功/超预算/售罄/改价/响应丢失样例 |

交易金额统一为最小货币单位整数。OCP `price.amount` 保留已有含义，A 在边界精确换算为分，拒绝 sub-cent/非有限/不安全金额。预算会在最终报价重新检查，目录预算筛选不能代替含费总额验证。

## 当前 A 适配边界

`packages/agent-runtime/src/types.ts` 是 A 内部 read models 与 `MerchantPort`，有显式“非共同 wire protocol”注释。C0 落地后编写一个使用共同校验器的 HTTP adapter，将 B 的字段映射到这些 read models；不让模型接触签名私钥或可用授权。

只读 OCP consumer 复用本仓 OcpClient 和 schema。真实交易的 HTTP adapter 暂不实现，不根据猜测签发或发送授权证明。允许的商家 origin、路径和 checkout action 必须预配置，来自 Resolve 的任意 URL 不构成信任。

本地 mock 签名格式仅用于 A 测试，不要求 B 接受它，不视为共同决定。完成 C0 后应基于固定格式重新验证签发/验签、旧 attempt 重放、商家/商品/数量/条款不匹配与过期等负面场景。

## 联调交付条件

B 交付共同契约/fixtures、可启动的 Coffee API、端点及开发身份/验签配置后，A 才能替换主流程 transport，执行联合模拟购买。联合验收需实际核对原子支付和订单幂等、服务重启、库存与费用、归属和真实响应；A mock 的成功记录不能代替这些证据。
