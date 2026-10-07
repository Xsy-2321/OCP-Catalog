# 购物助手整合状态

日期：2026-10-07。项目现由用户独立维护，当前交付位于本地 `codex/shopping-integration`。B 的已推送代码已整合，并修复本轮审计问题；未合入 main、未推送。完整实测结果、基线与限制见 [整合验收报告](../team-development/INTEGRATION-ACCEPTANCE.md)。

| 里程碑 | 当前结论 |
|---|---|
| C0 | 本地整合采用共同 shopping-contracts 0.1.0、schema 与生成 fixtures；具体决定见 C0-REVIEW.md，待用户审查本分支 |
| C1 | A/B 各自可运行；独立 mock 保留为显式开发模式 |
| C2 | 默认 HTTP 路径已接 B：OCP 搜索/Resolve、最终报价、明确确认、Ed25519 授权、模拟结账和订单查询 |
| C3 | 新增联合 HTTP、持久库、并发幂等、库存、授权拒绝、响应丢失和重启恢复验收；实际门禁结果以整合报告为准 |
| C4 | 未完成：Planner/tool loop 已有边界与 mock 测试，没有真实模型配置或模型调用验收 |

页面使用固定商品关键词检索，付款是本地模拟。开发 caller header/cookie 不构成生产账户系统。

## 工程与运行约定

整合门禁统一使用仓库约定的 Bun 1.3.13，包含全新 frozen 安装、根 build/typecheck/test、shopping 与 Coffee API 检查、联合 HTTP 用例和浏览器验收。命令、数量及证据路径统一维护在整合报告中。

HTTP 模式必须显式配置受信 origin、merchant/catalog、issuer/key ID 与私钥路径；缺配置时拒绝启动。mock 需 `SHOPPING_MODE=mock`，不能作为 HTTP 故障的自动回退。

会话存储绑定 mode/origin/merchant/catalog，不能把旧会话目录指向不同商家环境。未知交易保持原 attempt/key，并在同一用户的所有会话中阻止新购买；只能查询原结果。明确拒绝后可取得新报价，必须重新确认，历史尝试保留。

共同授权证明只在确认后的后端内存中签发，不进入公共会话、模型输入或持久会话。B 的可信公钥配置现在必须含 issuer，旧纯 PEM JSON 需按 README 更新。

## 历史记录

原 A 首阶段在 Bun 1.4.2 上记录 118 项测试与 14 项 mock 页面检查。它们仅描述整合前快照，不能用作当前 HTTP 验收结果；完整原文可从 main 的 Git 历史查看。
