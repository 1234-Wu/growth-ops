# Growth Notes · React 前端

使用 React 19、Next.js 静态导出、TypeScript、Tailwind v4 和官方 shadcn/ui Radix 组件。后端仍为上级目录 Python API。

## 构建与运行

```bash
npm ci
npm run typecheck
npm run lint
npm run build
npm start
```

`npm start` 启动上级 Python 服务，在 http://127.0.0.1:8787 同时提供页面和 API。已运行该服务时，构建后刷新浏览器即可，不要重复启动同一个端口。

构建使用 Webpack，避开当前运行环境对 Turbopack 子进程本地端口的限制。构建不依赖远程字体下载。`npm run dev` 是 Next 自带的独立 UI 开发服务，不包含 Python API 代理；完整业务联调使用构建后的 8787 同源入口。

- `components/ui/`：shadcn CLI 生成的实际组件源文件。
- `components/workspace.tsx`：登录、导航、仪表盘、对账、设置。
- `components/resource-page.tsx`：共享资源列表、筛选、编辑抽屉、上下文和版本历史。
- `lib/`：API、类型及资源字段定义。
- `app/[module]/page.tsx`：15 个独立页面静态出口。

主数据库和密钥不进入前端代码；浏览器仅在当前会话保存用户输入的密钥。错误密钥不会进入工作台。
