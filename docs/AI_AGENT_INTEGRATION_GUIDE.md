# Growth Ops AI 数据记录与对接指南 (AI Agent Integration Guide)

本指南面向接入增长运营工作台（Growth Notes / Growth Ops）的 AI Agent、自动化脚本或开发者，详细说明如何规范地读取上下文、写入和更新运营数据。

---

## 1. 核心交互哲学

1. **工作台是记忆与事实数据库，而非黑盒执行器**：
   - AI 负责推演、规划和具体平台的落地执行（如发布推文、回复互动、抓取分析）。
   - 工作台负责客观留痕（Truth of Source）：保存真实发生的时间、外部凭证、指标数值与归因复盘。
2. **三维正交架构（账号、平台、产品独立而关联）**：
   - **账号 (`accounts`)**：具体的运营主体人设（如 `@example_studio`）。
   - **平台 (`platforms`)**：运营渠道规则（如 `platform-x`、`platform-xiaohongshu`）。
   - **产品 (`products`)**：推广的业务标的（如 `示例产品 A`、`示例产品 B`）。
   - 三者彼此独立。一个账号可以推广多个产品；一个产品可在多个平台被多个账号推广。
3. **真实性原则**：
   - 区分“规划”与“执行”：未完成的事项写入 `tasks`，真实发生的事情写入 `actions`。
   - 区分“有效数值 0”与“缺失/未采集”：指标不可获取时传 `availability: "unavailable"`，禁止把未知当作 0。
   - 区分“数据库写入成功”与“外部执行成功”：仅在拿到外部真实链接或回读核验后，才将动作标记为 `verified`。

---

## 2. 通信规范与鉴权基础

### 2.1 接口基础
- **Base URL**：默认为本地服务 `http://127.0.0.1:8787/api/v1`（也可在工作台「系统设置 → 设置与接入」中查看）。
- **请求头鉴权**：所有接口均需携带 Bearer Token：
  ```http
  Authorization: Bearer <YOUR_API_KEY>
  Content-Type: application/json
  ```
  *(注：API Key 存储在 `data/api-key` 或从启动终端获取，禁止在任何公开文件或代码仓库中泄露。)*

### 2.2 新增防重与幂等（`POST`）
调用所有 `POST /api/v1/:resource` 写入新记录时，**必须在 HTTP Header 中传递 `Idempotency-Key`**：
```http
Idempotency-Key: <UUID 或唯一业务标识>
```
- 若网络超时或响应异常，使用**相同的 Payload 和相同的 Idempotency-Key** 重试，系统会幂等返回初次创建结果，避免重复创建数据。
- 若 Payload 内容发生变动，必须生成新的 Key；复用不同 Payload 的旧 Key 会触发 `409 Conflict`。

### 2.3 并发控制与乐观锁（`PATCH`）
调用 `PATCH /api/v1/:resource/:id` 更新记录时，**必须在请求体中携带当前记录的 `version`**：
```json
{
  "version": 1,
  "status": "completed",
  "data": { ... }
}
```
- 系统执行乐观锁校验：若数据库中记录已被其他人或 Agent 修改（version 不匹配），会返回 `409 version_conflict`。
- 遇到 409 冲突时，AI 应先重新 `GET` 最新数据进行合流，再提交更新。

---

## 3. 核心运营飞轮与数据写入规范

```
  ┌─────────────────────────────────────────────────────────────┐
  │                    标准化增长运营飞轮                        │
  │                                                             │
  │   [01. 规划任务] ──> [02. 执行落地] ──> [03. 凭证核验]      │
  │      tasks              actions            actions          │
  │         │                                     │             │
  │         ▼                                     ▼             │
  │   [06. 策略沉淀] <── [05. 归因复盘] <── [04. 指标观测]      │
  │    strategies            reviews           metrics          │
  └─────────────────────────────────────────────────────────────┘
```

### 3.1 步骤 0：读取上下文与待办
在采取任何新的行动前，AI 应先读取当前账号的最近上下文和待对账事项：
- **读取账号最近上下文**：`GET /api/v1/accounts/:account_id/context`
- **读取待核验与异常事项**：`GET /api/v1/reconciliation?account_id=:account_id`
  - 如果发现存在过期的待办或未核验的动作，应优先解决或核验存量工作，避免盲目新建重复任务。

---

