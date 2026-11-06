# Growth Ops API 接口调用与数据结构规范

Base URL：由操作员环境指定，本地默认为 `http://127.0.0.1:8787/api/v1`。

所有 API 请求均需携带 `Authorization: Bearer <API_KEY>` 请求头，且使用 JSON 格式交互。切勿在 URL 查询参数中传递 API Key。

---

## 1. 基础接口规则

核心资源集合包括：`platforms`、`accounts`、`products`、`strategies`、`tasks`、`actions`、`metrics`、`reviews`、`knowledge`、`skills`、`observations`。

- `GET /RESOURCE`：分页查询列表 `{items, total, limit, offset}`。
  - 常用过滤参数：`account_id`、`product_id`、`status`、`q`、`limit`、`offset`、`time_field`、`date_from`、`date_to`。
  - 时间过滤必须使用带时区的 ISO 8601 字符串（如 `2026-09-10T00:00:00+08:00`）。
  - 可用 `time_field`：`created_at`（默认入库时间）、`occurred_at`（动作真实时间）、`observed_at`（指标观测时间）、`due_at`（截止时间）、`review_period`（复盘周期）。
- `GET /RESOURCE/:id`：读取单条记录 `{item: record}`。
- `POST /RESOURCE`：创建新记录。**必须在 Header 中提供 `Idempotency-Key: <UUID>`**。返回 `{item: record}`。
- `PATCH /RESOURCE/:id`：更新记录。**必须在 Body 中提供当前记录的 `version: <current_version>`**。返回 `{item: record}`。
- `GET /reconciliation?account_id=:id`：运维对账接口，检测未闭环风险（`overdue_task` 超期任务、`missing_evidence` 缺失凭证、`unverified_action` 待核验动作、`overdue_observation` 超期观测、`review_due` 到期复盘）。

---

## 2. 核心资源 Payload 规范

### 2.1 任务规划 (`tasks`)
`POST /api/v1/tasks`（Header 带 `Idempotency-Key: <UUID>`）
```json
{
  "title": "发布 示例产品 A 外食估算对比推文",
  "account_id": "account-example-x",
  "product_id": "hist-products-7ff2bf56144e7962d6a3dd89",
  "status": "planned",
  "data": {
    "task_type": "content_publishing",
    "due_at": "2026-09-11T12:00:00+08:00",
    "acceptance_criteria": "包含两张实际对比截图与体验链接",
    "strategy_id": "strat-x-coldstart",
    "strategy_version": 1
  }
}
```
- `status`：`planned`（待办）、`in_progress`（进行中）、`completed`（已完成）、`blocked`（阻塞）、`cancelled`（已取消）。
- `task_type`：`content_publishing`（发布内容）、`account_operations`（账号运营）、`asset_creation`（素材制作）、`product_preparation`（产品准备）、`analysis_review`（数据分析）、`strategy_planning`（策略规划）。

---

### 2.2 动作事实与核验 (`actions`)
`POST /api/v1/actions`（发布时写入，标记待核验）
```json
{
  "title": "发布 X 讨论推文：外食估算实测",
  "account_id": "account-example-x",
  "product_id": "hist-products-7ff2bf56144e7962d6a3dd89",
  "status": "completed",
  "data": {
    "action_type": "post",
    "occurred_at": "2026-09-10T16:20:00+08:00",
    "task_id": "task-uuid",
    "strategy_id": "strat-x-coldstart",
    "strategy_version": 1,
    "result": "推文已调用 API 发出，等待核验",
    "evidence_url": "https://x.com/example_studio/status/123456789",
    "external_id": "123456789",
    "requires_verification": true,
    "verification_status": "pending",
    "review_due_at": "2026-09-11T16:20:00+08:00"
  }
}
```

核验回读更新（`PATCH /api/v1/actions/:id`）：
```json
{
  "version": 1,
  "data": {
    "verification_status": "verified",
    "verified_at": "2026-09-10T16:25:00+08:00",
    "verification_evidence": "经由公共推文页面回读确认状态码 200，图文与链接展示完整"
  }
}
```
- `verification_status`：`pending`（待核验）、`verified`（已核验）、`failed`（核验失败）、`not_applicable`（不适用）。
- `occurred_at`：必须为动作在外部发生的真实时间，严禁使用入库时间充当动作时间。

