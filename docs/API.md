# Growth Ops API v1

Base URL：`http://127.0.0.1:8787/api/v1`。除 `/health` 外所有 API 均需 `Authorization: Bearer <key>`。JSON 正文使用 UTF-8 与 `Content-Type: application/json`，单次请求上限 16 MiB（超过返回 413）。实例内密钥拥有所有数据权限；账号筛选并非权限隔离。

机器可读完整契约：`GET /api/v1/openapi.json`；运行契约摘要：`GET /api/v1/meta`。OpenAPI 中服务器地址为 `/`，paths 已含 `/api/v1`，不要重复拼接前缀。

## 资源与基本操作

资源：`platforms / accounts / products / strategies / tasks / actions / contents / metrics / reviews / knowledge / skills / observations`。

| 操作 | 接口 | 返回 |
| --- | --- | --- |
| 查询列表 | `GET /{resource}` | `{items, total, limit, offset}` |
| 读取记录 | `GET /{resource}/{id}` | `{item: record}` |
| 新增记录 | `POST /{resource}` | HTTP 201，`{item: record}` |
| 修改记录 | `PATCH /{resource}/{id}` | HTTP 200，`{item: record}` |
| 策略/Skill 历史 | `GET /strategies/{id}/history` 或 `/skills/{id}/history` | `{items: [...]}` |
| 账号上下文 | `GET /accounts/{id}/context` | 账号、平台、关联产品和各模块近期记录 |
| 动作上下文 | `GET /actions/{id}/context` | 具体策略版本、任务、内容、观测、复盘与后续动作 |
| 执行对账 | `GET /reconciliation` | 有原因、来源记录和分页信息的异常清单 |
| 总览 | `GET /dashboard?account_id=...` | `counts / latest_metrics / recent_work` 等 |
| 导出 | `GET /export` | `schema_version / records / versions` |
| 恢复 | `POST /restore` | `{restored, versions}`，仅空实例 |

所有新增业务记录须带 `Idempotency-Key`。更新须带当前 `version`。不提供硬删除；通过 PATCH 设置 `status: "archived"` 保留记录。列表默认包含归档记录，可指定状态筛选；仪表盘与上下文排除归档。

列表查询参数：`account_id / product_id / status / q / limit / offset / date_from / date_to / time_field`。limit 默认 50、最多 200。保留默认 `time_field=created_at` 的入库时间查询；需要回顾真实运营日期时必须明确选择业务时间。

| 资源 | 可选时间字段 |
| --- | --- |
| 全部 | created_at、updated_at |
| actions | occurred_at，动作发生时间 |
| metrics | observed_at，指标观测时间 |
| tasks / observations | due_at，预期执行或监测时间 |
| reviews | review_period，data.period_start / period_end 覆盖区间 |

时间条件传带时区的完整 ISO 时间，包含边界，按实际时刻比较而非字符串排序。复盘覆盖区间采用交集匹配。反向区间、无效边界及不适用字段返回 400。业务时间字段要求带时区的完整时间；created_at/updated_at 额外兼容旧客户端的 YYYY-MM-DD，按 UTC 当天起点/终点解释，不接受其他无时区时间。选择业务时间且给定范围时，缺少该时间的历史记录不会用 created_at 冒充。未给范围时仍可查询这些历史记录。

示例：`GET /actions?time_field=occurred_at&date_from=2026-09-01T00:00:00Z&date_to=2026-09-07T23:59:59Z`。URL 查询中的 `+08:00` 需 URL 编码为 `%2B08:00`，或直接使用 UTC `Z`。

## 通用记录

```json
{
  "id": "server-generated-id",
  "resource": "actions",
  "title": "一次实际运营动作",
  "account_id": "account-example-x",
  "product_id": null,
  "status": "completed",
  "version": 1,
  "created_at": "2026-09-08T08:00:00Z",
  "updated_at": "2026-09-08T08:00:00Z",
  "data": {}
}
```

客户端新增时传 `title / account_id / product_id / status / data`。`data` 是可扩展对象，用来保存模块专属字段。状态采用自由文本，默认 `active`；建议任务使用 pending/in_progress/completed/failed/cancelled，监测使用 pending/observing/review_due/completed；前端可能按模块提供对应选择项。

PATCH 顶层只更改提供的字段；`data` 按第一层键合并，不做深合并。要清空一个字段，明确传空字符串或 null，不要期待省略字段会删除原值。创建版本为 1，更新后递增；版本冲突返回 409，重新 GET 并合并后再更新。

## 关联与版本

顶层 `account_id` 引用账号，`product_id` 引用产品。`accounts.data.platform_id` 引用平台。`data.task_id / strategy_id / action_id / review_id / parent_action_id / content_id` 引用对应资源，`data.metric_ids` 可引用一组指标；服务器会检查有效引用与归属冲突。关联已归属账号/产品的记录时须携带相同归属。

关联策略时同时存 `strategy_version`，历史版本从 history 获取。其他自由字段如 `metric_ids`、`source_documents`、`client_id`、`execution_id` 可用于 AI 留下证据与执行身份，不能将这些自报字段当作已认证身份。

## 指标快照

