---
name: growth-ops-recorder
description: 通过 Growth Ops REST API 读取账号运营上下文，规划任务，规范记录执行事实与外部凭证、指标观测快照、归因复盘与沉淀策略。适用于在 Growth Ops 工作台中托管账号的外部 AI Agent。
---

# Growth Ops 数据记录与对接规范 (Growth Ops Recorder)

Growth Ops（增长运营工作台）是外部 AI Agent 的结构化记忆库与事实数据库，而不是黑盒自动化执行器。你负责进行授权范围内的推演、规划与各平台的实际落地交互，并在工作台中客观记录事实。

从操作员配置的环境中获取 Base URL 和 Bearer API Key；严禁在文档、输出内容、截图或外部推文中泄露该密钥。本地默认地址为 `http://127.0.0.1:8787/api/v1`。

请查阅 [API 规范与数据格式](references/api.md) 获取接口字段定义与请求示例，并可参考 `docs/AI_AGENT_INTEGRATION_GUIDE.md` 查阅完整开发指南。

---

## 1. 核心架构与认知模型

Growth Ops 将增长运营体系拆分为**三维正交独立**的基础实体：
1. **账号 (`accounts`)**：具体的运营主体人设（如 `@example_studio`）。
2. **平台 (`platforms`)**：具体的渠道及规则（如 `platform-x`、`platform-xiaohongshu`）。
3. **产品 (`products`)**：实际推广的商业标的或工具（如 `示例产品 A`、`示例产品 B`）。

三者相互独立。单个账号可同时推广多个产品；单个产品也可以被多个账号在不同平台推广。

资产、策略、知识库与技能通过 `data.scope`（作用域）进行精细化隔离：
- `account`：当前账号专属（必须传入 `account_id`）。
- `platform`：平台级通用规则打法（建议传入 `platform_id`）。
- `product`：产品级专属定位与卖点（必须传入 `product_id`）。
- `global`：全局通用共享资产。

---

## 2. 标准作业循环（7 步工作流）

### 步骤 1：读取上下文与对账排查
- 通过 `GET /accounts` 确认具体操作的账号 ID，切勿凭空猜测。
- 调取 `GET /accounts/{id}/context` 检查当前账号近期的动作、指标和生效策略。
- 在新建任务前，调用 `GET /reconciliation?account_id={id}` 排查是否存在超期任务、缺失凭证或未核验的动作。**优先核验与闭环存量工作，严禁盲目创建重复任务**。

### 步骤 2：对齐产品与物料定位
- 通过 `GET /products?account_id={id}` 查看当前账号关联推广的产品。
- 如需提炼卖点或参考文案，调用 `GET /products/{product_id}/library?kind=document` 读取产品知识库、竞品差异与素材 Brief。

### 步骤 3：规划并录入待办任务 (`tasks`)
- 调用 `POST /tasks` 记录规划任务，请求头必须携带 `Idempotency-Key`。
- 填写 `account_id`、可选的 `product_id`、`task_type`、带时区的截止时间 `due_at` 以及明确的验收标准 `acceptance_criteria`。
- 关联 `strategy_id` 及 `strategy_version`，确保策略后续修订不会篡改历史任务的设计初衷。

### 步骤 4：执行落地并记录动作事实 (`actions`)
- 完成外部发帖、互动、调研等操作后，立即调用 `POST /actions` 记录事实。
- 记录 `occurred_at`（外部动作真实发生的精确时间，**严禁用入库时间充当动作时间**）。
- 对于发布类操作，务必保留 `evidence_url`（外部链接）和 `external_id`（外部平台内容 ID）。
- 若需要稍后回读确认，将 `requires_verification` 设为 `true`，`verification_status` 设为 `"pending"`。
- 在外部平台确认成功后，调用 `PATCH /actions/{id}`，带上 `version`，更新 `verification_status: "verified"`、真实核验时间 `verified_at` 与依据说明 `verification_evidence`。