### 3.2 步骤 1：规划运营任务 (`tasks`)
- **端点**：`POST /api/v1/tasks`
- **Header**：`Idempotency-Key: <UUID>`
- **请求格式**：
```json
{
  "title": "发布 示例产品 A 断食热量估算对比帖",
  "account_id": "account-example-x",
  "product_id": "hist-products-7ff2bf56144e7962d6a3dd89",
  "status": "planned",
  "data": {
    "task_type": "content_publishing",
    "due_at": "2026-09-11T12:00:00+08:00",
    "acceptance_criteria": "在 X 上发布包含两张应用截图与使用场景对比的推文，并附带体验链接",
    "strategy_id": "strat-demo-product-a-x-promo"
  }
}
```
- **字段规范**：
  - `task_type`：`content_publishing`（发布内容）、`account_operations`（账号运营）、`asset_creation`（素材制作）、`product_preparation`（产品准备）、`analysis_review`（数据复盘）、`strategy_planning`（策略规划）。
  - `due_at`：计划截止时间，必须带有时区（ISO 8601）。
  - `status`：`planned`（待执行）、`in_progress`（进行中）、`completed`（已完成）、`blocked`（阻塞）、`cancelled`（已取消）。

---

### 3.3 步骤 2：记录真实动作与核验凭证 (`actions`)
执行了外部发帖、评论、资料更新后，立即记录动作事实。
- **端点**：`POST /api/v1/actions`
- **Header**：`Idempotency-Key: <UUID>`
- **请求格式（发布时先记录，待核验）**：
```json
{
  "title": "发布 X 对比推文：外食估算误差实测",
  "account_id": "account-example-x",
  "product_id": "hist-products-7ff2bf56144e7962d6a3dd89",
  "status": "completed",
  "data": {
    "action_type": "post",
    "occurred_at": "2026-09-10T16:20:00+08:00",
    "task_id": "task-uuid-or-id",
    "strategy_id": "strat-demo-product-a-x-promo",
    "strategy_version": 1,
    "result": "推文已成功调用 X API 发布，等待平台抓取曝光数据",
    "evidence_url": "https://x.com/example_studio/status/123456789",
    "external_id": "123456789",
    "requires_verification": true,
    "verification_status": "pending",
    "review_due_at": "2026-09-11T16:20:00+08:00"
  }
}
```
- **请求格式（回读确认后，更新为已核验）**：
  - `PATCH /api/v1/actions/:action_id`
  ```json
  {
    "version": 1,
    "data": {
      "verification_status": "verified",
      "verified_at": "2026-09-10T16:25:00+08:00",
      "verification_evidence": "通过官方推文公开页面确认状态码 200，内容正文与截图完整呈现"
    }
  }
  ```
- **关键规则**：
  - `occurred_at`：必须为外部动作真实发生的时间，**禁止以入库时间充当动作时间**。
  - `verification_status`：`pending`（待核验）、`verified`（已核验）、`failed`（核验失败）、`not_applicable`（不适用）。
  - 当标记为 `verified` 时，必须同时提供 `verified_at`（时区时间）和 `verification_evidence`（核验依据文本）。

---

### 3.4 步骤 3：记录数据观测快照 (`metrics`)
记录指标时必须区分“累计快照”与“区间增量”，并准确标记采集源与精度。
- **端点**：`POST /api/v1/metrics`
- **Header**：`Idempotency-Key: <UUID>`
- **请求格式**：
```json
{
  "title": "ExampleStudio X 账号关注者数",
  "account_id": "account-example-x",
  "product_id": null,
  "status": "active",
  "data": {
    "metric_name": "followers_count",
    "value": 128,
    "availability": "valid",
    "metric_type": "cumulative",
    "observed_at": "2026-09-10T17:00:00+08:00",
    "observed_at_precision": "instant",
    "source": "x_api_user_lookup",
    "action_id": null
  }
}
```
- **字段规范**：
  - `availability`：
    - `valid`：真实获取到数值（即使数值为 0）。
    - `missing`：该观测点尚未采集。
    - `unavailable`：平台不可获取或接口限制（此时 `value` 必须设为 `null`）。
    - `not_applicable`：不适用该指标。
  - `metric_type`：`cumulative`（累计快照，如总粉数、总阅读数）、`interval`（区间数据，如当日新增粉丝）。如果是 `interval`，应在 `period_start` 和 `period_end` 中指定区间。
  - `observed_at_precision`：`instant`（精确时间点）、`minute`（精确到分钟）、`day`（仅有日期）。

---

