# 本地整合 C0 决定

日期：2026-10-07。项目由用户独立维护。本轮在 main 的 ce73a6021bf4a00e7e0f2da4cb2471085ff4a583 基线上合入 B 已推送候选161d4d1c247d4e59b7b989c69428d6e4f109732b，使用共同购物契约0.1.0并修复实现。以下是本地实现采用的决定，提交状态见验收报告；不是两位外部协作者的签收记录。

| 边界 | 本地决定 |
|---|---|
| Caller/user | A 后端 HttpOnly 开发会话身份同时作为 caller 和签名 user；B 严格等于 quote owner |
| Key/issuer | B 显式配置每个 key 可接受的 issuer；拒绝旧纯 PEM 配置。不同环境隔离 key 与 issuer |
| Audience | 严格验签并比较 payload.merchant_id；暂不添加 audience 字段 |
| 预算 | 只使用签名 max_total_minor；含费报价再次核对，不接受未签名宽限字段 |
| 时间 | B 报价 TTL 默认900秒可配置；A 签名不超过报价到期与60秒，Unix秒窗口不足就重新报价 |
| 条款 | 使用 B wire terms 与共享 hash；商品/数量/履约通过该 hash 绑定；持久化不可变安全快照 |
| 归属查询 | 跨 caller 返回404；404不能证明未购买 |
| 请求元数据 | Caller/Idempotency-Key走headers；Checkout body只有attempt/quote/hash/authorization |
| 查询 | 按manifest声明映射currency/max_amount/in_stock_only；keyword可以携带filters，并跟随有界游标 |
| 订单 | 分别读取payment.status和fulfillment_status.status，pending不伪装制作中，unknown不伪装已支付 |
| 重报价 | 确定终止后归档旧attempt/key/quote/revision；新报价新确认。未知结果只能查询原attempt |
| HTTP异常 | 5xx、网络、格式、订单/attempt绑定错误和查询404保持未知；只保存脱敏分类 |

A 独立 mock 的 local-mock-v1 证明不发送给 B。HTTP 使用共同 Ed25519 canonical bytes，仅在用户确认路由签发；模型工具没有 confirm/checkout 权限。HTTP 模式不静默回退 mock。

工程登记 apps/coffee-merchant-api，统一 Bun1.3.13生成并冻结验证锁文件。契约字段未扩展；trusted issuer 配置格式变更属于应用部署配置，需要同步更新本地配置。

参见 [共同契约](../coffee-merchant/CONTRACT.md)、[整合计划](../team-development/INTEGRATION-PLAN.md) 和 [验收报告](../team-development/INTEGRATION-ACCEPTANCE.md)。
