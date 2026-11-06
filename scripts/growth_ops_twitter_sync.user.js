// ==UserScript==
// @name         Growth Ops - Twitter (X) 数据自动同步助手
// @namespace    https://growth-ops.local/
// @version      1.5.1
// @description  专属于本人账号的推文指标采集（极简胶囊悬浮窗、一键自动滚动抓取、隔离信息流与转推），自动持久化并同步到 Growth Ops
// @author       Growth Ops
// @match        https://x.com/*
// @match        https://twitter.com/*
// @icon         https://abs.twimg.com/favicons/twitter.3.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 默认配置（点击右下角悬浮窗齿轮 ⚙️ 可随时修改）
    const CONFIG = {
        get targetHandle() {
            return GM_getValue('growth_target_handle', '').toLowerCase();
        },
        set targetHandle(v) {
            GM_setValue('growth_target_handle', v.replace(/^@/, '').trim().toLowerCase());
        },
        get apiUrl() {
            return GM_getValue('growth_api_url', 'http://127.0.0.1:8787');
        },
        set apiUrl(v) {
            GM_setValue('growth_api_url', v.replace(/\/+$/, ''));
        },
        get apiKey() {
            return GM_getValue('growth_api_key', '');
        },
        set apiKey(v) {
            GM_setValue('growth_api_key', v.trim());
        },
        get autoSync() {
            return GM_getValue('growth_auto_sync', true);
        },
        set autoSync(v) {
            GM_setValue('growth_auto_sync', !!v);
        },
        get cooldownMinutes() {
            return GM_getValue('growth_cooldown_minutes', 60); // 默认 60 分钟冷却
        },
        set cooldownMinutes(v) {
            GM_setValue('growth_cooldown_minutes', Math.max(1, parseInt(v, 10) || 60));
        },
        get lastSyncTime() {
            return GM_getValue('growth_last_sync_time', 0);
        },
        set lastSyncTime(v) {
            GM_setValue('growth_last_sync_time', v);
        }
    };

    // 判断当前是否为配置的账号主页
    function isMyProfilePage() {
        const path = window.location.pathname.toLowerCase();
        return Boolean(CONFIG.targetHandle) && path.split('/')[1] === CONFIG.targetHandle;
    }

    // 从本地持久化缓存加载历史捕获的所有推文（刷新页面不丢失）
    const initialCache = GM_getValue('growth_cached_tweets', {});
    const capturedTweets = new Map(Object.entries(initialCache));
    let autoSyncTimer = null;

    // 清理缓存：严格只保留本人创作的推文，剔除主页信息流、转推等杂质
    function purgeNonOwnTweets() {
        const target = CONFIG.targetHandle;
        let changed = false;
        for (const [id, item] of capturedTweets.entries()) {
            const author = (item.author_handle || '').toLowerCase();
            const isRt = (item.text && item.text.startsWith('RT @')) || item.is_retweet;
            // 只要作者不是自己，或者是转推，立刻清除
            if (author !== target || isRt) {
                capturedTweets.delete(id);
                changed = true;
            }
        }
        if (changed) saveCache();
    }
    purgeNonOwnTweets();

    function saveCache() {
        try {
            const obj = Object.fromEntries(capturedTweets);
            GM_setValue('growth_cached_tweets', obj);
        } catch (e) {}
    }

    function formatLastSync() {
        if (!CONFIG.lastSyncTime) return '未同步过';
        const mins = Math.floor((Date.now() - CONFIG.lastSyncTime) / 60000);
        if (mins < 1) return '刚刚已同步';
        if (mins < 60) return `${mins}分钟前同步`;
        const hours = Math.floor(mins / 60);
        return `${hours}小时前同步`;
    }

    // 判断推文是否为转发/转推他人
    function isRetweet(node, legacy) {
        if (!legacy) return false;
        if (legacy.retweeted_status_result || legacy.retweeted_status_id_str || legacy.retweeted_status) return true;
        if (legacy.full_text && legacy.full_text.startsWith('RT @')) return true;
        if (node.retweeted_status_result) return true;
        return false;
    }

    // -------------------------------------------------------------
    // 1. 网络请求拦截（拦截 Twitter 官方 GraphQL API）
    // -------------------------------------------------------------
    function handleGraphQLData(data) {
        if (!data || typeof data !== 'object') return;

        // 仅在本人主页时拦截提取，如果在信息流/他人主页直接跳过
        if (!isMyProfilePage()) return;

        function traverse(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.rest_id && (obj.legacy || obj.tweet)) {
                extractTweet(obj.tweet || obj);
            } else if (obj.tweet && obj.tweet.rest_id) {
                extractTweet(obj.tweet);
            }
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    const child = obj[key];
                    if (child && typeof child === 'object') traverse(child);
                }
            }
        }

        traverse(data);
        saveCache();
        updateUI();

        // 模式 C：判断是否达到冷却间隔
        if (CONFIG.autoSync && capturedTweets.size > 0 && isMyProfilePage()) {
            const now = Date.now();
            const elapsedMinutes = (now - CONFIG.lastSyncTime) / (60 * 1000);
            if (elapsedMinutes >= CONFIG.cooldownMinutes) {
                clearTimeout(autoSyncTimer);
                autoSyncTimer = setTimeout(() => {
                    syncToGrowthOps(true);
                }, 3000);
            }
        }
    }

    function extractTweet(node) {
        try {
            const tweetId = node.rest_id;
            const legacy = node.legacy || {};
            if (!tweetId || !legacy.full_text) return;

            // 过滤转发/转推
            if (isRetweet(node, legacy)) return;

            let authorHandle = '';
            let followersCount = null;
            const userResult = node.core?.user_results?.result?.legacy;
            if (userResult) {
                authorHandle = (userResult.screen_name || '').toLowerCase();
                followersCount = userResult.followers_count;
            }

            // 严格过滤：必须是本人账号，彻底过滤信息流里的他人推文
            if (authorHandle !== CONFIG.targetHandle) {
                return;
            }

            const item = {
                id: tweetId,
                tweet_id: tweetId,
                url: `https://x.com/${authorHandle}/status/${tweetId}`,
                text: legacy.full_text,
                created_at: legacy.created_at ? new Date(legacy.created_at).toISOString() : null,
                author_handle: authorHandle,
                author_followers: followersCount,
                views: node.views?.count || legacy.view_count || null,
                likes: legacy.favorite_count ?? null,
                retweets: legacy.retweet_count ?? null,
                replies: legacy.reply_count ?? null,
                bookmarks: legacy.bookmark_count ?? null,
                is_reply: !!legacy.in_reply_to_status_id_str,
                is_retweet: false
            };

            capturedTweets.set(tweetId, item);
        } catch (e) {}
    }

    // 拦截 window.fetch
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (url.includes('/graphql/') || url.includes('/i/api/')) {
                const clone = response.clone();
                clone.json().then(handleGraphQLData).catch(() => {});
            }
        } catch (e) {}
        return response;
    };

    // 拦截 XMLHttpRequest
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._growth_url = url;
        return originalXhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', function () {
            try {
                if (this._growth_url && (this._growth_url.includes('/graphql/') || this._growth_url.includes('/i/api/'))) {
                    handleGraphQLData(JSON.parse(this.responseText));
                }
            } catch (e) {}
        });
        return originalXhrSend.apply(this, args);
    };

    // -------------------------------------------------------------
    // 2. 页面可见 DOM 卡片扫描（只在个人主页运行）
    // -------------------------------------------------------------
    function scanVisibleTweets() {
        // 如果不在本人个人主页（比如在刷首页推荐 For you / Following），绝不扫描！
        if (!isMyProfilePage()) return;

        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        let hasNew = false;
        const target = CONFIG.targetHandle;

        articles.forEach(article => {
            try {
                // 如果有转推标识，跳过
                const socialContext = article.querySelector('[data-testid="socialContext"]');
                if (socialContext) {
                    const scText = socialContext.innerText.toLowerCase();
                    if (scText.includes('repost') || scText.includes('转推')) return;
                }

                // 提取链接和 ID
                const link = article.querySelector('a[href*="/status/"]');
                if (!link) return;
                const match = link.href.match(/\/status\/(\d+)/);
                if (!match) return;
                const tweetId = match[1];

                // 校验作者链接：必须是本人发出的
                const authorLink = article.querySelector(`a[href="/${target}"]`);
                if (!authorLink && !link.href.toLowerCase().includes(`/${target}/status/`)) {
                    return;
                }

                const textEl = article.querySelector('[data-testid="tweetText"]');
                const timeEl = article.querySelector('time');
                const viewsLink = article.querySelector('a[href*="/analytics"]');

                let views = null;
                if (viewsLink) {
                    const viewsText = viewsLink.innerText.replace(/[^0-9.KkMm]/g, '').trim();
                    views = parseShortNumber(viewsText);
                }

                const item = {
                    id: tweetId,
                    tweet_id: tweetId,
                    url: link.href,
                    text: textEl ? textEl.innerText : '',
                    created_at: timeEl ? timeEl.getAttribute('datetime') : null,
                    author_handle: target,
                    views: views,
                    likes: parseActionCount(article.querySelector('[data-testid="like"], [data-testid="unlike"]')),
                    replies: parseActionCount(article.querySelector('[data-testid="reply"]')),
                    retweets: parseActionCount(article.querySelector('[data-testid="retweet"], [data-testid="unretweet"]')),
                    bookmarks: parseActionCount(article.querySelector('[data-testid="bookmark"], [data-testid="removeBookmark"]')),
                    is_retweet: false
                };

                if (!capturedTweets.has(tweetId)) {
                    capturedTweets.set(tweetId, item);
                    hasNew = true;
                } else if (views !== null) {
                    capturedTweets.get(tweetId).views = views;
                }
            } catch (err) {}
        });
        if (hasNew) saveCache();
        updateUI();
    }

    function parseShortNumber(str) {
        if (!str) return null;
        let mult = 1;
        const s = str.toUpperCase();
        if (s.endsWith('K')) mult = 1000;
        if (s.endsWith('M')) mult = 1000000;
        const num = parseFloat(s);
        return isNaN(num) ? null : Math.round(num * mult);
    }

    function parseActionCount(el) {
        if (!el) return null;
        const span = el.querySelector('span[data-testid="app-text-transition-container"]') || el.querySelector('span');
        return span && span.innerText.trim() ? parseShortNumber(span.innerText.trim()) : 0;
    }

    // -------------------------------------------------------------
    // 3. 执行同步
    // -------------------------------------------------------------
    let isSyncing = false;
    function syncToGrowthOps(isAuto = false) {
        purgeNonOwnTweets();
        scanVisibleTweets();
        if (!CONFIG.targetHandle || !CONFIG.apiKey) {
            if (!isAuto) showToast('请先在设置中填写账号和 API 密钥。');
            return;
        }
        const items = Array.from(capturedTweets.values());
        if (items.length === 0) {
            if (!isAuto) showToast('未捕获到本人推文，请进入个人主页 (Profile) 稍作浏览~');
            return;
        }
        if (isSyncing) return;
        isSyncing = true;
        updateUI(true);

        GM_xmlhttpRequest({
            method: 'POST',
            url: `${CONFIG.apiUrl}/api/v1/import/twitter`,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.apiKey}`
            },
            data: JSON.stringify({ items: items }),
            timeout: 15000,
            onload: function (response) {
                isSyncing = false;
                try {
                    const res = JSON.parse(response.responseText);
                    if (response.status === 200 && res.ok) {
                        CONFIG.lastSyncTime = Date.now();
                        showToast(`✅ 已同步 ${res.total_processed || items.length} 条本人推文数据到 Growth Ops！`);
                        updateUI(false);
                    } else {
                        showToast(`❌ 同步失败: ${res?.error?.message || response.status}`);
                        updateUI(false);
                    }
                } catch (e) {
                    showToast(`❌ 响应解析失败`);
                    updateUI(false);
                }
            },
            onerror: function () {
                isSyncing = false;
                showToast(`❌ 无法连接到后台: ${CONFIG.apiUrl}`);
                updateUI(false);
            }
        });
    }

    // -------------------------------------------------------------
    // 4. 自动全量滚动采集引擎（免手动滚动，一键全自动）
    // -------------------------------------------------------------
    let autoScrollTimer = null;
    let isAutoScrolling = false;

    function stopAutoScroll() {
        if (autoScrollTimer) {
            clearInterval(autoScrollTimer);
            autoScrollTimer = null;
        }
        isAutoScrolling = false;
        GM_setValue('growth_auto_step', 'idle');
        updateUI();
    }

    function startAutoCollect() {
        if (isAutoScrolling) {
            stopAutoScroll();
            showToast('⏹ 已停止自动抓取');
            return;
        }

        const handle = CONFIG.targetHandle;
        const path = window.location.pathname.toLowerCase();

        if (!handle) {
            showToast('请先在设置中填写目标账号。');
            return;
        }

        // 如果当前不在本人个人主页，自动跳转过去开始执行
        if (!isMyProfilePage()) {
            showToast('🚀 正在跳转到个人主页开始全量抓取...');
            GM_setValue('growth_auto_step', 'posts');
            window.location.href = `https://x.com/${handle}`;
            return;
        }

        if (path.includes('/with_replies')) {
            runAutoScroll('replies');
        } else {
            runAutoScroll('posts');
        }
    }

    function runAutoScroll(phase) {
        isAutoScrolling = true;
        GM_setValue('growth_auto_step', phase);
        updateUI();
        showToast(phase === 'posts' ? '⏬ 正在自动滚动抓取【主帖】...' : '⏬ 正在自动滚动抓取【回复】...');

        let bottomStreak = 0;
        let lastDocHeight = 0;
        let ticks = 0;

        if (autoScrollTimer) clearInterval(autoScrollTimer);
        autoScrollTimer = setInterval(() => {
            if (!isAutoScrolling) {
                clearInterval(autoScrollTimer);
                return;
            }

            ticks++;
            scanVisibleTweets();
            updateUI();

            // 步进平滑向下滚动，触发 Twitter 官方 GraphQL 懒加载
            window.scrollBy({ top: 950, behavior: 'smooth' });

            const docHeight = document.documentElement.scrollHeight;
            const scrollBottom = window.innerHeight + window.scrollY;
            const isNearBottom = scrollBottom >= (docHeight - 350);

            if (isNearBottom && docHeight === lastDocHeight) {
                bottomStreak++;
            } else {
                bottomStreak = 0;
            }
            lastDocHeight = docHeight;

            // 连续检测到底部且高度无变化（约 2 秒），判定当前标签页加载完毕
            if (bottomStreak >= 3 || ticks > 50) {
                clearInterval(autoScrollTimer);
                autoScrollTimer = null;

                if (phase === 'posts') {
                    showToast(`✅ 主帖已抓齐（累计 ${capturedTweets.size} 条）！自动前往回复页...`);
                    GM_setValue('growth_auto_step', 'replies');
                    setTimeout(() => {
                        window.location.href = `https://x.com/${CONFIG.targetHandle}/with_replies`;
                    }, 1200);
                } else {
                    isAutoScrolling = false;
                    GM_setValue('growth_auto_step', 'idle');
                    updateUI();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    showToast(`🎉 全部推文采集完毕（共 ${capturedTweets.size} 条）！正在自动同步到 Growth Ops...`);
                    setTimeout(() => {
                        syncToGrowthOps(false);
                    }, 1000);
                }
            }
        }, 650);
    }

    function checkAutoCollectResume() {
        const pendingStep = GM_getValue('growth_auto_step', 'idle');
        if (pendingStep === 'posts' || pendingStep === 'replies') {
            setTimeout(() => {
                if (isMyProfilePage()) {
                    runAutoScroll(pendingStep);
                } else {
                    GM_setValue('growth_auto_step', 'idle');
                }
            }, 1800);
        }
    }

    // -------------------------------------------------------------
    // 5. 浮窗 UI（极简紧凑胶囊）
    // -------------------------------------------------------------
    let badgeContainer = null, badgeBtn = null, badgeStatus = null, badgeAutoBtn = null;
    function createUI() {
        if (badgeContainer || !document.body) return;
        badgeContainer = document.createElement('div');
        badgeContainer.id = 'growth-ops-sync-badge';
        badgeContainer.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; z-index: 99999;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex; align-items: center; gap: 6px;
            background: rgba(15, 23, 42, 0.88); backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 9999px;
            padding: 4px 8px 4px 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.35);
            color: #f8fafc; font-size: 12px; transition: all 0.2s ease;
        `;
        badgeContainer.innerHTML = `
            <div style="display: flex; align-items: center; gap: 3px; cursor: pointer; padding: 2px 4px 2px 2px;" id="growth-ops-btn">
                <span style="font-size: 13px;">⚡</span>
                <span id="growth-ops-count" style="font-weight: 600; color: #38bdf8; font-size: 12px;">${capturedTweets.size}条</span>
            </div>
            <button id="growth-ops-auto-fetch" style="background: #059669; border: none; color: white; border-radius: 9999px; padding: 3px 8px; font-size: 11px; font-weight: 500; cursor: pointer;">🚀 抓取</button>
            <button id="growth-ops-sync-now" style="background: #0284c7; border: none; color: white; border-radius: 9999px; padding: 3px 8px; font-size: 11px; font-weight: 500; cursor: pointer;">同步</button>
            <span id="growth-ops-setting" title="设置" style="cursor: pointer; opacity: 0.55; font-size: 12px; margin-left: 1px; padding: 0 2px;">⚙️</span>
        `;
        document.body.appendChild(badgeContainer);
        badgeBtn = document.getElementById('growth-ops-sync-now');
        badgeStatus = document.getElementById('growth-ops-count');
        badgeAutoBtn = document.getElementById('growth-ops-auto-fetch');

        document.getElementById('growth-ops-btn').onclick = () => syncToGrowthOps(false);
        badgeBtn.onclick = () => syncToGrowthOps(false);
        badgeAutoBtn.onclick = startAutoCollect;
        document.getElementById('growth-ops-setting').onclick = openSettings;
        updateUI();
    }

    function updateUI(syncing = false) {
        if (!badgeStatus) return;
        purgeNonOwnTweets();
        badgeBtn.innerText = syncing ? '同步中' : '同步';
        const syncTimeInfo = formatLastSync();
        badgeStatus.innerText = `${capturedTweets.size}条`;
        const summaryTitle = `已锁定 @${CONFIG.targetHandle}（已捕获 ${capturedTweets.size} 条推文）\n上次同步：${syncTimeInfo}\n点击⚡可立即同步`;
        badgeStatus.title = summaryTitle;
        const btnEl = document.getElementById('growth-ops-btn');
        if (btnEl) btnEl.title = summaryTitle;

        if (badgeAutoBtn) {
            if (isAutoScrolling) {
                const currentStep = GM_getValue('growth_auto_step', 'posts');
                badgeAutoBtn.innerText = currentStep === 'posts' ? '⏹ 停(主帖)' : '⏹ 停(回复)';
                badgeAutoBtn.style.background = '#e11d48';
                badgeAutoBtn.title = '点击停止自动抓取';
            } else {
                badgeAutoBtn.innerText = '🚀 抓取';
                badgeAutoBtn.style.background = '#059669';
                badgeAutoBtn.title = '一键全量自动滚动抓取全部推文并自动同步';
            }
        }
    }

    function showToast(text) {
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed; top: 24px; right: 24px; z-index: 100000;
            background: rgba(15, 23, 42, 0.95); color: #fff; padding: 10px 18px;
            border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.2);
            box-shadow: 0 10px 20px rgba(0,0,0,0.3); font-size: 13px; font-family: sans-serif;
            pointer-events: none; transition: opacity 0.3s;
        `;
        toast.innerText = text;
        document.body.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3500);
    }

    function openSettings() {
        const newHandle = prompt('目标追踪账号 (Twitter Handle，不带@):', CONFIG.targetHandle);
        if (newHandle !== null && newHandle.trim()) CONFIG.targetHandle = newHandle.trim();
        const newUrl = prompt('Growth Ops 服务地址 (本地为 http://127.0.0.1:8787，线上部署填线上域名):', CONFIG.apiUrl);
        if (newUrl !== null && newUrl.trim()) CONFIG.apiUrl = newUrl.trim();
        const newKey = prompt('Growth Ops API Key (密钥):', CONFIG.apiKey);
        if (newKey !== null && newKey.trim()) CONFIG.apiKey = newKey.trim();
        const newCooldown = prompt('【模式 C】自动同步冷却间隔（分钟）：\n例如填 60 表示一小时内最多自动同步一次，期间打开推特不再频繁提示。', CONFIG.cooldownMinutes);
        if (newCooldown !== null && !isNaN(parseInt(newCooldown, 10))) {
            CONFIG.cooldownMinutes = parseInt(newCooldown, 10);
        }
        CONFIG.autoSync = confirm(`自动同步总开关：\n点击「确定」开启自动同步（每 ${CONFIG.cooldownMinutes} 分钟），点击「取消」关闭自动同步（仅保留手动点击）。`);
        purgeNonOwnTweets();
        updateUI();
        showToast('⚙️ 设置已保存！');
    }

    window.addEventListener('DOMContentLoaded', () => {
        setTimeout(createUI, 1000);
        checkAutoCollectResume();
    });
    window.addEventListener('scroll', () => { if (!badgeContainer) createUI(); scanVisibleTweets(); }, { passive: true });
    GM_registerMenuCommand('🚀 一键全量自动抓取并同步', startAutoCollect);
    GM_registerMenuCommand('⚡ 立即同步已捕获推文到 Growth Ops', () => syncToGrowthOps(false));
    GM_registerMenuCommand('⚙️ 配置 Growth Ops 地址与账号', openSettings);
})();
