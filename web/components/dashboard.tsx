'use client'

import { useState, useMemo } from 'react'
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  Clock,
  Compass,
  ExternalLink,
  Eye,
  Flame,
  Layers,
  ListChecks,
  MessageSquare,
  PackageOpen,
  RefreshCw,
  Repeat,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Workflow
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { Api, OpsRecord, ResourceName } from '@/lib/types'
import { displayDate, statusLabels, actionTypeLabel } from '@/lib/resources'

export interface DashboardKpis {
  total_views: number
  total_engagements: number
  engagement_rate: number
  total_actions: number
  posts_count: number
  replies_count: number
  tasks_total: number
  tasks_completed: number
  completion_rate: number
  pending_tasks_count: number
}

export interface TopActionItem {
  id: string
  title: string
  status: string
  action_type: string
  occurred_at: string
  evidence_url?: string | null
  views: number
  engagements: number
  likes: number
  retweets: number
  replies: number
}

export interface DailyTrendPoint {
  date: string
  posts: number
  replies: number
  views: number
  engagements: number
}

export interface DashboardData {
  account_id?: string
  counts: Record<string, number>
  latest_metrics: OpsRecord[]
  recent_metric_snapshots?: OpsRecord[]
  recent_work: OpsRecord[]
  kpis?: DashboardKpis
  upcoming_tasks?: OpsRecord[]
  top_actions?: TopActionItem[]
  latest_review?: OpsRecord | null
  daily_trends?: DailyTrendPoint[]
}

interface DashboardProps {
  api: Api
  accountId: string
  accountName?: string
  data?: DashboardData
  loading?: boolean
  error?: string
  onRefresh: () => void
  navigate: (route: string, id?: string) => void
}

function formatNumber(num?: number | null): string {
  if (typeof num !== 'number' || Number.isNaN(num)) return '0'
  if (num >= 10000) return (num / 1000).toFixed(1) + 'k'
  return num.toLocaleString('zh-CN')
}

