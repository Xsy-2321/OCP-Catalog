# 本地整合 C0 决定

本页记录本地 HTTP 购物应用采用的接口决定。当前共同购物契约为 0.2.0，交易、身份、预算与恢复约束由共享 schema 及联合回归保护。

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

工程登记 apps/coffee-merchant-api，使用 Bun 1.3.13 和冻结锁文件。部署时必须显式配置受信 key 与 issuer；切换环境时使用独立数据目录。

参见 [共同契约](../coffee-merchant/CONTRACT.md) 和 [实现状态](STATUS.md)。