### 步骤 5：记录时间戳指标观测 (`metrics`)
- 调用 `POST /metrics` 保存每个离散时间点的指标观测数据（`observed_at`）。
- 明确区分指标类型 `metric_type`：
  - `cumulative`：特定时间点的累计总量快照（如总粉丝数、总阅读量）。**严禁将多次累计值相加当作增长量**。
  - `interval`：在有界区间内的增量变动（需注明 `period_start` 与 `period_end`）。
- 正确标记可用性 `availability`：
  - `valid`：真实采集到的有效数值（即便为 0 也为 valid）。
  - `unavailable`：数据源当前无法提供或平台接口受限（此时 `value` 必须为 `null`，严禁将未知当作 0）。
  - `missing`：预期应当采集但本次遗漏。
  - `not_applicable`：该指标不适用于当前标的。

### 步骤 6：归因复盘与经验迭代 (`reviews`)
- 周期性或重点动作完成后，调用 `POST /reviews` 撰写复盘。
- 将客观观测到的事实（`facts`）与推测的主观归因（`hypothesis`）严格分离，并关联具体动作与指标凭证（`action_id`、`metric_ids`），提出明确的下一步迭代（`next_steps`）。
- 切勿把时间上的先后相关性武断当成因果关系，务必记录潜在的替代解释和不确定性。

### 步骤 7：知识沉淀与技能晋级 (`knowledge` / `skills`)
- 将复盘中提炼的可复用经验写入 `POST /knowledge`，并设定合理的 `scope`。
- 经过反复验证、具备明确前置条件和适用边界的 SOP/打法，可封装为标准技能录入 `POST /skills`。

---

## 3. X / Twitter 批量导入筛选规则

- 使用 `POST /import/twitter` 导入 Twitter Exporter CSV 或兼容的 Apify 数据时，必须传入目标 `account_id`。
- 服务端按目标账号 `data.handle` 与每行作者字段精确匹配（忽略大小写及开头的 `@`）；只导入该账号本人的原创、回复、转推和引用。
- 导出器为了补全回复关系而附带的其他账号原帖属于**外部上下文**，不得创建为本账号的 `contents`、`actions` 或 `metrics`。服务端会自动跳过，并在结果的 `skipped_external` 中报告数量。
- 缺少作者或推文 ID 的行分别计入 `skipped_missing_author`、`skipped_missing_id`，不得用“系统只有一个账号”等推断强行归属。
- 回复关系通过本人回复动作中的 `conversation_id`、`in_reply_to_status_id`、`in_reply_to_screen_name` 保存，不需要把被回复者的原帖伪装成本账号动作。
- 导入完成后核对：`total_processed = 本账号有效行 + skipped_external + skipped_missing_author + skipped_missing_id`（已存在且去重的本账号行仍属于有效行）。如计数不合理，应停止后续复盘并排查源文件字段映射。

---

## 4. 可靠写入与并发控制法则

1. **强幂等性（Idempotency）**：
   - 所有的 `POST` 请求必须在 Header 中携带唯一的 UUID 作为 `Idempotency-Key`。
   - 若遇到网络超时或未确定响应，使用**完全相同的 Payload 和相同的 Key** 重新发送。
   - 若修改了 Payload 内容，必须重新生成 Key；复用旧 Key 发送不同 Payload 会返回 `409 Conflict`。

2. **乐观并发控制（Optimistic Concurrency）**：
   - 所有的 `PATCH` 请求必须在 Body 中携带记录的当前版本号 `version`。
   - 若遇到 `409 version_conflict`，说明记录已被其他 Agent 或人工修改；此时应当重新 `GET` 最新数据，完成合流后再提交。

3. **执行与记录解耦**：
   - 数据库记录写入成功并不代表外部平台发布成功。
   - 反之，若外部动作已经成功但写入工作台超时，只需重试写入操作，**切勿因为数据库暂无记录而重复在外部平台发布**。