---

### 2.3 指标观测 (`metrics`)
`POST /api/v1/metrics`（Header 带 `Idempotency-Key: <UUID>`）
```json
{
  "title": "ExampleStudio 粉丝数快照",
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
- `availability`：`valid`（真实采集值，即使为 0）、`unavailable`（不可获取，`value` 必须设为 `null`）、`missing`（应采未采）、`not_applicable`（不适用）。
- `metric_type`：`cumulative`（累计快照，不能简单叠加）、`interval`（区间增量，需填 `period_start` 和 `period_end`）。

---

### 2.4 归因复盘 (`reviews`)
`POST /api/v1/reviews`（Header 带 `Idempotency-Key: <UUID>`）
```json
{
  "title": "第 2 周冷启动阶段性复盘",
  "account_id": "account-example-x",
  "product_id": "hist-products-7ff2bf56144e7962d6a3dd89",
  "status": "active",
  "data": {
    "period_start": "2026-09-03T00:00:00+08:00",
    "period_end": "2026-09-10T00:00:00+08:00",
    "facts": "共发布推文 14 条，互动 35 次，新增粉丝 42 人",
    "hypothesis": "独立开发者社区对'可验证外食热量估算'关注度高，评测风格互动率更优",
    "evidence": "推文 act-xxxx 互动率达 4.2%，明显高于平均 1.1%",
    "next_steps": "排期实测打卡系列推文，并在下周任务中跟进",
    "action_id": "act-xxxx"
  }
}
```

---

### 2.5 策略与资产作用域 (`strategies`, `knowledge`, `skills`)
`POST /api/v1/strategies`（Header 带 `Idempotency-Key: <UUID>`）
```json
{
  "title": "X 账号高潜博主互动回复策略",
  "status": "active",
  "data": {
    "scope": "platform",
    "platform_id": "platform-x",
    "body": "## 核心准则\n1. 寻找 10k-50k 垂直博主并在 15 分钟内提供有增量信息的回复..."
  }
}
```
- `scope` 选项：
  - `platform`：平台通用策略（需填 `platform_id`）。
  - `account`：当前账号专属策略（需填 `account_id`）。
  - `product`：产品专属策略（需填 `product_id`）。
  - `global`：全局通用资产。

---

### 2.6 产品与资料物料库 (`products`)
产品记录：
```json
{
  "title": "示例产品 A",
  "status": "active",
  "data": {
    "url": "https://example.com/product",
    "positioning": "可检查、可修正的断食营养记录 App",
    "audience": "断食与注重外食营养的用户",
    "account_ids": [
      "account-example-x"
    ]
  }
}
```

产品资料与文案库（`POST /api/v1/products/:product_id/library`）：
```json
{
  "kind": "document",
  "title": "核心卖点清单与竞品差异",
  "category": "brief",
  "status": "active",
  "body": "# 核心卖点\n1. 拍照后输出结构化热量与估算依据..."
}
```

---

## 3. 错误状态码与应对方案

| 状态码 | 错误码 | 原因说明 | 应对措施 |
| :--- | :--- | :--- | :--- |
| **400** | `idempotency_key_required` | POST 请求缺少 `Idempotency-Key` 请求头 | 生成一个唯一 UUID 放入 Header 后重试 |
| **400** | `invalid_verification` | 标记 `verified` 但未提供核验时间和证据 | 补充 `verified_at` 和 `verification_evidence` |
| **400** | `invalid_time_field` | 时间字符串未包含时区信息 | 提供符合 ISO 8601 且带时区的时间（如 `+08:00`） |
| **401** | `unauthorized` | Token 缺失或不匹配 | 检查 Header 是否包含有效的 `Bearer <API_KEY>` |
| **409** | `idempotency_conflict` | 相同的 Key 被用于发送不同的 Payload | 不同的业务操作请生成新的 UUID |
| **409** | `version_conflict` | PATCH 时传入的 `version` 与数据库最新版本不一致 | 先 GET 获取最新版本数据，合流后再重试 |