```json
{
  "title": "主帖发布后24小时阅读快照",
  "account_id": "account-example-x",
  "data": {
    "action_id": "ACTION_ID",
    "metric_name": "views",
    "value": 100,
    "availability": "valid",
    "metric_type": "cumulative",
    "observed_at": "2026-09-09T16:00:00+08:00",
    "source": "public_post_page"
  }
}
```

- `metric_name`、`metric_type`、带时区的 `observed_at` 为必填。
- `availability=valid` 时 value 必须为有限数值，支持 0。
- `missing / unavailable / not_applicable` 时 value 必须为 null。
- `metric_type` 为 `cumulative` 或 `interval`。
- 保留原始指标名、来源、对象和口径；同一内容累计 100、150 是两次快照，不能相加为 250。
- 仪表盘展示各对象/指标/来源口径的最新观测，不自动跨平台相加，也不自动计算因果归属。

## 完整调用顺序

1. `GET /accounts` 找到账号 ID，然后读取 `/accounts/{id}/context`。初始 ExampleStudio 账号 ID 为 `account-example-x`，接入其他实例时仍应先查询。
2. `POST /strategies` 保存策略，记录返回的 `item.id` 和 `item.version`。
3. `POST /tasks` 写计划，data 中关联 strategy_id 和 strategy_version。
4. 外部 AI 完成用户已授权的真实工作，再 `POST /actions`，关联 task_id 并写执行状态与证据；失败也如实记录。
5. `POST /observations` 写入 due_at、action_id 和观察要求。外部调度负责未来唤醒 AI，本系统不执行调度或抓数。
6. 后续检查后 `POST /metrics` 写入实际快照，PATCH 监测状态。
7. `POST /reviews` 保存 facts、hypothesis、evidence、next_steps 和关联 action_id。证据 ID 或 metric_ids 也可写入 data。
8. `POST /tasks` 生成后续动作计划，通过 review_id 关联本次复盘。执行改进后记录 parent_action_id，形成迭代链。

context 各部分为最多 20 条有界近期信息，不代表全部历史。current_strategy 只选择状态为 active 的账号策略，草稿不会被当作当前策略。历史复盘要对各资源分页查询；平台全局方法可通过 skills/knowledge/strategies 独立查询。

## 重试与错误

错误格式：`{"error":{"code":"...","message":"...","details":...}}`。

- 400：字段、指标或关联不合法，修正后再提交。
- 401：密钥缺失或不正确。
- 403：跨来源写入被拒绝。
- 404：记录不存在。
- 409：版本冲突、幂等键被不同正文复用、重复 ID 或非空库恢复。

新增时为一次逻辑操作生成固定幂等键。相同键和相同正文重试返回原始响应；不要因为网络超时生成新键。外部发帖成功但记录失败时只重试记录，不再发帖。对于外部执行结果未知，先查看平台状态再决定。

`/restore` 是维护操作，不使用普通记录幂等机制；响应不确定时先检查目标记录，不盲目覆盖。测试恢复实例请使用新的目录并设置 `GROWTH_SEED=0`，这样不会初始化种子账号：

```bash
GROWTH_SEED=0 GROWTH_DATA_DIR=/path/to/empty-restore-test python3 server.py --port 8789
```

恢复会校验完整字段、时区、引用以及连续的版本历史；当前记录必须与相同版本历史快照完全一致，失败不会留下部分数据。JSON 导出包含业务数据与版本，不包含 API 密钥和普通请求幂等表。完整 SQLite 备份用于同时保存幂等状态。JSON 恢复后，不应重放恢复前已成功的写入队列。


## v1.1：结果核验与执行对账

动作 `status` 是执行状态，`data.verification_status` 是核验状态，两者分开。外部 AI 负责回查，平台仅校验并记录其声明与证据，不独立验证社交平台。

动作 data 新字段：

| 字段 | 含义 |
| --- | --- |
| occurred_at | 实际发生时间，带时区 ISO；未知道时保持为空 |
| external_id / evidence_url | 外部结果 ID 或证据链接 |
| verification_status | pending、verified、failed、not_applicable |
| verified_at | 核验实际时间，带时区 ISO |
| verification_evidence | 核验依据、回查结果或证据引用 |
| requires_verification | 可选布尔值，明确要求结果核验 |
| review_due_at | 预期复盘时间，带时区 ISO |

publish/post/tweet/reply/repost/quote 类型或 requires_verification=true 作为需要核验的外部动作；普通研究不强制填写整套发布核验信息。新核验为 verified 时需提供 verified_at 与 verification_evidence，外部动作还需 external_id 或 evidence_url。旧记录没有核验字段不等于已经核验。更换已核验动作的外部 ID、证据链接或关联内容时，若没有提供不同实际时刻的新核验及证据，状态会回到 pending，当前核验时间/证据清空，上一份证据保存在 data.previous_verification 供追溯；仅重新勾选 verified 不能复用已失效证据。

使用当前版本 PATCH 写回真实核验：

```json
{
  "version": 1,
  "data": {
    "external_id": "实际外部内容ID",
    "verification_status": "verified",
    "verified_at": "2026-09-08T08:30:00Z",
    "verification_evidence": "回查外部平台，确认内容与计划正文一致；证据另附链接"
  }
}
```