export function DashboardView({
  api,
  accountId,
  accountName,
  data,
  loading,
  error,
  onRefresh,
  navigate,
}: DashboardProps) {
  const [trendMetric, setTrendMetric] = useState<'views' | 'engagements' | 'activity'>('views')
  const [timeRange, setTimeRange] = useState<'7d' | '30d' | 'all'>('7d')

  const kpis = data?.kpis || {
    total_views: 0,
    total_engagements: 0,
    engagement_rate: 0,
    total_actions: 0,
    posts_count: 0,
    replies_count: 0,
    tasks_total: 0,
    tasks_completed: 0,
    completion_rate: 0,
    pending_tasks_count: 0,
  }

  const trends = useMemo(() => {
    const raw = data?.daily_trends || []
    if (!raw.length) return []
    if (timeRange === '7d') return raw.slice(-7)
    if (timeRange === '30d') return raw.slice(-30)
    return raw
  }, [data?.daily_trends, timeRange])

  const topActions = data?.top_actions || []
  const upcomingTasks = data?.upcoming_tasks || []
  const latestReview = data?.latest_review

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        {/* Tier 1: 汇报抬头与控制 */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <Badge variant="outline" className="text-xs px-2.5 py-0.5 rounded-full border-primary/30 text-primary bg-primary/10">
                运营汇报看板
              </Badge>
              <span className="text-xs text-muted-foreground">
                {new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
              {accountName ? `${accountName} · 运营效果总览` : '全矩阵运营效果总览'}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              核心业务指标走势、落地战果、待办推进与最新战略复盘决策。
            </p>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto">
            <Tabs value={timeRange} onValueChange={v => setTimeRange(v as '7d' | '30d' | 'all')}>
              <TabsList className="h-9">
                <TabsTrigger value="7d" className="text-xs px-3">最近7天</TabsTrigger>
                <TabsTrigger value="30d" className="text-xs px-3">最近30天</TabsTrigger>
                <TabsTrigger value="all" className="text-xs px-3">全部周期</TabsTrigger>
              </TabsList>
            </Tabs>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" className="h-9 w-9" onClick={onRefresh} disabled={loading}>
                  <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>刷新数据</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Tier 2: 4 大核心增长战果 KPI 卡片 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* KPI 1: 总曝光量 */}
          <div
            onClick={() => navigate('metrics', 'content')}
            className="stat-panel group relative cursor-pointer overflow-hidden rounded-xl border bg-card p-5 shadow-xs transition-all hover:border-primary/50 hover:shadow-md hover:-translate-y-0.5"
            title="点击前往内容数据报表查看各内容曝光明细"
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium tracking-wide">总曝光与阅读量</span>
              <div className="rounded-lg bg-blue-500/10 p-2 text-blue-500 transition-colors group-hover:bg-blue-500/20">
                <Eye className="size-4" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <span className="text-3xl font-bold tracking-tight text-foreground tabular-nums">
                {formatNumber(kpis.total_views)}
              </span>
              <ArrowUpRight className="size-4 text-muted-foreground/50 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
            </div>
            <div className="mt-3 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="size-1.5 rounded-full bg-blue-500 shrink-0" />
                <span className="truncate">覆盖 {kpis.posts_count} 篇内容</span>
              </div>
              <span className="text-[11px] font-medium text-primary flex items-center gap-0.5 opacity-80 group-hover:opacity-100 group-hover:underline shrink-0">
                明细 <ChevronRight className="size-3" />
              </span>
            </div>
          </div>

          {/* KPI 2: 总互动与互动率 */}
          <div
            onClick={() => navigate('metrics', 'content')}
            className="stat-panel group relative cursor-pointer overflow-hidden rounded-xl border bg-card p-5 shadow-xs transition-all hover:border-primary/50 hover:shadow-md hover:-translate-y-0.5"
            title="点击前往内容数据报表查看点赞与转评互动表现"
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium tracking-wide">总互动量 & 互动率</span>
              <div className="rounded-lg bg-orange-500/10 p-2 text-orange-500 transition-colors group-hover:bg-orange-500/20">
                <Flame className="size-4" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold tracking-tight text-foreground tabular-nums">
                  {formatNumber(kpis.total_engagements)}
                </span>
                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  {kpis.engagement_rate}% 互动率
                </span>
              </div>
              <ArrowUpRight className="size-4 text-muted-foreground/50 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
            </div>
            <div className="mt-3 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="size-1.5 rounded-full bg-orange-500 shrink-0" />
                <span className="truncate">点赞与转评合集</span>
              </div>
              <span className="text-[11px] font-medium text-primary flex items-center gap-0.5 opacity-80 group-hover:opacity-100 group-hover:underline shrink-0">
                互动 <ChevronRight className="size-3" />
              </span>
            </div>
          </div>

          {/* KPI 3: 实际运营动作规模 */}
          <div
            onClick={() => navigate('actions')}
            className="stat-panel group relative cursor-pointer overflow-hidden rounded-xl border bg-card p-5 shadow-xs transition-all hover:border-primary/50 hover:shadow-md hover:-translate-y-0.5"
            title="点击前往运营动作库查看已落地内容与互动留痕"
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium tracking-wide">真实动作产出</span>
              <div className="rounded-lg bg-emerald-500/10 p-2 text-emerald-500 transition-colors group-hover:bg-emerald-500/20">
                <Activity className="size-4" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <span className="text-3xl font-bold tracking-tight text-foreground tabular-nums">
                {kpis.total_actions}
                <span className="text-base font-normal text-muted-foreground ml-1">次落地</span>
              </span>
              <ArrowUpRight className="size-4 text-muted-foreground/50 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
            </div>
            <div className="mt-3 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                <span className="truncate">{kpis.posts_count} 篇发布 · {kpis.replies_count} 次回复</span>
              </div>
              <span className="text-[11px] font-medium text-primary flex items-center gap-0.5 opacity-80 group-hover:opacity-100 group-hover:underline shrink-0">
                动作库 <ChevronRight className="size-3" />
              </span>
            </div>
          </div>

          {/* KPI 4: 任务履约完成率 */}
          <div
            onClick={() => navigate('tasks')}
            className="stat-panel group relative cursor-pointer overflow-hidden rounded-xl border bg-card p-5 shadow-xs transition-all hover:border-primary/50 hover:shadow-md hover:-translate-y-0.5"
            title="点击前往任务管理查看计划履约进度"
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium tracking-wide">计划履约完成率</span>
              <div className="rounded-lg bg-purple-500/10 p-2 text-purple-500 transition-colors group-hover:bg-purple-500/20">
                <Target className="size-4" />
              </div>
            </div>
            <div className="mt-3 flex items-baseline justify-between">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold tracking-tight text-foreground tabular-nums">
                  {kpis.completion_rate}%
                </span>
                <span className="text-xs text-muted-foreground">
                  ({kpis.tasks_completed}/{kpis.tasks_total})
                </span>
              </div>
              <ArrowUpRight className="size-4 text-muted-foreground/50 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
            </div>
            <div className="mt-3 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="size-1.5 rounded-full bg-purple-500 shrink-0" />
                <span className="truncate">{kpis.pending_tasks_count} 项正在推进</span>
              </div>
              <span className="text-[11px] font-medium text-primary flex items-center gap-0.5 opacity-80 group-hover:opacity-100 group-hover:underline shrink-0">
                任务列表 <ChevronRight className="size-3" />
              </span>
            </div>
          </div>
        </div>

        {/* Tier 3: 效果可视化与标杆高光内容 */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-stretch">
          {/* 左侧 (7/12): 运营效果走势图 */}
          <div className="rounded-xl border bg-card p-5 shadow-xs lg:col-span-7 flex flex-col">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-2">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-foreground">运营效果趋势分析</h3>
                  <button
                    onClick={() => navigate('metrics', trendMetric === 'activity' ? 'execution' : 'content')}
                    className="text-xs text-primary hover:underline flex items-center gap-1 font-medium cursor-pointer"
                  >
                    {trendMetric === 'activity' ? '查看执行明细' : '查看内容数据'} <ArrowRight className="size-3" />
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  按时间周期追踪曝光量、互动与产出节奏
                </p>
              </div>
              <Tabs value={trendMetric} onValueChange={v => setTrendMetric(v as any)}>
                <TabsList className="h-8">
                  <TabsTrigger value="views" className="text-xs px-2.5">曝光趋势</TabsTrigger>
                  <TabsTrigger value="engagements" className="text-xs px-2.5">互动表现</TabsTrigger>
                  <TabsTrigger value="activity" className="text-xs px-2.5">产出节奏</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* 图表展示区：100% 撑满父级剩余空间 */}
            <div className="w-full flex-1 flex flex-col pt-3 min-h-[260px]">
              <TrendChart trends={trends} metric={trendMetric} />
            </div>
          </div>

          {/* 右侧 (5/12): 标杆高光内容 */}
          <div className="rounded-xl border bg-card p-5 shadow-xs lg:col-span-5 flex flex-col">
            <div className="flex items-center justify-between mb-3.5">
              <div>
                <h3 className="font-semibold text-foreground">标杆高光内容 Top 4</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  产生最大曝光与转评赞的优质内容
                </p>
              </div>
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-primary" onClick={() => navigate('actions')}>
                查看全部 <ArrowRight className="size-3.5 ml-1" />
              </Button>
            </div>

            <div className="flex-1 flex flex-col divide-y divide-border/60">
              {topActions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
                  <BarChart3 className="size-8 stroke-1 mb-2 opacity-50" />
                  <p className="text-sm">暂无内容数据</p>
                </div>
              ) : (
                topActions.map((action, idx) => (
                  <div key={action.id} className="py-3 first:pt-1 last:pb-1 flex items-start justify-between gap-3 group">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="flex size-4 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                          {idx + 1}
                        </span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                          {actionTypeLabel(action.action_type)}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground">
                          {action.occurred_at ? displayDate(action.occurred_at) : ''}
                        </span>
                      </div>
                      <p
                        onClick={() => navigate('actions', action.id)}
                        className="text-xs font-medium text-foreground line-clamp-2 hover:text-primary cursor-pointer transition-colors"
                        title={action.title}
                      >
                        {action.title}
                      </p>
                    </div>

                    <div className="flex flex-col items-end shrink-0 gap-1 text-right">
                      <span className="text-sm font-bold text-foreground tabular-nums">
                        {action.views} <span className="text-[10px] font-normal text-muted-foreground">阅读</span>
                      </span>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        {action.engagements > 0 && (
                          <span className="text-orange-500 font-medium">🔥 {action.engagements} 互动</span>
                        )}
                        {action.evidence_url && (
                          <a
                            href={action.evidence_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                            title="查看外部推文"
                            onClick={e => e.stopPropagation()}
                          >
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Tier 4: 执行待办推进 & 战略复盘结论 */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* 左侧 (6/12): 近期待办推进清单 */}
          <div className="rounded-xl border bg-card p-5 shadow-xs lg:col-span-6 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="rounded-lg bg-purple-500/10 p-1.5 text-purple-500">
                  <ListChecks className="size-4" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">近期待办推进清单</h3>
                  <p className="text-xs text-muted-foreground">进行中与计划执行的关键任务</p>
                </div>
              </div>
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-primary" onClick={() => navigate('tasks')}>
                任务管理 <ArrowRight className="size-3.5 ml-1" />
              </Button>
            </div>

            <div className="flex-1 flex flex-col divide-y divide-border/60">
              {upcomingTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
                  <CheckCircle2 className="size-8 stroke-1 mb-2 text-emerald-500/70" />
                  <p className="text-sm font-medium text-foreground">所有计划均已推进完成</p>
                  <p className="text-xs text-muted-foreground mt-1">当前没有临期或待执行的任务阻碍</p>
                </div>
              ) : (
                upcomingTasks.map(task => {
                  const d = (task.data || {}) as Record<string, any>
                  const dueAt = typeof d.due_at === 'string' ? d.due_at : undefined
                  const criteria = typeof d.acceptance_criteria === 'string' ? d.acceptance_criteria : undefined
                  return (
                    <div
                      key={task.id}
                      onClick={() => navigate('tasks', task.id)}
                      className="py-3 flex items-start justify-between gap-3 group cursor-pointer hover:bg-muted/30 rounded-lg px-2 -mx-2 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 text-purple-600 border-purple-500/30 bg-purple-500/10">
                            {task.status === 'in_progress' ? '进行中' : '计划中'}
                          </Badge>
                          {dueAt && (
                            <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                              <Clock className="size-3" />
                              {displayDate(dueAt)}
                            </span>
                          )}
                        </div>
                        <p className="text-xs font-medium text-foreground line-clamp-1 group-hover:text-primary transition-colors">
                          {task.title}
                        </p>
                        {criteria && (
                          <p className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">
                            标准：{criteria}
                          </p>
                        )}
                      </div>
                      <ArrowRight className="size-4 text-muted-foreground/40 group-hover:text-primary transition-transform group-hover:translate-x-0.5 shrink-0 mt-2" />
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* 右侧 (6/12): 最新战略复盘与决策结论 */}
          <div className="rounded-xl border bg-card p-5 shadow-xs lg:col-span-6 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="rounded-lg bg-emerald-500/10 p-1.5 text-emerald-500">
                  <Workflow className="size-4" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">最新复盘与决策结论</h3>
                  <p className="text-xs text-muted-foreground">客观归因、经验留痕与下一步战略</p>
                </div>
              </div>
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-primary" onClick={() => navigate('reviews')}>
                复盘归因 <ArrowRight className="size-3.5 ml-1" />
              </Button>
            </div>

            {latestReview ? (() => {
              const rData = (latestReview.data || {}) as Record<string, any>
              const keepText = String(rData.keep || rData.facts || '数据验证良好，互动机制起效。')
              const changeText = String(rData.change || rData.hypothesis || '需进一步补充真实真机产品演示。')
              const nextStepsText = String(rData.next_steps || '继续按照既定 SOP 推进外食场景深度评测')
              return (
                <div className="flex-1 flex flex-col justify-between gap-3 rounded-lg bg-muted/20 p-4 border border-border/70">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-xs font-semibold text-foreground line-clamp-1">
                        {latestReview.title}
                      </span>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {displayDate(latestReview.updated_at)}
                      </span>
                    </div>

                    <div className="space-y-2 text-xs">
                      {/* Keep / Facts */}
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                          优势
                        </span>
                        <p className="text-muted-foreground line-clamp-2">
                          {keepText}
                        </p>
                      </div>

                      {/* Change / Hypothesis */}
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400">
                          优化
                        </span>
                        <p className="text-muted-foreground line-clamp-2">
                          {changeText}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Next Steps (核心动作标出) */}
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 mt-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-1">
                      <Compass className="size-3.5" />
                      <span>下一步战略落地</span>
                    </div>
                    <p className="text-xs text-foreground font-medium line-clamp-2">
                      {nextStepsText}
                    </p>
                  </div>
                </div>
              )
            })() : (
              <div className="flex-1 flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
                <Workflow className="size-8 stroke-1 mb-2 opacity-50" />
                <p className="text-sm">暂无复盘沉淀记录</p>
                <p className="text-xs text-muted-foreground mt-1">
                  完成阶段性动作后，在复盘归因中沉淀经验。
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}

// 轻量原生响应式 SVG 趋势图表（无抖动、流畅跟随与高质感浮层 Tooltip）
function TrendChart({
  trends,
  metric,
}: {
  trends: DailyTrendPoint[]
  metric: 'views' | 'engagements' | 'activity'
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  if (!trends.length) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-center text-muted-foreground">
        <p className="text-xs">暂无连续趋势数据</p>
      </div>
    )
  }

  const dataValues = trends.map(t => {
    if (metric === 'views') return t.views
    if (metric === 'engagements') return t.engagements
    return t.posts + t.replies
  })

  const maxVal = Math.max(...dataValues, 5)
  const chartHeight = 220
  const chartWidth = 600

  const points = dataValues.map((v, i) => {
    const x = 35 + (i / Math.max(trends.length - 1, 1)) * (chartWidth - 65)
    const y = chartHeight - (v / maxVal) * (chartHeight - 45) - 15
    return { x, y, value: v, date: trends[i].date }
  })

  const polylineStr = points.map(p => `${p.x},${p.y}`).join(' ')

  const colorStroke =
    metric === 'views'
      ? 'var(--color-blue-500, #3b82f6)'
      : metric === 'engagements'
      ? 'var(--color-orange-500, #f97316)'
      : 'var(--color-emerald-500, #10b981)'

  const activePoint = hoverIndex !== null && points[hoverIndex] ? points[hoverIndex] : null

  // 处理鼠标移动，统一在 SVG 层根据 X 轴坐标吸附最近数据点，保证 0 抖动与顺滑捕捉
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (!rect.width) return
    const mouseX = ((e.clientX - rect.left) / rect.width) * chartWidth
    let closestIdx = 0
    let minDist = Infinity
    points.forEach((p, idx) => {
      const dist = Math.abs(p.x - mouseX)
      if (dist < minDist) {
        minDist = dist
        closestIdx = idx
      }
    })
    setHoverIndex(closestIdx)
  }

  const handleMouseLeave = () => {
    setHoverIndex(null)
  }

  return (
    <div className="relative w-full h-full flex-1 flex flex-col justify-between min-h-[220px]">
      {/* 浮动交互 Tooltip 卡片 */}
      {activePoint && (
        <div
          className="pointer-events-none absolute z-30 flex flex-col gap-1 rounded-lg border bg-popover/95 px-3 py-2 text-xs shadow-xl backdrop-blur-md transition-all duration-75"
          style={{
            left: `${(activePoint.x / chartWidth) * 100}%`,
            top: `${(activePoint.y / (chartHeight + 25)) * 100}%`,
            transform:
              activePoint.x < 100
                ? 'translate(10%, -110%)'
                : activePoint.x > chartWidth - 100
                ? 'translate(-90%, -110%)'
                : 'translate(-50%, -115%)',
          }}
        >
          <div className="flex items-center justify-between gap-4 font-semibold text-foreground">
            <span>{activePoint.date}</span>
            <span className="text-[10px] font-mono text-muted-foreground uppercase">
              {metric === 'views' ? '曝光' : metric === 'engagements' ? '互动' : '动作'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: colorStroke }} />
            {metric === 'views' && <span>{activePoint.value.toLocaleString()} 曝光阅读</span>}
            {metric === 'engagements' && <span>{activePoint.value.toLocaleString()} 总互动量</span>}
            {metric === 'activity' && (
              <span>
                {activePoint.value} 次落地 ({trends[hoverIndex!].posts} 篇内容 · {trends[hoverIndex!].replies} 条互动)
              </span>
            )}
          </div>
        </div>
      )}

      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight + 25}`}
        className="w-full h-full min-h-[220px] flex-1 overflow-visible cursor-crosshair"
        role="img"
        aria-label="运营效果趋势图"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* 背景辅助水平刻度线 */}
        <line x1="30" y1="20" x2={chartWidth - 20} y2="20" stroke="currentColor" strokeDasharray="3 3" className="text-border/40 pointer-events-none" />
        <line x1="30" y1={chartHeight * 0.35} x2={chartWidth - 20} y2={chartHeight * 0.35} stroke="currentColor" strokeDasharray="3 3" className="text-border/30 pointer-events-none" />
        <line x1="30" y1={chartHeight * 0.7} x2={chartWidth - 20} y2={chartHeight * 0.7} stroke="currentColor" strokeDasharray="3 3" className="text-border/30 pointer-events-none" />
        <line x1="30" y1={chartHeight} x2={chartWidth - 20} y2={chartHeight} stroke="currentColor" className="text-border pointer-events-none" />

        {/* Y 轴刻度文字 */}
        <text x="5" y="24" fontSize="10" fill="currentColor" className="text-muted-foreground/70 pointer-events-none">{maxVal}</text>
        <text x="5" y={chartHeight * 0.5 + 3} fontSize="10" fill="currentColor" className="text-muted-foreground/70 pointer-events-none">{Math.round(maxVal / 2)}</text>
        <text x="5" y={chartHeight + 3} fontSize="10" fill="currentColor" className="text-muted-foreground/70 pointer-events-none">0</text>

        {/* 活跃指示辅助垂直线 */}
        {activePoint && (
          <line
            x1={activePoint.x}
            y1="15"
            x2={activePoint.x}
            y2={chartHeight}
            stroke="currentColor"
            strokeDasharray="3 3"
            strokeWidth="1.5"
            className="text-foreground/40 pointer-events-none"
          />
        )}

        {/* 柱状或折线 */}
        {metric === 'activity' ? (
          points.map((p, i) => {
            const barW = Math.min(24, Math.max(12, (chartWidth - 60) / (trends.length * 1.5)))
            const barH = chartHeight - p.y
            const isHovered = hoverIndex === i
            return (
              <g key={i} className="pointer-events-none">
                <rect
                  x={p.x - barW / 2}
                  y={p.y}
                  width={barW}
                  height={Math.max(barH, 2)}
                  rx="3"
                  fill={colorStroke}
                  opacity={isHovered ? 1 : 0.8}
                />
              </g>
            )
          })
        ) : (
          <>
            {/* 渐变填充 */}
            <defs>
              <linearGradient id={`grad-${metric}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colorStroke} stopOpacity="0.28" />
                <stop offset="100%" stopColor={colorStroke} stopOpacity="0.0" />
              </linearGradient>
            </defs>
            <polygon
              points={`35,${chartHeight} ${polylineStr} ${points[points.length - 1].x},${chartHeight}`}
              fill={`url(#grad-${metric})`}
              className="pointer-events-none"
            />
            {/* 折线主体 */}
            <polyline
              points={polylineStr}
              fill="none"
              stroke={colorStroke}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="pointer-events-none"
            />
            {/* 数据圆点 */}
            {points.map((p, i) => {
              const isHovered = hoverIndex === i
              return (
                <g key={i} className="pointer-events-none">
                  {isHovered && (
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r="8"
                      fill={colorStroke}
                      opacity="0.25"
                    />
                  )}
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={isHovered ? 5 : 3.5}
                    fill={isHovered ? '#ffffff' : colorStroke}
                    stroke={colorStroke}
                    strokeWidth={isHovered ? 2.5 : 0}
                  />
                </g>
              )
            })}
          </>
        )}

        {/* 底部时间轴标签 */}
        {points.length > 0 && (
          <g className="pointer-events-none">
            <text x="35" y={chartHeight + 20} fontSize="10" fill="currentColor" className="text-muted-foreground/70" textAnchor="start">
              {points[0].date.slice(5)}
            </text>
            {points.length > 2 && (
              <text x={chartWidth / 2} y={chartHeight + 20} fontSize="10" fill="currentColor" className="text-muted-foreground/70" textAnchor="middle">
                {points[Math.floor(points.length / 2)].date.slice(5)}
              </text>
            )}
            <text x={chartWidth - 25} y={chartHeight + 20} fontSize="10" fill="currentColor" className="text-muted-foreground/70" textAnchor="end">
              {points[points.length - 1].date.slice(5)}
            </text>
          </g>
        )}
      </svg>
    </div>
  )
}
