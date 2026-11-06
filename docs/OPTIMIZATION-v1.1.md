# v1.1 执行可靠性优化

范围：结果核验、异常对账、业务时间筛选、动作上下文。保留现有资源和接口，默认日期筛选仍使用 created_at；不调用 AI、不采集社交平台、不创建定时发布或通知。

## 接口契约

- 动作 data 增加 `occurred_at`、`external_id`、`verification_status`（pending/verified/failed/not_applicable）、`verified_at`、`verification_evidence`、`requires_verification`（bool）、`review_due_at`。证据链接沿用 `evidence_url`。旧记录缺核验字段不自动标为已核验。
- 外部动作类型 publish/post/tweet/reply/repost/quote 或 requires_verification=true 需要核验；普通研究等可不适用。成功执行状态 completed/done/success 不等于核验通过。verified 必须有带时区 verified_at 和非空 verification_evidence，外部动作还需 external_id 或 evidence_url。核验只是外部AI提交的有证据声明，系统不自行回查。
- `GET /reconciliation?account_id=&product_id=&kind=&as_of=&limit=&offset=`：返回 `{items,total,limit,offset,counts,as_of}`。item 至少含 `{id,kind,resource,record_id,title,account_id,product_id,reason,due_at}`。kind 为 overdue_task / missing_evidence / unverified_action / overdue_observation / review_due。结果只读、实时计算，不自动修改状态。
- 对账规则：未完成且到期任务；成功外部动作缺外部凭证；成功外部动作未核验或核验失败；未完成且到期监测（提示未完成，不能仅凭一条无关指标销项）；动作 review_due_at 到期且无引用该动作的有效复盘。取消和归档记录排除。未知到期时间不编造逾期。as_of 默认为服务器现在，可显式给带时区ISO用于可重现实验。
- 列表增加 `time_field`，支持 created_at/updated_at（全部）、occurred_at（actions）、observed_at（metrics）、due_at（tasks/observations）、review_period（reviews，period_start/period_end区间交集）。date_from/date_to 为带时区 ISO、包含边界，按实际时间比较；缺业务时间的记录不会用入库时间冒充。没有时间范围时不排除历史缺字段记录。
- `GET /actions/{id}/context?limit=&offset=`：返回 action、task、strategy（保存的 strategy_version 对应历史版本）、strategy_resolution（exact/current_unpinned/missing）、content、parent_action、metrics、observations、reviews、follow_up_tasks、follow_up_actions，以及每个集合的total/limit/offset元数据。上下文限额透明，可分页。直接关联与复盘/指标引用保持类型与归属边界，不猜测关系。
- 时间字段只在新建/被修改时校验，不阻断未修改旧记录中的历史无时区数据。复盘起止要同时存在、顺序正确。新关联strategy_id记录策略版本，历史未保存版本的记录标注current_unpinned，不冒充历史精确版本。

## 页面

新增独立“执行对账”页面，账号/产品/异常类型过滤、分页、空态和跳转到来源记录；动作详情提供核验字段与关联上下文；任务、动作、数据、监测、复盘列表提供业务时间筛选；不把操作模块混入仪表盘。

## 验收

基线21测试；新增时间差异、跨时区边界、缺业务时间、复盘范围交集、验证状态字段、防误报对账、账号隔离、闭环消项、策略版本锁定及上下文分页测试。浏览器实测异常记录出现→补核验→消项，业务时间筛选与上下文链接。使用临时数据库验证；升级正式本地服务前先SQLite一致性备份，正式数据不写测试样例。