`GET /reconciliation?account_id=...&kind=unverified_action&limit=20&offset=0` 返回：

```json
{
  "items": [],
  "total": 0,
  "limit": 20,
  "offset": 0,
  "counts": {},
  "as_of": "2026-09-08T09:00:00Z"
}
```

每条 item 有 id、kind、resource、record_id、title、account_id、product_id、reason、due_at。支持 account_id、product_id、kind 过滤；counts 为账号/产品范围内各类异常数，不受 kind 筛选影响；items 与 total 受 kind 筛选影响，total 为异常条数，同一动作可能有多条异常。as_of 可指定带时区时间，默认服务器当前时间，用作当前记录的截止判断基准；它不是历史状态回放接口。

| kind | 条件与后续处理 |
| --- | --- |
| overdue_task | 到期而未完成/取消的任务；执行、调整或记录取消原因 |
| missing_evidence | 报告成功的外部动作缺外部凭证；先检查外部结果再补记 |
| unverified_action | 报告成功的外部动作未核验或核验失败；执行回查并记录 |
| overdue_observation | 到期且未完成的监测事项；采集后明确更新状态，一条无关指标不能自动销项 |
| review_due | 动作的复盘时间已到且没有有效关联复盘；分析数据并写回关联复盘 |

取消与归档项排除，未知截止时间不编造逾期。此接口不自动改状态、不产生真实通知、不启动调度，也不调用外部平台。

## v1.1：动作完整上下文

`GET /actions/{id}/context?limit=20&offset=0` 返回：

- action：动作原始记录。
- task、content、parent_action：直接关联记录，没有关联时为 null。
- strategy：动作引用的具体策略版本；strategy_resolution=exact 表示已定位历史版本，current_unpinned 表示旧动作没保存版本、只能提供当前策略，missing 表示无可用策略。不得把 current_unpinned 当成当时执行依据。
- collections：metrics、observations、reviews、follow_up_tasks、follow_up_actions，每项都是 `{items,total,limit,offset}`。同一 limit/offset 分别作用到各集合，total 明确显示是否还有未返回的记录；后续任务关联不会因复盘分页而丢失。

新动作关联 strategy_id 但未给 strategy_version 时，服务器保存当时版本。后续策略升级不改变该动作的执行依据；旧动作未保存版本则如实标注，不能事后自动猜测。

新增时间字段在新建或明确修改时要求合法的带时区 ISO。已有记录中的历史无时区值不会因这次升级自动改写；在业务时间查询/对账时无法解释的时间不被当作确定证据。复盘 period_start 与 period_end 要同时提供，且 start <= end。

### 任务类型与运营对象

任务的运营对象由现有关联确定：有 `product_id` 时显示产品，否则显示 `account_id` 对应账号。该显示逻辑不改变底层关联，不将账号和产品名称写入同一个混合字段。

可选 `data.task_type`：`account_operations`（账号运营）、`content_publishing`（内容发布）、`asset_creation`（素材制作）、`product_preparation`（产品准备）、`analysis_review`（数据复盘）、`strategy_planning`（策略规划）、`other`（其他）。缺省或 null 表示未分类，PATCH null 可清空。任务类型在详情编辑与筛选中保留，不再单独占用列表列。

`GET /api/v1/tasks?task_type=account_operations` 可组合账号、产品、状态和时间条件筛选；`task_type=unclassified` 查询未分类任务。筛选在分页前进行。非法类型返回400。

### 列表默认排序

所有列表在筛选后、分页前按时间倒序，并以记录ID作为相同时间的稳定次序。任务使用 `due_at / planned_on`，动作使用 `occurred_at / occurred_on`，内容使用 `published_at / published_on`，指标使用 `observed_at`，复盘使用 `period_end / period_start`，监测使用 `due_at`；依次取首个有效时间。历史日期按北京时间当天起点比较，不伪造实际时分。上述资源缺少业务时间的记录排在最后；其余资源按 `updated_at` 倒序。`time_field` 控制时间筛选字段，不改变默认排序依据。前端时间列与排序口径一致。

### 下载 Skill

`GET /api/v1/skills/{id}/download` 使用相同 Bearer 鉴权，返回 `application/zip` 附件。ZIP 包包含以 Skill slug 命名的顶层目录，下载名包含记录版本。存在 `data.files` 时使用其中的 `{path,content}` 作为正式包内容（`data.body` 可为合并阅读版）；无 files 时将 body 打包为单文件 SKILL.md。维护多文件包时必须同时更新 files，不能只改合并阅读正文。

包路径只允许唯一的安全相对路径，必须包含非空 SKILL.md；拒绝绝对路径、目录穿越及重复文件。导出只包含记录内的包文件，不读取任意本地路径，不包含账号密钥或数据库。下载无需把平台访问密钥交给接收者；发送ZIP即可。


运营报表接口与统计图口径见 [运营数据展示口径](OPERATIONS-REPORT.md)，默认报表按每日动作和单条内容聚合，原始metrics接口保持不变。