### 3.5 步骤 4：归因复盘沉淀经验 (`reviews`)
当完成一个运营周期或重要动作后，编写复盘，闭环经验飞轮。
- **端点**：`POST /api/v1/reviews`
- **Header**：`Idempotency-Key: <UUID>`
- **请求格式**：
```json
{
  "title": "ExampleStudio X 账号第 2 周冷启动复盘",
  "account_id": "account-example-x",
  "product_id": "hist-products-7ff2bf56144e7962d6a3dd89",
  "status": "active",
  "data": {
    "period_start": "2026-09-03T00:00:00+08:00",
    "period_end": "2026-09-10T00:00:00+08:00",
    "facts": "本周共发布推文 14 条，互动回复 35 次；新增粉丝 42 人，其中带真实应用截图对比的推文带来 80% 的转评赞。",
    "hypothesis": "海外独立开发者社区对外食热量估算的'可验证性'关注度高，真实评测风格比功能宣传片转化率高 3 倍。",
    "evidence": "动作为 act-xxxx 与 act-yyyy 的推文互动率达到 4.2%，远高于平均 1.1%；指标详见 met-zzzz。",
    "next_steps": "下周策略转向'每日外食实测打卡'系列，将生产流程沉淀为通用模板并在任务中排期。",
    "action_id": "act-xxxx"
  }
}
```
- **核心逻辑**：
  - 将观察到的事实 (`facts`) 与推测原因 (`hypothesis`) 分离。
  - 产出的下一步行动 (`next_steps`) 可以作为后续 `tasks` 的输入，形成持续循环。

---

### 3.6 步骤 5：策略、产品物料与知识库

#### 策略库 (`strategies`)
- `scope` 划分：
  - `platform`：平台级通用打法（如 `platform-x` 30天冷启动策略）。
  - `account`：针对特定账号的定位策略（需填 `account_id`）。
  - `product`：针对特定产品的推广策略（需填 `product_id`）。
  - `global`：全局通用大纲策略。
- 格式：
```json
{
  "title": "X 账号互动回复与蹭热度策略",
  "account_id": null,
  "product_id": null,
  "status": "active",
  "data": {
    "scope": "platform",
    "platform_id": "platform-x",
    "body": "## 核心准则\n1. 寻找 10k-50k 垂直博主并在发布后 15 分钟内提供有信息增量的回复...\n"
  }
}
```

#### 产品与多账号关联 (`products`)
- 一个产品可以通过 `data.account_ids` 关联多个运营账号：
```json
{
  "title": "示例产品 A",
  "status": "active",
  "data": {
    "url": "https://example.com/product",
    "positioning": "可检查、可修正的断食营养记录 App",
    "audience": "记录断食与注重外食营养的用户",
    "account_ids": [
      "account-example-x"
    ]
  }
}
```

#### 产品推广资料与物料库 (`/products/:product_id/library`)
- 读取资料：`GET /api/v1/products/:product_id/library?kind=document` 或 `kind=asset`
- 写入推广文档（Brief/清单/文案草稿）：
  - `POST /api/v1/products/:product_id/library`
  ```json
  {
    "kind": "document",
    "title": "示例产品 A 核心功能卖点与文案库",
    "category": "brief",
    "status": "active",
    "body": "# 核心卖点清单\n..."
  }
  ```

---

## 4. 常见错误代码与处理对策

| 状态码 | 错误类型 | 典型原因 | 处理对策 |
| :--- | :--- | :--- | :--- |
| **400** | `idempotency_key_required` | `POST` 请求头缺少 `Idempotency-Key` | 生成 UUID 填入 Header 后重试 |
| **400** | `invalid_verification` | `verification_status` 为 `verified` 但未传 `verified_at` 或 `verification_evidence` | 补充完整的核验时间和证据文本 |
| **400** | `invalid_time_field` | 时间未采用带有时区的 ISO 8601 格式 | 将时间格式化为 `YYYY-MM-DDTHH:mm:ss+08:00` |
| **401** | `unauthorized` | API Key 缺失或不正确 | 检查 `Authorization: Bearer <KEY>` 是否匹配 |
| **409** | `idempotency_conflict` | 相同的 `Idempotency-Key` 发送了不同的 Payload | 对新操作生成新的 UUID，勿复用旧 Key |
| **409** | `version_conflict` | `PATCH` 时传入的 `version` 与数据库最新版本不一致 | 先 `GET` 该记录获取当前最新 `version`，合流后重试 |
