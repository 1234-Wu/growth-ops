# React + shadcn/ui 前端迁移

用户明确选择 React 与 shadcn/ui。复用现有 web/ Next.js + TypeScript + Tailwind v4 工程，通过官方 CLI 添加 shadcn 组件。Python API、数据结构和本地密钥保持不变，不部署服务器。

实施：先保留原 static/ 可回退；新客户端负责验证密钥、独立页面路由、摘要仪表盘、列表/筛选、详情编辑抽屉、核验/历史/上下文、对账与设置导出。JSON和版本号收进高级区域；禁止添加虚构运营数据或伪趋势。静态导出构建完成后由原 Python 服务提供资源，浏览器仍使用 localhost:8787。

验证：TypeScript、ESLint、构建、现有27后端测试；真实浏览器验证错误/正确密钥、新建与编辑、筛选、对账、核验、版本、导出、桌面/移动端及路由刷新。测试在独立数据库运行，正式数据库升级前后摘要不变。


实现结果：官方 shadcn CLI（radix-nova）生成实际组件，React资源页保留全部12类记录；15个独立页面及登录使用统一样式。状态筛选、业务时间、核验证据、精确策略上下文、历史版本、导出和未保存草稿保护保留。密钥不出现在顶部导航，技术字段收在高级区；指标趋势只基于同一对象/来源/口径的真实快照。

验证：TypeScript、ESLint、Webpack 静态构建通过；27项原API测试通过；tests/react-browser.cjs 使用隔离数据库通过实际登录/创建/编辑/核验/导出/15路由/手机导航和Sheet测试。没有向正式库导入演示记录。

参考：[shadcn 官方安装文档](https://ui.shadcn.com/docs/installation/next)、[Next.js 静态导出说明](https://nextjs.org/docs/app/guides/static-exports)。
