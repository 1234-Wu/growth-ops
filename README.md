# Growth Ops · 运营记录台

供外部 AI 使用的运营记事本和数据库。AI 负责思考、执行和复盘；系统提供持久化 API、独立模块页面和关键数据仪表盘，不内置模型能力。

## 启动

后端使用 Python 3.10+；新版前端使用 React 19、Next.js、TypeScript、Tailwind CSS 和官方 shadcn/ui（Radix）组件。构建前端需要 Node.js 20.19+ 与 npm。构建完成后，日常运行只需要 Python 服务。

首次获取源码或修改前端后先构建：

```bash
cd growth-ops/web
npm ci
npm run build
cd ..
python3 server.py
```

当前工作区支持**热加载一键启动**：
- **方式一（双击启动）**：macOS 直接双击 `start.command`，自动一键启动【前后端热加载开发版】。
- **方式二（终端运行）**：
  - `python3 start.py`：**默认热加载开发版**（同时拉起 Python API 8787 与 Next.js 3000 热更新，修改 React/CSS 实时生效）。
  - `python3 start.py --prod`：单 Python 进程静态生产版（轻量直接托管 `web/out`）。

启动后将自动检测端口、将访问密钥复制到系统剪贴板，并在默认浏览器中自动打开并登录本地工作台。若服务已在后台运行，再次点击也会直接唤起浏览器进入工作台。关闭终端窗口或按 `Ctrl+C` 即可同时优雅停止所有服务。

访问密钥保存在 `data/api-key`。一键启动时会自动完成会话认证，退出网页后密钥清除。密钥持有人可以读写整个实例，不要将该文件提交到仓库。

首次启动会添加 X 平台和一个示例账号。设置 `GROWTH_SEED=0` 可从空库开始。

## 页面

- 仪表盘：关键记录量、待办与最新指标，点击进入明细。
- 任务管理：计划、验收标准、执行状态与关联记录。
- 动作记录：实际行为、发生时间、外部凭证与独立核验状态；详情可查看关联策略版本、数据、复盘与后续动作。
- 内容管理：文案、发布实例与素材引用。
- 监测中心：待采集/待复盘事项与到期时间，由外部 AI 负责后续采集。
- 执行对账：集中查看逾期任务、缺凭证、未核验动作及到期未完成的监测/复盘，可跳转处理。
- 数据管理：带时间和来源的指标快照，区分零与缺失。
- 策略、复盘、知识、Skills：各自独立页面，保存正文与结构化信息。
- 平台、账号、产品：新增渠道与运营对象。
- 设置与接入：API 接入信息、导出与退出。

## 接入外部 AI

将 `skills/growth-ops-recorder/` 交给你的 AI，提供 API 地址和密钥。Skill 不会自动安装到全局，也不授权 AI 进行外部发布。

- 默认 Base URL：`http://127.0.0.1:8787/api/v1`
- 认证：`Authorization: Bearer <your-key>`
- 机器可读契约：`GET /api/v1/openapi.json`
- 账号上下文：`GET /api/v1/accounts/{id}/context`
- 动作上下文：`GET /api/v1/actions/{id}/context`
- 执行对账：`GET /api/v1/reconciliation`
- 详细说明：[API 文档](docs/API.md)
- 设计边界：[架构说明](docs/ARCHITECTURE.md)

附带无需依赖的客户端，从环境变量 `GROWTH_API_KEY` 或本地 `data/api-key` 读取密钥：

```bash
python3 scripts/client.py GET accounts
python3 scripts/client.py GET accounts/ACCOUNT_ID/context
python3 scripts/client.py POST actions --body-file action.json --idempotency-key retained-operation-id
```

创建动作、指标或复盘前保存幂等键；遇到不确定响应，重试同一键和同一正文。更新记录需带 GET 返回的 `version`，冲突后先重新读取。

## v1.1 业务时间与核验

新增业务时间筛选：动作按 occurred_at、指标按 observed_at、任务/监测按 due_at、复盘按 period_start/period_end 范围。默认仍按 created_at 查询，旧客户端保持兼容。未知历史时间不会被补成入库时间。

执行完成与核验通过分开。外部 AI 回查后写回 verified_at、verification_evidence 及外部凭证；系统不主动抓取平台验证。“执行对账”只读计算异常，不负责后台唤醒或通知。

## 配置

使用 `GROWTH_API_KEY` 可以指定密钥，`GROWTH_DATA_DIR` 指定独立数据目录。接口默认只对本机开放。首版只有一个工作空间和管理密钥，不提供多租户、成员权限或不同 AI 的权限分级。

远程 AI 无法通过它自己的 `127.0.0.1` 访问你的电脑。需要先部署到双方可访问的可信地址，再将实际 URL 交给 AI；公网部署还需 HTTPS 与访问控制。本次交付为本地运行版，未发布到公网。

## 验证

```bash
python3 -m unittest discover -s tests -v
python3 -m compileall -q server.py scripts tests
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web run build
```

React 构建输出位于 `web/out/`，由 Python 在同一端口提供，API 地址保持 `/api/v1`。浏览器端验证使用 `node tests/react-browser.cjs`（开发环境需已有 Playwright 和 Chrome）。旧 `static/` 保留供回退，可用 `GROWTH_LEGACY_UI=1` 启动旧界面；旧版浏览器测试仅适用于旧界面。

## 备份与恢复

网页和 `GET /api/v1/export` 提供 JSON 导出，恢复接口为 `POST /api/v1/restore`，只允许向空业务数据库恢复并在事务中验证；恢复实例启动时需设置 `GROWTH_SEED=0` 关闭种子数据。生产数据恢复前请在新数据目录演练。

原始 SQLite 完整备份可以使用 `scripts/backup.py`，它通过 SQLite 的备份接口生成一致性快照，包含历史和幂等信息；不要只复制运行中数据库的主文件而忽略 WAL。

```bash
python3 scripts/backup.py --output /path/to/backup.sqlite3
```

备份不包含密钥及外部附件。附件首版以链接、路径引用保存，并不上传二进制文件。停服后将已验证的备份替换数据库文件可恢复，恢复前保留旧数据目录副本。

### 前端开发与热更新

保留 Python 后端 `GROWTH_ALLOWED_ORIGINS=http://127.0.0.1:3000 python3 server.py`（127.0.0.1:8787），另开终端在项目目录运行 `npm --prefix web run dev`，浏览器访问 http://127.0.0.1:3000 。React/CSS 保存后通过 Next.js Fast Refresh 更新；`/api/*` 转发至原后端，继续使用同一数据库和访问密钥。不同端口的浏览器会话独立，首次打开3000需登录一次。

8787提供的是 `web/out` 静态构建，没有热更新；生产预览仍用 `npm --prefix web run build` 后访问8787。开发缓存使用 `.next-dev`，与生产构建 `.next` 隔离。Python代码修改仍需重启后端。

产品管理现在包含推广文档与素材库，使用和AI接口见 [产品推广知识库](docs/PRODUCT-LIBRARY.md)。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。第三方代码见 [版权声明](THIRD_PARTY_NOTICES)。
