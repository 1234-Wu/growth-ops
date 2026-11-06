(function () {
  "use strict";

  const API_BASE = "/api/v1";
  const PAGE_SIZE = 20;
  const storage = window.sessionStorage;

  function extractUrlKey() {
    try {
      const url = new URL(window.location.href);
      const key = url.searchParams.get("key");
      if (key) {
        url.searchParams.delete("key");
        window.history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
        return key.trim();
      }
    } catch (e) {}
    return "";
  }
  const initialUrlKey = extractUrlKey();

  const state = {
    route: "dashboard",
    token: initialUrlKey || storage.getItem("growthOpsApiKey") || "",
    authenticated: false,
    authAttempt: 0,
    loginBusy: false,
    loginMessage: "",
    accountId: storage.getItem("growthOpsAccountId") || "",
    navOpen: false,
    refs: {
      accounts: [],
      products: [],
      platforms: [],
      tasks: [],
      actions: [],
      contents: [],
      strategies: [],
      reviews: []
    },
    lists: {},
    details: {},
    history: {},
    actionContexts: {},
    drafts: {},
    focus: null,
    skipDraftCapture: false,
    createKeys: {},
    dashboard: null,
    loading: false,
    error: "",
    toast: ""
  };

  const resources = {
    dashboard: {
      title: "仪表盘",
      note: "从每一次行动中积累证据，让下一次决策有据可依。",
      icon: "gauge"
    },
    reconciliation: {
      title: "执行对账",
      note: "检查逾期任务、缺证据动作、未核验动作、逾期监测和待复盘事项。",
      icon: "alert"
    },
    tasks: {
      title: "运营任务",
      note: "AI 规划出的任务池，记录验收标准、截止时间、状态和关联账号产品。",
      singular: "任务",
      icon: "check",
      defaultStatus: "planned",
      fields: [
        { key: "acceptance_criteria", label: "验收标准", type: "textarea", data: true },
        { key: "due_at", label: "截止时间", type: "datetime-local", data: true },
        { key: "review_id", label: "来源复盘", type: "select", ref: "reviews", data: true }
      ]
    },
    actions: {
      title: "运营动作",
      note: "记录 AI 或人工已经执行、尝试、失败或未知的动作；回查由外部 AI 执行，平台保存核验结果与证据。",
      singular: "动作",
      icon: "bolt",
      defaultStatus: "completed",
      fields: [
        { key: "action_type", label: "动作类型", data: true },
        { key: "occurred_at", label: "实际发生时间", type: "datetime-local", data: true },
        { key: "external_id", label: "外部 ID", data: true },
        { key: "evidence_url", label: "证据链接", type: "url", data: true },
        { key: "verification_status", label: "核验状态", type: "select-options", options: ["", "pending", "verified", "failed", "not_applicable"], data: true },
        { key: "verified_at", label: "核验时间", type: "datetime-local", data: true },
        { key: "verification_evidence", label: "核验证据", type: "textarea", data: true },
        { key: "requires_verification", label: "需要核验", type: "checkbox", data: true },
        { key: "review_due_at", label: "复盘截止", type: "datetime-local", data: true },
        { key: "task_id", label: "关联任务", type: "select", ref: "tasks", data: true },
        { key: "strategy_id", label: "关联策略", type: "select", ref: "strategies", data: true },
        { key: "content_id", label: "关联内容", type: "select", ref: "contents", data: true },
        { key: "parent_action_id", label: "父动作", type: "select", ref: "actions", data: true }
      ]
    },
    contents: {
      title: "内容素材",
      note: "保存帖子正文、选题、草稿、发布 URL 和内容证据。",
      singular: "内容",
      icon: "file",
      defaultStatus: "draft",
      fields: [
        { key: "body", label: "正文", type: "textarea", data: true },
        { key: "url", label: "URL", type: "url", data: true }
      ]
    },
    observations: {
      title: "监测事项",
      note: "动作后的监测提醒，帮助形成动作到数据到复盘的闭环。",
      singular: "监测",
      icon: "eye",
      defaultStatus: "pending",
      fields: [
        { key: "due_at", label: "监测时间", type: "datetime-local", data: true },
        { key: "action_id", label: "关联动作", type: "select", ref: "actions", data: true }
      ]
    },
    metrics: {
      title: "运营数据",
      note: "存储任意指标快照，支持累计值与区间值，缺失值会明确标注。",
      singular: "指标",
      icon: "chart",
      defaultStatus: "active",
      fields: [
        { key: "metric_name", label: "指标名", data: true },
        { key: "value", label: "值", type: "number", data: true },
        { key: "availability", label: "可用性", type: "select-options", options: ["valid", "missing", "unavailable", "not_applicable"], data: true },
        { key: "observed_at", label: "观测时间", type: "datetime-local", data: true },
        { key: "metric_type", label: "指标类型", type: "select-options", options: ["cumulative", "interval"], data: true },
        { key: "action_id", label: "关联动作", type: "select", ref: "actions", data: true },
        { key: "source", label: "来源", data: true }
      ]
    },
    strategies: {
      title: "策略版本",
      note: "每个账号或产品的策略快照。正文是纯文本 Markdown，版本号用于复盘引用。",
      singular: "策略",
      icon: "compass",
      defaultStatus: "active",
      versioned: true,
      fields: [{ key: "body", label: "Markdown 正文", type: "textarea", data: true }]
    },
    reviews: {
      title: "复盘归因",
      note: "把事实、假设、证据和下一步动作分开写，避免把结论和猜测混在一起。",
      singular: "复盘",
      icon: "loop",
      defaultStatus: "active",
      fields: [
        { key: "facts", label: "事实", type: "textarea", data: true },
        { key: "hypothesis", label: "归因假设", type: "textarea", data: true },
        { key: "evidence", label: "证据 ID / 链接", type: "textarea", data: true },
        { key: "next_steps", label: "下一步动作", type: "textarea", data: true },
        { key: "period_start", label: "复盘周期开始", type: "datetime-local", data: true },
        { key: "period_end", label: "复盘周期结束", type: "datetime-local", data: true },
        { key: "action_id", label: "关联动作", type: "select", ref: "actions", data: true }
      ]
    },
    knowledge: {
      title: "知识库",
      note: "沉淀可复用经验、素材判断、平台规则和运营原则。",
      singular: "知识",
      icon: "book",
      defaultStatus: "active",
      fields: [{ key: "body", label: "正文", type: "textarea", data: true }]
    },
    skills: {
      title: "Skills",
      note: "给外部 AI 使用的操作说明、检查清单和工作流提示，正文为纯文本 Markdown。",
      singular: "Skill",
      icon: "spark",
      defaultStatus: "active",
      versioned: true,
      fields: [{ key: "body", label: "Markdown 正文", type: "textarea", data: true }]
    },
    accounts: {
      title: "账号",
      note: "管理平台账号。初始可以只建一个 X/Twitter 账号，后续可扩展到小红书等平台。",
      singular: "账号",
      icon: "user",
      defaultStatus: "active",
      fields: [
        { key: "platform_id", label: "平台", type: "select", ref: "platforms", data: true },
        { key: "handle", label: "Handle", data: true },
        { key: "url", label: "主页 URL", type: "url", data: true }
      ],
      noAccountFilter: true
    },
    products: {
      title: "产品",
      note: "同一产品可以被多个账号推广，同一账号也可以关联多个产品。",
      singular: "产品",
      icon: "box",
      defaultStatus: "active",
      fields: [{ key: "url", label: "产品 URL", type: "url", data: true }],
      noAccountFilter: true
    },
    platforms: {
      title: "平台",
      note: "统一维护 X/Twitter、小红书等平台定义，账号通过平台关联。",
      singular: "平台",
      icon: "layers",
      defaultStatus: "active",
      fields: [
        { key: "code", label: "平台代码", data: true },
        { key: "url", label: "平台官网", type: "url", data: true }
      ],
      noAccountFilter: true
    },
    settings: {
      title: "设置",
      note: "配置本地 API Key、查看接口契约、导出当前可读取数据。",
      icon: "settings"
    }
  };

  const listRoutes = Object.keys(resources).filter((key) => resources[key].singular);
  const refRoutes = ["accounts", "products", "platforms", "tasks", "actions", "strategies", "reviews", "contents"];
  const statuses = [
    "",
    "active",
    "planned",
    "in_progress",
    "pending",
    "observing",
    "review_due",
    "completed",
    "success",
    "failed",
    "blocked",
    "cancelled",
    "done",
    "draft",
    "archived"
  ];

  function normalizeRoute() {
    const hashValue = String(location.hash || "").replace(/^#\/?/, "").split("/")[0];
    const pathValue = String(location.pathname || "").replace(/^\/+/, "").split("/")[0];
    const value = hashValue || (pathValue === "index.html" ? "" : pathValue) || "dashboard";
    return resources[value] ? value : "dashboard";
  }

  function apiHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    return headers;
  }

  async function api(path, options = {}) {
    const requestToken = state.token;
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: { ...apiHeaders(), ...(options.headers || {}) }
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new Error(`接口返回不是 JSON：${response.status}`);
      }
    }
    if (response.status === 401) {
      const message = "密钥无效或已失效，请重新输入完整的访问密钥。";
      if (requestToken === state.token) clearAuthentication(message);
      throw new Error(message);
    }
    if (!response.ok) {
      const message = payload && (payload.error?.message || payload.message || payload.detail || payload.error);
      throw new Error(errorText(message || `接口请求失败：${response.status}`));
    }
    return payload;
  }

  function errorText(value) {
    if (value === undefined || value === null || value === "") return "未知错误";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }

  function buildQuery(params) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") query.set(key, value);
    });
    const text = query.toString();
    return text ? `?${text}` : "";
  }

  function el(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(options).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    });
    const childList = Array.isArray(children) ? children : [children];
    childList.forEach((child) => {
      if (child === undefined || child === null || child === false) return;
      if (child instanceof Node) node.append(child);
      else node.append(document.createTextNode(typeof child === "object" ? errorText(child) : String(child)));
    });
    return node;
  }

  function icon(name) {
    const paths = {
      gauge: '<path d="M4 13a8 8 0 0 1 16 0"/><path d="m12 13 4-5"/><path d="M7 17h10"/>',
      check: '<path d="m4 12 5 5L20 6"/>',
      bolt: '<path d="m13 2-9 12h7l-1 8 9-12h-7l1-8z"/>',
      file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
      eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
      chart: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M12 16V8"/><path d="M16 16v-2"/>',
      compass: '<circle cx="12" cy="12" r="9"/><path d="m15 9-2 6-6 2 2-6 6-2z"/>',
      loop: '<path d="M17 1v6h-6"/><path d="M7 23v-6h6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L4 7"/><path d="M3.51 15a9 9 0 0 0 14.85 3.36L20 17"/>',
      book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
      spark: '<path d="M12 2v5"/><path d="M12 17v5"/><path d="M4.22 4.22l3.54 3.54"/><path d="m16.24 16.24 3.54 3.54"/><path d="M2 12h5"/><path d="M17 12h5"/><path d="m4.22 19.78 3.54-3.54"/><path d="m16.24 7.76 3.54-3.54"/>',
      user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/>',
      box: '<path d="m21 8-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
      layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.3l.06.06A1.65 1.65 0 0 0 8.92 4a1.65 1.65 0 0 0 1-1.51V2.4a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z"/>',
      alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
      menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
      plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
      save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
      logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'
    };
    return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.file}</svg>`;
  }

  function renderShell() {
    const preserveUi = !state.skipDraftCapture;
    if (preserveUi) captureUiState();
    state.skipDraftCapture = false;
    const app = document.getElementById("app");
    app.innerHTML = "";
    if (!state.authenticated) {
      app.className = "login-shell";
      app.append(renderLogin());
      return;
    }
    app.className = `shell${state.navOpen ? " nav-open" : ""}`;
    app.append(renderSidebar(), renderContent());
    if (preserveUi) restoreUiState();
  }

  function renderLogin() {
    const input = el("input", {
      class: "input login-input",
      id: "login-token",
      type: "password",
      autocomplete: "off",
      placeholder: "粘贴密钥文件中的完整内容",
      disabled: state.loginBusy ? "disabled" : null,
      "aria-label": "API Key"
    });
    const form = el("form", { class: "login-card" }, [
      el("div", { class: "brand-mark", html: icon("loop") }),
      el("div", { class: "page-title" }, [
        el("h2", { text: "增长运营平台" }),
        el("p", { text: "验证访问密钥后进入工作台。请复制本地 data/api-key 文件中的完整内容，不是文件路径。" })
      ]),
      el("div", { class: "field" }, [el("label", { for: "login-token", text: "API Key" }), input]),
      el("button", { class: "btn primary login-button", type: "submit", disabled: state.loginBusy ? "disabled" : null, text: state.loginBusy ? "正在验证…" : "进入工作台" }),
      state.loginMessage ? el("div", { class: "error-text", role: "alert", text: state.loginMessage }) : null
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveToken(input.value);
    });
    return el("main", { class: "login-page", id: "main" }, [form]);
  }

  function renderSidebar() {
    const navItems = [
      "dashboard",
      "reconciliation",
      "tasks",
      "actions",
      "contents",
      "observations",
      "metrics",
      "strategies",
      "reviews",
      "knowledge",
      "skills",
      "accounts",
      "products",
      "platforms",
      "settings"
    ];
    const sidebar = el("aside", { class: "sidebar", "aria-label": "主导航" });
    sidebar.append(
      el("div", { class: "brand" }, [
        el("div", { class: "brand-mark", html: icon("loop") }),
        el("h1", { text: "增长运营平台" }),
        el("p", { text: "动作 记录 监测 复盘 优化" })
      ])
    );
    const nav = el("nav", { class: "nav" });
    navItems.forEach((key) => {
      const link = el("a", { href: `/${key}`, dataset: { route: key } });
      if (state.route === key) link.setAttribute("aria-current", "page");
      link.innerHTML = icon(resources[key].icon);
      link.append(document.createTextNode(resources[key].title));
      nav.append(link);
    });
    sidebar.append(nav);
    return sidebar;
  }

  function renderContent() {
    const content = el("div", { class: "content" });
    content.append(renderTopbar());
    const main = el("main", { id: "main", class: "main", tabindex: "-1" });
    const config = resources[state.route];
    main.append(renderPageHead(config));
    if (state.route === "dashboard") main.append(renderDashboard());
    else if (state.route === "reconciliation") main.append(renderReconciliation());
    else if (state.route === "settings") main.append(renderSettings());
    else main.append(renderResourcePage(state.route));
    content.append(main);
    if (state.toast) content.append(el("div", { class: "toast", role: "status", text: state.toast }));
    return content;
  }

  function renderTopbar() {
    const topbar = el("header", { class: "topbar" });
    const menu = el("button", {
      class: "icon-btn menu-toggle",
      type: "button",
      "aria-label": "打开导航",
      onclick: () => {
        state.navOpen = !state.navOpen;
        renderShell();
      }
    });
    menu.innerHTML = icon("menu");

    const accountWrap = el("div", { class: "account-filter" }, [
      el("label", { for: "global-account", text: "账号筛选" }),
      renderSelect("global-account", state.accountId, accountOptions(true), (value) => {
        state.accountId = value;
        storage.setItem("growthOpsAccountId", value);
        refreshCurrent();
      })
    ]);

    const tokenInput = el("input", {
      class: "input",
      id: "token-input",
      type: "password",
      autocomplete: "off",
      placeholder: "粘贴 API Key",
      value: state.token,
      "aria-label": "API Key"
    });
    tokenInput.addEventListener("change", () => saveToken(tokenInput.value));
    tokenInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") saveToken(tokenInput.value);
    });

    const logout = el("button", {
      class: "icon-btn",
      type: "button",
      title: "退出",
      "aria-label": "退出",
      onclick: () => {
        clearAuthentication("已退出工作台。");
      }
    });
    logout.innerHTML = icon("logout");

    const tokenArea = el("div", { class: "token-area" }, [
      el("span", { class: "token-state", text: state.authenticated ? "已接入" : "未接入" }),
      tokenInput,
      logout
    ]);
    topbar.append(menu, accountWrap, tokenArea);
    return topbar;
  }

  function renderPageHead(config) {
    const head = el("section", { class: "page-head" });
    head.append(
      el("div", { class: "page-title" }, [
        el("h2", { text: config.title }),
        el("p", { text: config.note || "" })
      ])
    );
    if (listRoutes.includes(state.route)) {
      const button = el("button", {
        class: "btn primary",
        type: "button",
        onclick: () => {
          state.details[state.route] = null;
          const list = getListState(state.route);
          list.mode = "create";
          renderShell();
        }
      });
      button.innerHTML = icon("plus");
      button.append(document.createTextNode(`新建${config.singular}`));
      head.append(button);
    }
    return head;
  }

  function renderDashboard() {
    const wrap = el("section", { class: "dashboard-grid" });
    if (state.loading) return el("div", { class: "panel loading", text: "正在读取仪表盘..." });
    if (state.error) return el("div", { class: "panel error-box", text: state.error });
    if (!state.dashboard) return el("div", { class: "panel empty", text: "后端暂未返回仪表盘数据。" });

    const counts = state.dashboard.counts && typeof state.dashboard.counts === "object" ? state.dashboard.counts : {};
    const summary = [
      {label: "已记录动作", value: counts.actions ?? 0, target_route: "actions", hint: "执行事实与证据"},
      {label: "指标快照", value: counts.metrics ?? 0, target_route: "metrics", hint: "独立观测，不累计相加"},
      {label: "复盘积累", value: counts.reviews ?? 0, target_route: "reviews", hint: "结论与下一步行动"},
      {label: "监测事项", value: counts.observations ?? 0, target_route: "observations", hint: "观察计划与进展"}
    ];
    const latestMetrics = Array.isArray(state.dashboard.latest_metrics) ? state.dashboard.latest_metrics : [];
    const pending = Array.isArray(state.dashboard.recent_work) ? state.dashboard.recent_work : [];

    if (!summary.length && !latestMetrics.length && !pending.length) {
      return el("div", { class: "panel empty", text: "当前筛选下没有关键数据。" });
    }

    summary.forEach((item) => {
      const tile = el("article", { class: "metric-tile" });
      const target = item.target_route && resources[item.target_route] ? item.target_route : "metrics";
      tile.append(
        el("a", { href: `/${target}`, dataset: { route: target } }, [
          el("div", { class: "metric-label", text: safeValue(item.label, "未命名指标") }),
          el("div", { class: "metric-value", text: metricValue(item.value) }),
          el("div", { class: "metric-sub", text: safeValue(item.hint || item.delta, "无补充说明") })
        ])
      );
      wrap.append(tile);
    });

    wrap.append(
      renderCompactPanel("最新指标", latestMetrics, "metrics", (item) => [
        safeValue(item.data?.metric_name || item.title, "未命名指标"),
        `${metricValue(item.data?.value)} · ${safeValue(item.data?.observed_at || item.updated_at, "时间缺失")}`,
        ({valid:"已观测",missing:"未采集",unavailable:"不可获取",not_applicable:"不适用"}[item.data?.availability] || "未标注来源状态")
      ]),
      renderCompactPanel("近期工作", pending, "tasks", (item) => [
        safeValue(item.title, "未命名事项"),
        safeValue(item.status, "状态缺失"),
        safeValue(item.due_at || item.updated_at, "时间缺失")
      ])
    );
    return wrap;
  }

  function renderCompactPanel(title, items, route, mapper) {
    const panel = el("section", { class: "panel dashboard-section" }, [el("h3", { text: title })]);
    const list = el("div", { class: "compact-list" });
    if (!items.length) {
      list.append(el("div", { class: "empty", text: "暂无数据" }));
    } else {
      items.slice(0, 8).forEach((item) => {
        const values = mapper(item);
        list.append(
          el("a", { class: "compact-item", href: `/${resources[item.resource] ? item.resource : route}`, dataset: { route: resources[item.resource] ? item.resource : route, recordId: item.id } }, [
            el("div", { class: "compact-title", text: values[0] }),
            el("div", { class: "compact-meta", text: values.slice(1).join(" · ") })
          ])
        );
      });
    }
    panel.append(list);
    return panel;
  }

  function renderReconciliation() {
    const list = getReconciliationState();
    const section = el("section", { class: "workspace single" });
    const panel = el("div", { class: "resource-list" });
    panel.append(renderReconciliationToolbar(list));
    if (list.loading) panel.append(el("div", { class: "table-wrap loading", text: "正在读取对账结果..." }));
    else if (list.error) panel.append(el("div", { class: "table-wrap error-box", text: list.error }));
    else panel.append(renderReconciliationTable(list));
    section.append(panel);
    return section;
  }

  function renderReconciliationToolbar(list) {
    const product = renderSelect("reconciliation-product", list.productId, reconciliationProductOptions(), (value) => {
      list.productId = value;
      list.offset = 0;
      loadReconciliation();
    });
    const kinds = [
      { value: "", label: "全部异常" },
      { value: "overdue_task", label: "逾期任务" },
      { value: "missing_evidence", label: "缺外部凭证" },
      { value: "unverified_action", label: "未核验动作" },
      { value: "overdue_observation", label: "逾期监测" },
      { value: "review_due", label: "待复盘" }
    ];
    const kind = renderSelect("reconciliation-kind", list.kind, kinds, (value) => {
      list.kind = value;
      list.offset = 0;
      loadReconciliation();
    });
    const counts = list.counts || {};
    return el("div", { class: "toolbar panel" }, [
      el("div", { class: "filter-row" }, [
        el("div", { class: "field inline" }, [el("label", { for: "reconciliation-product", text: "产品" }), product]),
        el("div", { class: "field inline" }, [el("label", { for: "reconciliation-kind", text: "异常类型" }), kind])
      ]),
      el("div", { class: "count-strip" }, [
        countPill("逾期任务", counts.overdue_task),
        countPill("缺凭证", counts.missing_evidence),
        countPill("未核验", counts.unverified_action),
        countPill("逾期监测", counts.overdue_observation),
        countPill("待复盘", counts.review_due)
      ])
    ]);
  }

  function countPill(label, value) {
    return el("span", { class: "count-pill", text: `${label} ${Number(value || 0)}` });
  }

  function renderReconciliationTable(list) {
    const wrap = el("div", { class: "table-wrap" });
    if (!list.items.length) {
      wrap.append(el("div", { class: "empty", text: "当前筛选下没有需要处理的异常。" }));
      return wrap;
    }
    const table = el("table", { class: "reconciliation-table" });
    table.append(el("thead", {}, [el("tr", {}, ["异常", "来源", "标题", "到期时间", "原因"].map((text) => el("th", { text })))]));
    const body = el("tbody");
    list.items.forEach((item) => {
      const route = resources[item.resource] ? item.resource : "actions";
      const row = el("tr", {
        class: "clickable",
        tabindex: "0",
        onclick: () => goRoute(route, item.record_id),
        onkeydown: (event) => {
          if (event.key === "Enter" || event.key === " ") goRoute(route, item.record_id);
        }
      });
      row.append(
        el("td", { text: reconciliationKindLabel(item.kind) }),
        el("td", { text: resources[item.resource]?.title || item.resource }),
        el("td", { text: safeValue(item.title, item.record_id) }),
        el("td", { text: safeValue(item.due_at, "未记录") }),
        el("td", { text: safeValue(item.reason, "无说明") })
      );
      body.append(row);
    });
    table.append(body);
    wrap.append(table, renderReconciliationPagination(list));
    return wrap;
  }

  function renderReconciliationPagination(list) {
    const total = Number(list.total || 0);
    const start = total ? list.offset + 1 : 0;
    const end = Math.min(total, list.offset + PAGE_SIZE);
    const prev = el("button", {
      class: "btn",
      type: "button",
      disabled: list.offset <= 0 ? "disabled" : null,
      onclick: () => {
        list.offset = Math.max(0, list.offset - PAGE_SIZE);
        loadReconciliation();
      },
      text: "上一页"
    });
    const next = el("button", {
      class: "btn",
      type: "button",
      disabled: list.offset + PAGE_SIZE >= total ? "disabled" : null,
      onclick: () => {
        list.offset += PAGE_SIZE;
        loadReconciliation();
      },
      text: "下一页"
    });
    return el("div", { class: "pagination" }, [el("span", { text: `${start}-${end} / ${total}` }), el("div", { class: "actions-row" }, [prev, next])]);
  }

  function reconciliationKindLabel(kind) {
    return {
      overdue_task: "逾期任务",
      missing_evidence: "缺外部凭证",
      unverified_action: "未核验动作",
      overdue_observation: "逾期监测",
      review_due: "待复盘"
    }[kind] || kind;
  }

  function renderResourcePage(route) {
    const list = getListState(route);
    const config = resources[route];
    const section = el("section", { class: "workspace" });
    const left = el("div", { class: "resource-list" });
    left.append(renderToolbar(route, list));
    if (list.loading) left.append(el("div", { class: "table-wrap loading", text: "正在读取列表..." }));
    else if (list.error) left.append(el("div", { class: "table-wrap error-box", text: list.error }));
    else left.append(renderTable(route, list));
    section.append(left, renderSidePanel(route, config, list));
    return section;
  }

  function renderToolbar(route, list) {
    const toolbar = el("div", { class: "toolbar panel" });
    const search = el("input", {
      class: "input",
      type: "search",
      id: `${route}-search`,
      name: `${route}-search`,
      placeholder: `搜索${resources[route].title}`,
      value: list.search,
      "aria-label": "搜索"
    });
    let searchTimer = null;
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        list.search = search.value;
        list.offset = 0;
        loadList(route);
      }, 250);
    });
    const status = renderSelect(`status-${route}`, list.status, statuses.map((value) => ({ value, label: value || "全部状态" })), (value) => {
      list.status = value;
      list.offset = 0;
      loadList(route);
    });
    const timeField = renderSelect("time_field", list.timeDraft || list.timeField || "created_at", timeFieldOptions(route), null);
    const dateFrom = el("input", {
      class: "input",
      type: "datetime-local",
      id: `${route}-date-from`,
      name: "date_from",
      value: list.dateFromDraft || list.dateFromLocal || "",
      "aria-label": "开始时间"
    });
    const dateTo = el("input", {
      class: "input",
      type: "datetime-local",
      id: `${route}-date-to`,
      name: "date_to",
      value: list.dateToDraft || list.dateToLocal || "",
      "aria-label": "结束时间"
    });
    [timeField, dateFrom, dateTo].forEach((node) => {
      node.addEventListener("input", () => {
        list.timeDraft = timeField.value;
        list.dateFromDraft = dateFrom.value;
        list.dateToDraft = dateTo.value;
      });
      node.addEventListener("change", () => {
        list.timeDraft = timeField.value;
        list.dateFromDraft = dateFrom.value;
        list.dateToDraft = dateTo.value;
      });
    });
    const applyTime = el("button", {
      class: "btn",
      type: "button",
      text: "应用筛选",
      onclick: () => {
        list.timeField = timeField.value || "created_at";
        list.timeDraft = list.timeField;
        list.dateFromLocal = dateFrom.value;
        list.dateToLocal = dateTo.value;
        list.dateFromDraft = dateFrom.value;
        list.dateToDraft = dateTo.value;
        list.dateFrom = localDateTimeToIso(dateFrom.value);
        list.dateTo = localDateTimeToIso(dateTo.value);
        list.offset = 0;
        loadList(route);
      }
    });
    toolbar.append(
      el("div", { class: "search-row" }, [search]),
      el("div", { class: "filter-row" }, [
        el("div", { class: "field inline" }, [el("label", { for: `status-${route}`, text: "状态" }), status]),
        el("div", { class: "field inline" }, [el("label", { for: "time_field", text: "时间字段" }), timeField]),
        el("div", { class: "field inline" }, [el("label", { for: `${route}-date-from`, text: "开始" }), dateFrom]),
        el("div", { class: "field inline" }, [el("label", { for: `${route}-date-to`, text: "结束" }), dateTo]),
        applyTime
      ])
    );
    return toolbar;
  }

  function timeFieldOptions(route) {
    const options = [
      { value: "created_at", label: "创建时间" },
      { value: "updated_at", label: "更新时间" }
    ];
    if (route === "actions") options.push({ value: "occurred_at", label: "实际发生时间" });
    if (route === "metrics") options.push({ value: "observed_at", label: "观测时间" });
    if (route === "tasks" || route === "observations") options.push({ value: "due_at", label: "截止/监测时间" });
    if (route === "reviews") options.push({ value: "review_period", label: "复盘周期" });
    return options;
  }

  function localDateTimeToIso(value) {
    if (!value) return "";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
  }

  function renderTable(route, list) {
    const wrap = el("div", { class: "table-wrap" });
    if (!list.items.length) {
      wrap.append(el("div", { class: "empty", text: "暂无记录。使用右侧表单创建第一条，或调整筛选条件。" }));
      return wrap;
    }
    const table = el("table");
    table.append(
      el("thead", {}, [
        el("tr", {}, ["标题", "状态", "账号", "产品", "更新时间"].map((text) => el("th", { text })))
      ])
    );
    const body = el("tbody");
    list.items.forEach((item) => {
      const row = el("tr", {
        class: "clickable",
        tabindex: "0",
        onclick: () => openDetail(route, item.id),
        onkeydown: (event) => {
          if (event.key === "Enter" || event.key === " ") openDetail(route, item.id);
        }
      });
      row.append(
        el("td", { text: safeValue(item.title || item.data?.metric_name || item.id, "未命名") }),
        el("td", {}, [el("span", { class: `status ${String(item.status || "").toLowerCase()}`, text: safeValue(item.status, "缺失") })]),
        el("td", { text: refName("accounts", item.account_id) }),
        el("td", { text: refName("products", item.product_id) }),
        el("td", { text: safeValue(item.updated_at || item.created_at, "缺失") })
      );
      body.append(row);
    });
    table.append(body);
    wrap.append(table, renderPagination(route, list));
    return wrap;
  }

  function renderPagination(route, list) {
    const total = Number(list.total || 0);
    const start = total ? list.offset + 1 : 0;
    const end = Math.min(total, list.offset + PAGE_SIZE);
    const prev = el("button", {
      class: "btn",
      type: "button",
      disabled: list.offset <= 0 ? "disabled" : null,
      onclick: () => {
        list.offset = Math.max(0, list.offset - PAGE_SIZE);
        loadList(route);
      },
      text: "上一页"
    });
    const next = el("button", {
      class: "btn",
      type: "button",
      disabled: list.offset + PAGE_SIZE >= total ? "disabled" : null,
      onclick: () => {
        list.offset += PAGE_SIZE;
        loadList(route);
      },
      text: "下一页"
    });
    return el("div", { class: "pagination" }, [
      el("span", { text: `${start}-${end} / ${total}` }),
      el("div", { class: "actions-row" }, [prev, next])
    ]);
  }

  function renderSidePanel(route, config, list) {
    const detail = state.details[route];
    const isCreate = list.mode === "create" || !detail;
    const title = isCreate ? `新建${config.singular}` : `编辑${config.singular}`;
    const panel = el("aside", { class: "side-panel", "aria-label": title });
    panel.append(
      el("div", { class: "side-head" }, [
        el("h3", { text: title }),
        detail ? el("span", { class: "status", text: detail.id || "" }) : el("span", { class: "status", text: "POST" })
      ])
    );
    panel.append(renderForm(route, detail || {}));
    if (detail && config.versioned) panel.append(renderHistoryBlock(route, detail));
    if (detail && route === "actions") panel.append(renderActionContextBlock(detail));
    return panel;
  }

  function renderActionContextBlock(record) {
    const context = state.actionContexts[record.id];
    const button = el("button", {
      class: "btn",
      type: "button",
      onclick: () => loadActionContext(record.id),
      text: context?.loading ? "读取中..." : "动作上下文"
    });
    const wrap = el("div", { class: "history-block context-block" }, [button]);
    if (context?.error) {
      wrap.append(el("div", { class: "error-text", text: context.error }));
      return wrap;
    }
    if (!context?.payload) return wrap;
    const payload = context.payload;
    const strategyMeta = payload.strategy ? `策略 ${payload.strategy.title} · v${payload.strategy.version} · ${strategyResolutionLabel(payload.strategy_resolution)}` : `策略缺失 · ${strategyResolutionLabel(payload.strategy_resolution)}`;
    wrap.append(el("div", { class: "context-summary" }, [
      linkedContextItem("任务", payload.task, "tasks"),
      linkedContextItem("内容", payload.content, "contents"),
      linkedContextItem("父动作", payload.parent_action, "actions"),
      el("article", { class: "context-card" }, [
        el("div", { class: "compact-title", text: strategyMeta }),
        payload.strategy?.data?.body ? el("pre", { text: payload.strategy.data.body }) : el("div", { class: "compact-meta", text: "没有可显示的策略正文" })
      ])
    ]));
    Object.entries(payload.collections || {}).forEach(([key, value]) => {
      wrap.append(renderContextCollection(key, value));
    });
    return wrap;
  }

  function linkedContextItem(label, record, route) {
    if (!record) {
      return el("article", { class: "context-card muted-card" }, [
        el("div", { class: "compact-title", text: label }),
        el("div", { class: "compact-meta", text: "未关联" })
      ]);
    }
    return el("a", { class: "context-card", href: `/${route}`, dataset: { route, recordId: record.id } }, [
      el("div", { class: "compact-title", text: `${label} · ${safeValue(record.title, record.id)}` }),
      el("div", { class: "compact-meta", text: safeValue(record.status, "状态缺失") })
    ]);
  }

  function renderContextCollection(key, value) {
    const titles = {
      metrics: "关联指标",
      observations: "关联监测",
      reviews: "关联复盘",
      follow_up_tasks: "后续任务",
      follow_up_actions: "后续动作"
    };
    const items = Array.isArray(value?.items) ? value.items : [];
    const block = el("section", { class: "context-section" }, [
      el("h4", { text: `${titles[key] || key} ${Number(value?.total || 0)}` })
    ]);
    if (!items.length) {
      block.append(el("div", { class: "compact-meta", text: "暂无记录" }));
      return block;
    }
    const list = el("div", { class: "compact-list" });
    items.forEach((item) => {
      list.append(el("a", { class: "compact-item", href: `/${item.resource}`, dataset: { route: item.resource, recordId: item.id } }, [
        el("div", { class: "compact-title", text: safeValue(item.title, item.id) }),
        el("div", { class: "compact-meta", text: `${safeValue(item.status, "状态缺失")} · ${safeValue(item.updated_at, "时间缺失")}` })
      ]));
    });
    block.append(list);
    if (Number(value.total || 0) > items.length) block.append(el("div", { class: "compact-meta", text: "还有更多记录，可通过接口 limit/offset 分页读取。" }));
    return block;
  }

  function renderForm(route, record) {
    const config = resources[route];
    const form = el("form", { dataset: { draftKey: draftKey(route, record), route } });
    const title = inputField("title", "标题", record.title || "", "text");
    const status = selectField("status", "状态", record.status || config.defaultStatus || "active", statuses.filter(Boolean).map((value) => ({ value, label: value })));
    const version = inputField("version", "版本", record.version || "", "text");
    const accountValue = record.id ? record.account_id || "" : record.account_id || accountParam(route) || "";
    const account = selectField("account_id", "账号", accountValue, accountOptions(true), config.noAccountFilter);
    const product = selectField("product_id", "产品", record.product_id || "", productOptions(true));
    form.append(el("div", { class: "form-grid" }, [title, status, version]));
    form.append(el("div", { class: "form-grid" }, [account, product]));

    (config.fields || []).forEach((field) => {
      form.append(fieldForConfig(field, record));
    });

    const advanced = el("details", { class: "advanced" }, [
      el("summary", { text: "Advanced JSON" }),
      el("div", { class: "field" }, [
        el("label", { for: `${route}-advanced`, text: "data 扩展字段 JSON" }),
        el("textarea", {
          class: "textarea",
          id: `${route}-advanced`,
          name: "advanced_json",
          rows: "7",
          spellcheck: "false",
          text: JSON.stringify(record.data || {}, null, 2)
        }),
        el("div", { class: "json-error", id: `${route}-json-error`, role: "alert" })
      ])
    ]);
    form.append(advanced);

    const save = el("button", { class: "btn primary", type: "submit" });
    save.innerHTML = icon("save");
    save.append(document.createTextNode(record.id ? "保存" : "创建"));
    form.append(el("div", { class: "actions-row" }, [save]));
    form.addEventListener("submit", (event) => submitForm(event, route, record));
    return form;
  }

  function inputField(name, label, value, type, disabled) {
    return el("div", { class: "field" }, [
      el("label", { for: name, text: label }),
      el("input", {
        class: "input",
        id: name,
        name,
        type,
        value,
        disabled: disabled ? "disabled" : null
      })
    ]);
  }

  function selectField(name, label, value, options, disabled) {
    return el("div", { class: "field" }, [
      el("label", { for: name, text: label }),
      renderSelect(name, value, options, null, disabled)
    ]);
  }

  function fieldForConfig(field, record) {
    const value = field.data ? record.data?.[field.key] : record[field.key];
    if (field.type === "select") {
      return selectField(field.key, field.label, value || "", refOptions(field.ref, true));
    }
    if (field.type === "select-options") {
      return selectField(field.key, field.label, value || "", field.options.map((item) => ({ value: item, label: item })));
    }
    if (field.type === "textarea") {
      return el("div", { class: "field" }, [
        el("label", { for: field.key, text: field.label }),
        el("textarea", {
          class: "textarea",
          id: field.key,
          name: field.key,
          rows: "5",
          text: value ?? ""
        })
      ]);
    }
    if (field.type === "checkbox") {
      const checked = value === true || value === "true";
      return el("label", { class: "checkbox-label checkbox-field" }, [
        el("input", {
          type: "checkbox",
          id: field.key,
          name: field.key,
          checked: checked ? "checked" : null
        }),
        document.createTextNode(field.label)
      ]);
    }
    return inputField(field.key, field.label, formatInputValue(field, value), field.type || "text");
  }

  function formatInputValue(field, value) {
    if (value === undefined || value === null) return "";
    if (field.type === "datetime-local") return formatDateTimeLocal(value);
    return value;
  }

  function formatDateTimeLocal(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function renderSelect(id, selected, options, onChange, disabled) {
    const select = el("select", { class: "select", id, name: id, disabled: disabled ? "disabled" : null });
    const hasSelected = options.some((option) => String(option.value) === String(selected || ""));
    if (selected && !hasSelected) {
      select.append(el("option", { value: selected, text: `${selected}（当前）` }));
    }
    options.forEach((option) => {
      const opt = el("option", { value: option.value, text: option.label });
      if (String(option.value) === String(selected || "")) opt.selected = true;
      select.append(opt);
    });
    if (onChange) {
      select.addEventListener("change", () => onChange(select.value));
    }
    return select;
  }

  async function submitForm(event, route, record) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const config = resources[route];
    const jsonError = form.querySelector(".json-error");
    jsonError.textContent = "";
    let advanced = {};
    try {
      advanced = JSON.parse(data.get("advanced_json") || "{}");
      if (!advanced || typeof advanced !== "object" || Array.isArray(advanced)) throw new Error("data 必须是对象");
    } catch (error) {
      jsonError.textContent = error.message;
      return;
    }
    const payload = {
      title: data.get("title") || "",
      account_id: data.get("account_id") || null,
      product_id: data.get("product_id") || null,
      status: data.get("status") || null,
      data: { ...advanced }
    };
    const rawVersion = data.get("version");
    if (rawVersion !== "" && rawVersion !== null) {
      const parsedVersion = Number(rawVersion);
      if (!Number.isInteger(parsedVersion) || parsedVersion < 1) {
        notify("保存失败：version 必须是正整数。");
        return;
      }
      payload.version = parsedVersion;
    }
    (config.fields || []).forEach((field) => {
      const value = normalizeConfigFieldValue(field, data, form);
      if (field.data) payload.data[field.key] = value;
      else payload[field.key] = value;
    });
    omitUnchangedDateTimeFields(payload, config.fields || [], record);
    normalizeDateTimePayload(payload, config.fields || []);
    if (route === "metrics" && !normalizeMetricPayload(payload)) return;
    if (!record.id && !payload.account_id) delete payload.account_id;
    if (!record.id && !payload.product_id) delete payload.product_id;
    if (!payload.version) delete payload.version;
    if (record.id && !payload.version) {
      notify("保存失败：PATCH 需要携带当前 version，请重新打开详情后再保存。");
      return;
    }

    try {
      const method = record.id ? "PATCH" : "POST";
      const path = record.id ? `/${route}/${encodeURIComponent(record.id)}` : `/${route}`;
      const headers = {};
      if (method === "POST") {
        state.createKeys[route] = state.createKeys[route] || makeIdempotencyKey();
        headers["Idempotency-Key"] = state.createKeys[route];
      }
      const saved = unwrapItem(await api(path, { method, headers, body: JSON.stringify(payload) }));
      clearDraft(route, record);
      state.details[route] = saved;
      if (method === "POST") delete state.createKeys[route];
      getListState(route).mode = "edit";
      state.skipDraftCapture = true;
      notify(record.id ? "已保存" : "已创建");
      await Promise.all([loadRefs(), loadList(route, false)]);
      renderShell();
    } catch (error) {
      notify(error.message || "保存失败");
    }
  }

  function normalizeFieldValue(value) {
    if (value === "" || value === null || value === undefined) return null;
    return value;
  }

  function normalizeConfigFieldValue(field, data, form) {
    if (field.type === "checkbox") {
      return Boolean(form.querySelector(`[name="${cssEscape(field.key)}"]`)?.checked);
    }
    return normalizeFieldValue(data.get(field.key));
  }

  function omitUnchangedDateTimeFields(payload, fields, record) {
    if (!record.id) return;
    fields.forEach((field) => {
      if (field.type !== "datetime-local") return;
      const source = field.data ? record.data || {} : record;
      const original = formatInputValue(field, source[field.key]);
      const target = field.data ? payload.data : payload;
      if (target[field.key] === original) delete target[field.key];
    });
  }

  function normalizeDateTimePayload(payload, fields) {
    fields.forEach((field) => {
      if (field.type !== "datetime-local") return;
      const target = field.data ? payload.data : payload;
      if (!Object.prototype.hasOwnProperty.call(target, field.key)) return;
      const value = target[field.key];
      if (!value) {
        target[field.key] = null;
        return;
      }
      const parsed = new Date(value);
      target[field.key] = Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    });
  }

  function normalizeMetricPayload(payload) {
    const data = payload.data;
    data.availability = data.availability || "valid";
    if (data.observed_at) {
      const observedAt = new Date(data.observed_at);
      if (Number.isNaN(observedAt.getTime())) {
        notify("保存失败：观测时间无效。");
        return false;
      }
      data.observed_at = observedAt.toISOString();
    }
    if (data.availability === "valid") {
      if (data.value === null) {
        notify("保存失败：availability 为 valid 时，值必须是数字；如果数据不可用，请选择 missing、unavailable 或 not_applicable。");
        return false;
      }
      const numericValue = Number(data.value);
      if (!Number.isFinite(numericValue)) {
        notify("保存失败：指标值必须是数字。");
        return false;
      }
      data.value = numericValue;
      return true;
    }
    data.value = null;
    return true;
  }

  function unwrapItem(payload) {
    if (payload && typeof payload === "object" && payload.item && typeof payload.item === "object") {
      return payload.item;
    }
    return payload;
  }

  function makeIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function draftKey(route, record) {
    return `${route}:${record.id || "new"}`;
  }

  function clearDraft(route, record) {
    delete state.drafts[draftKey(route, record)];
  }

  function captureUiState() {
    const active = document.activeElement;
    state.focus = null;
    if (active && active.matches && active.matches("input, textarea, select")) {
      state.focus = {
        name: active.getAttribute("name") || "",
        id: active.id || "",
        route: state.route,
        start: typeof active.selectionStart === "number" ? active.selectionStart : null,
        end: typeof active.selectionEnd === "number" ? active.selectionEnd : null
      };
    }
    const form = document.querySelector("form[data-draft-key]");
    if (!form) return;
    const values = {};
    form.querySelectorAll("input[name], textarea[name], select[name]").forEach((field) => {
      values[field.name] = field.type === "checkbox" ? field.checked : field.value;
    });
    state.drafts[form.dataset.draftKey] = values;
  }

  function restoreUiState() {
    const form = document.querySelector("form[data-draft-key]");
    if (form && state.drafts[form.dataset.draftKey]) {
      const values = state.drafts[form.dataset.draftKey];
      form.querySelectorAll("input[name], textarea[name], select[name]").forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(values, field.name)) return;
        if (field.type === "checkbox") field.checked = Boolean(values[field.name]);
        else field.value = values[field.name];
      });
    }
    if (!state.focus || state.focus.route !== state.route || (!state.focus.name && !state.focus.id)) return;
    const selector = state.focus.name ? `[name="${cssEscape(state.focus.name)}"]` : `#${cssEscape(state.focus.id)}`;
    const target = document.querySelector(selector);
    if (!target) return;
    target.focus();
    if (state.focus.start !== null && typeof target.setSelectionRange === "function") {
      target.setSelectionRange(state.focus.start, state.focus.end);
    }
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function renderHistoryBlock(route, record) {
    const key = `${route}:${record.id}`;
    const history = state.history[key];
    const button = el("button", {
      class: "btn",
      type: "button",
      onclick: () => loadHistory(route, record.id),
      text: history?.loading ? "读取中..." : "版本历史"
    });
    const wrap = el("div", { class: "history-block" }, [button]);
    if (history?.error) {
      wrap.append(el("div", { class: "error-text", text: history.error }));
    } else if (Array.isArray(history?.items)) {
      if (!history.items.length) {
        wrap.append(el("div", { class: "compact-meta", text: "暂无历史版本" }));
      } else {
        const list = el("div", { class: "compact-list" });
        history.items.forEach((item) => {
          list.append(
            el("article", { class: "history-item" }, [
              el("div", { class: "compact-title", text: `v${safeValue(item.version, "缺失")} · ${safeValue(item.updated_at, "时间缺失")}` }),
              el("pre", { text: safeValue(item.data?.body, "正文缺失") })
            ])
          );
        });
        wrap.append(list);
      }
    }
    return wrap;
  }

  async function loadHistory(route, id) {
    const key = `${route}:${id}`;
    state.history[key] = { loading: true, error: "", items: [] };
    renderShell();
    try {
      const payload = await api(`/${route}/${encodeURIComponent(id)}/history`);
      state.history[key] = { loading: false, error: "", items: Array.isArray(payload.items) ? payload.items : [] };
    } catch (error) {
      state.history[key] = { loading: false, error: errorText(error.message), items: [] };
    }
    renderShell();
  }

  function renderSettings() {
    const tokenDoc = `Authorization: Bearer <API_KEY>

GET ${API_BASE}/dashboard?account_id=<uuid>
返回：
{
  "counts": {"tasks": 0, "actions": 0, "metrics": 0},
  "latest_metrics": [{"id":"...","title":"Follower snapshot","data":{"metric_name":"followers","value":123,"availability":"valid","observed_at":"2026-09-08T09:00:00Z"}}],
  "recent_work": [{"id":"...","title":"监测昨晚帖子","status":"pending"}]
}

GET ${API_BASE}/<resource>?limit=20&offset=0&q=&status=&account_id=
返回：{"items":[],"total":0,"limit":20,"offset":0}

GET ${API_BASE}/<resource>/<id>
返回：{"item": record}

POST/PATCH ${API_BASE}/<resource>
通用 body：
{"title":"","account_id":null,"product_id":null,"status":"active","version":1,"data":{}}

POST 必须带 Idempotency-Key；PATCH 的 version 必须是 GET 返回的数字。
metrics 字段放在 data 内，valid 指标 value 必须是数字；missing、unavailable、not_applicable 的 value 必须是 null。

资源：${listRoutes.join(", ")}`;
    const panel = el("section", { class: "settings-grid" });
    panel.append(
      el("div", { class: "doc-panel" }, [
        el("h3", { text: "API 接入文档" }),
        el("pre", { text: tokenDoc })
      ]),
      el("div", { class: "doc-panel" }, [
        el("h3", { text: "本地会话" }),
        el("p", { class: "compact-meta", text: "API Key 只保存在当前浏览器 sessionStorage，退出会清除。" }),
        settingsActions()
      ])
    );
    return panel;
  }

  function settingsActions() {
    const wrap = el("div", { class: "latest-list" });
    const exportBtn = el("button", { class: "btn", type: "button" });
    exportBtn.innerHTML = icon("download");
    exportBtn.append(document.createTextNode("导出 JSON"));
    exportBtn.addEventListener("click", exportReadableData);
    const clearBtn = el("button", {
      class: "btn danger",
      type: "button",
      text: "退出并清除 Key",
      onclick: () => {
        clearAuthentication("已退出工作台。");
      }
    });
    wrap.append(el("div", { class: "actions-row" }, [exportBtn, clearBtn]));
    return wrap;
  }

  async function exportReadableData() {
    try {
      const output = await api("/export");
      const blob = new Blob([JSON.stringify(output, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = el("a", { href: url, download: `growth-ops-export-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify("已导出可读取数据");
    } catch (error) {
      notify(error.message || "导出失败");
    }
  }

  async function loadRefs() {
    const results = await Promise.allSettled(
      refRoutes.map((route) => api(`/${route}${buildQuery({ limit: 200, offset: 0 })}`))
    );
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value && Array.isArray(result.value.items)) {
        state.refs[refRoutes[index]] = result.value.items;
      }
    });
  }

  async function loadDashboard() {
    state.loading = true;
    state.error = "";
    renderShell();
    try {
      state.dashboard = await api(`/dashboard${buildQuery({ account_id: state.accountId })}`);
    } catch (error) {
      state.dashboard = null;
      state.error = error.message || "仪表盘读取失败";
    } finally {
      state.loading = false;
      renderShell();
    }
  }

  async function loadList(route, paint = true) {
    const list = getListState(route);
    list.loading = true;
    list.error = "";
    if (paint) renderShell();
    try {
      const payload = await api(
        `/${route}${buildQuery({
          limit: PAGE_SIZE,
          offset: list.offset,
          q: list.search,
          status: list.status,
          account_id: accountParam(route),
          time_field: list.timeField,
          date_from: list.dateFrom,
          date_to: list.dateTo
        })}`
      );
      list.items = Array.isArray(payload.items) ? payload.items : [];
      list.total = Number(payload.total || list.items.length || 0);
      list.limit = Number(payload.limit || PAGE_SIZE);
      list.offset = Number(payload.offset || list.offset || 0);
    } catch (error) {
      list.items = [];
      list.total = 0;
      list.error = error.message || "列表读取失败";
    } finally {
      list.loading = false;
      renderShell();
    }
  }

  async function openDetail(route, id) {
    const list = getListState(route);
    list.mode = "edit";
    state.details[route] = null;
    renderShell();
    try {
      state.details[route] = unwrapItem(await api(`/${route}/${encodeURIComponent(id)}`));
    } catch (error) {
      notify(error.message || "详情读取失败");
    } finally {
      renderShell();
    }
  }

  async function loadActionContext(id) {
    state.actionContexts[id] = { loading: true, error: "", payload: null };
    renderShell();
    try {
      state.actionContexts[id] = { loading: false, error: "", payload: await api(`/actions/${encodeURIComponent(id)}/context`) };
    } catch (error) {
      state.actionContexts[id] = { loading: false, error: errorText(error.message), payload: null };
    }
    renderShell();
  }

  async function loadReconciliation(paint = true) {
    const list = getReconciliationState();
    list.loading = true;
    list.error = "";
    if (paint) renderShell();
    try {
      const payload = await api(`/reconciliation${buildQuery({
        limit: PAGE_SIZE,
        offset: list.offset,
        account_id: state.accountId,
        product_id: list.productId,
        kind: list.kind
      })}`);
      list.items = Array.isArray(payload.items) ? payload.items : [];
      list.total = Number(payload.total || list.items.length || 0);
      list.limit = Number(payload.limit || PAGE_SIZE);
      list.offset = Number(payload.offset || list.offset || 0);
      list.counts = payload.counts || {};
      list.asOf = payload.as_of || "";
    } catch (error) {
      list.items = [];
      list.total = 0;
      list.counts = {};
      list.error = error.message || "对账读取失败";
    } finally {
      list.loading = false;
      renderShell();
    }
  }

  async function refreshCurrent() {
    if (!state.token) {
      renderShell();
      return;
    }
    await loadRefs();
    if (!state.authenticated) return;
    if (state.route === "dashboard") await loadDashboard();
    else if (state.route === "reconciliation") await loadReconciliation();
    else if (listRoutes.includes(state.route)) await loadList(state.route);
    else renderShell();
  }

  function getListState(route) {
    if (!state.lists[route]) {
      state.lists[route] = {
        items: [],
        total: 0,
        limit: PAGE_SIZE,
        offset: 0,
        search: "",
        status: "",
        timeField: "created_at",
        timeDraft: "created_at",
        dateFrom: "",
        dateTo: "",
        dateFromLocal: "",
        dateToLocal: "",
        dateFromDraft: "",
        dateToDraft: "",
        loading: false,
        error: "",
        mode: "create"
      };
    }
    return state.lists[route];
  }

  function getReconciliationState() {
    if (!state.reconciliation) {
      state.reconciliation = {
        items: [],
        total: 0,
        limit: PAGE_SIZE,
        offset: 0,
        productId: "",
        kind: "",
        counts: {},
        asOf: "",
        loading: false,
        error: ""
      };
    }
    return state.reconciliation;
  }

  function accountParam(route) {
    return resources[route]?.noAccountFilter ? "" : state.accountId;
  }

  function refName(ref, id) {
    if (!id) return "未关联";
    const item = state.refs[ref].find((entry) => String(entry.id) === String(id));
    return item ? safeValue(item.title || item.data?.handle || item.id, "未命名") : "未加载";
  }

  function refOptions(ref, optional) {
    const options = optional ? [{ value: "", label: "不关联" }] : [];
    state.refs[ref].forEach((item) => options.push({ value: item.id, label: item.title || item.data?.handle || item.id }));
    return options;
  }

  function accountOptions(optional) {
    return refOptions("accounts", optional).map((option) => ({
      value: option.value,
      label: option.value ? option.label : "全部账号"
    }));
  }

  function productOptions(optional) {
    return refOptions("products", optional);
  }

  function reconciliationProductOptions() {
    return productOptions(true).map((option) => ({
      value: option.value,
      label: option.value ? option.label : "全部产品"
    }));
  }

  function strategyResolutionLabel(value) {
    return {
      exact: "精确版本",
      current_unpinned: "当前未锁定",
      missing: "缺失"
    }[value] || safeValue(value, "缺失");
  }

  function clearAuthentication(message = "") {
    state.authAttempt += 1;
    state.token = "";
    state.authenticated = false;
    state.loginBusy = false;
    state.loginMessage = message;
    state.toast = "";
    storage.removeItem("growthOpsApiKey");
    state.dashboard = null;
    state.lists = {};
    state.details = {};
    state.history = {};
    state.actionContexts = {};
    state.reconciliation = null;
    Object.keys(state.refs).forEach(key => { state.refs[key] = []; });
    renderToast();
    renderShell();
  }

  async function saveToken(value) {
    const candidate = String(value || "").trim();
    if (!candidate) {
      clearAuthentication("请输入密钥文件中的完整内容。");
      return;
    }
    const attempt = ++state.authAttempt;
    state.authenticated = false;
    state.loginBusy = true;
    state.loginMessage = "";
    state.token = "";
    storage.removeItem("growthOpsApiKey");
    renderShell();
    try {
      const response = await fetch(`${API_BASE}/meta`, {
        headers: { "Authorization": `Bearer ${candidate}`, "Accept": "application/json" },
        cache: "no-store"
      });
      if (attempt !== state.authAttempt) return;
      if (!response.ok) {
        clearAuthentication(response.status === 401
          ? "密钥不正确，请复制 data/api-key 文件中的完整内容后重试。"
          : "暂时无法验证密钥，请确认本地服务正常后重试。");
        return;
      }
      const contract = await response.json();
      if (attempt !== state.authAttempt) return;
      if (!Array.isArray(contract.resources)) throw new Error("invalid response");
      state.token = candidate;
      state.authenticated = true;
      state.loginBusy = false;
      storage.setItem("growthOpsApiKey", candidate);
      renderShell();
      await refreshCurrent();
    } catch (error) {
      if (attempt !== state.authAttempt) return;
      clearAuthentication("连接本地服务失败，请确认服务已启动后重试。");
    }
  }

  function notify(message) {
    state.toast = message;
    renderToast();
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => {
      state.toast = "";
      renderToast();
    }, 2600);
  }

  function renderToast() {
    document.querySelectorAll(".toast").forEach((node) => node.remove());
    if (!state.toast || !state.token) return;
    document.body.append(el("div", { class: "toast", role: "status", text: state.toast }));
  }

  function safeValue(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    return String(value);
  }

  function metricValue(value) {
    if (value === undefined || value === null || value === "") return "缺失";
    return String(value);
  }

  async function goRoute(route, recordId) {
    if (!resources[route]) return;
    captureUiState();
    history.pushState({}, "", `/${route}`);
    state.route = route;
    state.navOpen = false;
    renderShell();
    await refreshCurrent();
    if (recordId && state.route === route) await openDetail(route, recordId);
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-route]");
    if (!link) return;
    const route = link.dataset.route;
    if (!resources[route] || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    goRoute(route, link.dataset.recordId);
  });

  window.addEventListener("popstate", () => {
    state.route = normalizeRoute();
    state.navOpen = false;
    refreshCurrent();
  });

  state.route = normalizeRoute();
  renderShell();
  if (state.token) saveToken(state.token);
})();
