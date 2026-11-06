'use client'

import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import type {FocusEvent,KeyboardEvent,MouseEvent,ReactNode} from 'react'
import {Popover} from 'radix-ui'
import {ChevronLeft,ChevronRight,Clock,ExternalLink,RefreshCw,Search,Table2,Upload} from 'lucide-react'
import {PlatformIcon} from '@/components/platform-icon'
import {ProductIcon} from '@/components/product-icon'
import {ResourcePage} from '@/components/resource-page'
import {PageHeader} from '@/components/page-header'
import {Button} from '@/components/ui/button'
import {Badge} from '@/components/ui/badge'
import {Input} from '@/components/ui/input'
import {Collapsible,CollapsibleContent,CollapsibleTrigger} from '@/components/ui/collapsible'
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select'
import {Skeleton} from '@/components/ui/skeleton'
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table'
import {Tabs,TabsList,TabsTrigger} from '@/components/ui/tabs'
import {Tooltip,TooltipContent,TooltipProvider,TooltipTrigger} from '@/components/ui/tooltip'
import type {Api,OpsRecord,RecordPage,ResourceName} from '@/lib/types'
import {actionTypeLabel,displayDate,queryString,statusLabels} from '@/lib/resources'
import {accountPlatform} from '@/lib/account-label'

type OperationsDataProps={api:Api;accountId:string;revision?:number;onChanged:()=>void;onNavigate:(resource:ResourceName,id?:string)=>void;selectedId?:string;onSelected?:()=>void}
type ExecutionItem={date:string;posts:number;replies:number;other_actions:number;completed_tasks:number|null;content_count:number;deleted_posts?:number}
type Summary={recorded_posts?:number;recorded_replies?:number;other_actions?:number;content_count?:number;raw_metric_count?:number;metric_rule?:string;undated_completed_tasks?:number;window?:ContentWindow;window_label?:string;window_hours?:number|null}
type ReportBase<T>={items:T[];total:number;limit:number;offset:number;as_of?:string;summary?:Summary;chart_data?:ChartData}
type ContentMetric={value:number|null;availability?:string;observed_at?:string;precision?:string;metric_id?:string;actual_age_hours?:number|null;window_quality?:string}
type ContentItem={id:string;title:string;account_id:string|null;product_id:string|null;action_type?:string|null;occurred_at?:string|null;occurred_on?:string|null;evidence_url?:string|null;publication_state?:string|null;content_id?:string|null;window?:ContentWindow;window_label?:string;window_hours?:number|null;window_status?:string|null;metrics?:{views?:ContentMetric|null;likes?:ContentMetric|null;replies?:ContentMetric|null;bookmarks?:ContentMetric|null};latest_metrics?:{views?:ContentMetric|null;likes?:ContentMetric|null;replies?:ContentMetric|null;bookmarks?:ContentMetric|null}}
type ExecutionReport=ReportBase<ExecutionItem>
type ContentReport=ReportBase<ContentItem>
type ChartData={daily_activity?:Array<{date:string;posts:number;replies:number;completed_tasks?:number|null;other_actions?:number}>;top_content?:Array<{id:string;title:string;action_type?:string|null;views:number|null;product_id?:string|null;window_status?:string|null}>;extent?:{from?:string|null;to?:string|null;truncated?:boolean};window?:ContentWindow}
type Relations=Partial<Record<ResourceName,OpsRecord[]>>
type ReportView='execution'|'content'
type ActionTypeFilter='all'|'publish'|'reply'
type ContentWindow='24h'|'72h'|'7d'|'latest'

const PAGE_SIZE=10
const emptyExecution=():ExecutionReport=>({items:[],total:0,limit:PAGE_SIZE,offset:0})
const emptyContent=():ContentReport=>({items:[],total:0,limit:PAGE_SIZE,offset:0})

function classNames(...values:Array<string|false|undefined|null>){return values.filter(Boolean).join(' ')}
function dateLabel(value:string|null|undefined){return value?value.replaceAll('-','/'):'未记录'}
function metricNumber(value:number|null|undefined){return typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('zh-CN'):'—'}
function shortTitle(value:string,max=96){return value.length>max?`${value.slice(0,max)}...`:value}
function statusText(value:string|undefined|null){return value?statusLabels[value]||value:'未记录'}
function countText(value:number|null|undefined){return typeof value==='number'?value.toLocaleString('zh-CN'):'—'}
function formatContentMetric(metric:ContentMetric|null|undefined,fallbackMetric?:ContentMetric|null|undefined){
 if(metric&&(!metric.availability||metric.availability==='valid')&&typeof metric.value==='number')return metricNumber(metric.value)
 if(fallbackMetric&&(!fallbackMetric.availability||fallbackMetric.availability==='valid')&&typeof fallbackMetric.value==='number'){
  return `~${metricNumber(fallbackMetric.value)}`
 }
 return '—'
}
function contentDate(item:ContentItem){if(item.occurred_at)return displayDate(item.occurred_at);if(item.occurred_on)return dateLabel(item.occurred_on);return '未记录'}
function contentMetricTip(metric:ContentMetric|null|undefined,fallbackMetric?:ContentMetric|null|undefined,windowLabel?:string){
 if(metric?.observed_at){
  const age=typeof metric.actual_age_hours==='number'?`，距发布约 ${metric.actual_age_hours.toFixed(1)} 小时`:''
  return `${windowLabel||'观测'}：${displayDate(metric.observed_at,metric.precision)}${age}`
 }
 if(fallbackMetric?.observed_at){
  const age=typeof fallbackMetric.actual_age_hours==='number'?`，距发布约 ${fallbackMetric.actual_age_hours.toFixed(1)} 小时`:''
  return `${windowLabel||'当前窗口'}未采集命中；显示最新累计快照：${metricNumber(fallbackMetric.value)}（观测于 ${displayDate(fallbackMetric.observed_at,fallbackMetric.precision)}${age}）`
 }
 return `${windowLabel||'当前窗口'}：未采集`
}

async function fetchAll(api:Api,resource:ResourceName,params:Record<string,string|number|undefined|null>={}){
 const items:OpsRecord[]=[]
 let offset=0
 for(;;){
  const page=await api<RecordPage>(`/${resource}${queryString({...params,limit:200,offset})}`)
  items.push(...page.items)
  offset+=page.limit
  if(items.length>=page.total||page.items.length===0)break
 }
 return items
}

export function OperationsData({api,accountId,revision,onChanged,onNavigate,selectedId,onSelected}:OperationsDataProps){
 const isTabNav = selectedId === 'content' || selectedId === 'execution'
 const [rawMode,setRawMode]=useState(Boolean(selectedId && !isTabNav))
 const [view,setView]=useState<ReportView>(selectedId === 'content' ? 'content' : 'execution')
 const [contentWindow,setContentWindow]=useState<ContentWindow>('latest')
 const [query,setQuery]=useState('')
 const [productFilter,setProductFilter]=useState('all')
 const [typeFilter,setTypeFilter]=useState<ActionTypeFilter>('all')
 const [dateFrom,setDateFrom]=useState('')
 const [dateTo,setDateTo]=useState('')
 const [execution,setExecution]=useState<ExecutionReport>(()=>emptyExecution())
 const [content,setContent]=useState<ContentReport>(()=>emptyContent())
 const [relations,setRelations]=useState<Relations>({})
 const [loading,setLoading]=useState(false)
 const [hasLoaded,setHasLoaded]=useState(false)
 const [error,setError]=useState('')
 const [importing,setImporting]=useState(false)
 const [importMessage,setImportMessage]=useState<string|null>(null)
 const fileInputRef=useRef<HTMLInputElement>(null)
 const requestGeneration=useRef(0)
 const relationGeneration=useRef(0)
 const reportAccountRef=useRef(accountId)

 useEffect(()=>{
  if(selectedId === 'content'){
   setView('content')
   setRawMode(false)
  }else if(selectedId === 'execution'){
   setView('execution')
   setRawMode(false)
  }else if(selectedId){
   queueMicrotask(()=>setRawMode(true))
  }
 },[selectedId])
 useEffect(()=>{if(importMessage){const t=setTimeout(()=>setImportMessage(null),6000);return()=>clearTimeout(t)}},[importMessage])
 const loadRelations=useCallback(async()=>{
  const generation=++relationGeneration.current
  try{
   const [accounts,products,platforms]=await Promise.all([fetchAll(api,'accounts'),fetchAll(api,'products'),fetchAll(api,'platforms')])
   if(generation===relationGeneration.current)setRelations({accounts,products,platforms})
  }catch{if(generation===relationGeneration.current)setRelations({})}
 },[api])
 useEffect(()=>{queueMicrotask(()=>{void loadRelations()})},[loadRelations,revision])

 const currentReport:ExecutionReport|ContentReport=view==='execution'?execution:content
 const summary=currentReport.summary||{}
 const products=useMemo(()=>relations.products||[],[relations.products])
 const accounts=useMemo(()=>relations.accounts||[],[relations.accounts])
 const platforms=useMemo(()=>relations.platforms||[],[relations.platforms])

 const loadReport=useCallback(async(nextOffset=0)=>{
  const generation=++requestGeneration.current
  if(reportAccountRef.current!==accountId){
   reportAccountRef.current=accountId
   setExecution(emptyExecution());setContent(emptyContent());setHasLoaded(false)
  }
  setLoading(true);setError('')
  try{
   const params={view,window:view==='content'?contentWindow:undefined,account_id:accountId,product_id:productFilter==='all'?undefined:productFilter,type:view==='content'&&typeFilter!=='all'?typeFilter:undefined,q:query||undefined,date_from:dateFrom||undefined,date_to:dateTo||undefined,limit:PAGE_SIZE,offset:nextOffset}
   const report=await api<ExecutionReport|ContentReport>(`/reports/operations${queryString(params)}`)
   if(generation!==requestGeneration.current)return
   if(view==='execution')setExecution(report as ExecutionReport)
   if(view==='content')setContent(report as ContentReport)
   setHasLoaded(true)
  }catch(err){if(generation===requestGeneration.current)setError(err instanceof Error?err.message:'运营数据加载失败')}
  finally{if(generation===requestGeneration.current)setLoading(false)}
 },[accountId,api,contentWindow,dateFrom,dateTo,productFilter,query,typeFilter,view])
 useEffect(()=>{queueMicrotask(()=>{void loadReport(0)})},[loadReport,revision])
 const resetAndLoad=useCallback(()=>{void loadReport(0)},[loadReport])
 const handleFileImport=useCallback(async(event:React.ChangeEvent<HTMLInputElement>)=>{
  const file=event.target.files?.[0]
  if(!file)return
  setImporting(true)
  setError('')
  setImportMessage(null)
  try{
   const text=await file.text()
   const res=await api<{ok:boolean;actions_created?:number;metrics_created?:number;total_processed?:number}>('/import/twitter',{
    method:'POST',
    body:JSON.stringify({csv:text,account_id:accountId}),
   })
   if(res.ok){
    setImportMessage(`成功导入 ${res.total_processed||0} 条推文记录（新增动作 ${res.actions_created||0}，快照 ${res.metrics_created||0}）`)
    setTimeout(()=>setImportMessage(null),6000)
    void loadReport(0)
    onChanged?.()
   }
  }catch(err){
   setError(err instanceof Error?err.message:'导入 Twitter CSV 失败')
  }finally{
   setImporting(false)
   if(fileInputRef.current)fileInputRef.current.value=''
  }
 },[accountId,api,loadReport,onChanged])
 const switchView=useCallback((next:ReportView)=>{setLoading(true);setHasLoaded(Boolean((next==='execution'?execution:content).as_of));setView(next)},[content,execution])
 const exitRawMode=useCallback(()=>{const event=new Event('ops-before-navigate',{cancelable:true});if(!window.dispatchEvent(event))return;setRawMode(false);onSelected?.()},[onSelected])
 const pageStart=currentReport.total===0?0:currentReport.offset+1
 const pageEnd=Math.min(currentReport.offset+currentReport.items.length,currentReport.total)

 const renderTarget=useCallback((productId:string|null,recordAccountId:string|null)=>{
  const product=productId?products.find(item=>item.id===productId):null
  const account=accounts.find(item=>item.id===(recordAccountId||accountId))
  const title=product?.title||account?.title||'未关联对象'
  return <span className="inline-flex max-w-full items-center gap-2" title={title}>{productId?<ProductIcon api={api} productId={productId} revision={revision} size={22}/>:account?<PlatformIcon name={accountPlatform(account,platforms)}/>:null}<span className="truncate">{title}</span></span>
 },[accountId,accounts,api,platforms,products,revision])

 if(rawMode){
  return <section className="records-page flex min-h-0 flex-1 flex-col gap-5"><div className="flex justify-end"><Button variant="outline" onClick={exitRawMode} className="gap-2"><Table2 className="size-4" />返回运营报表</Button></div><ResourcePage resource="metrics" api={api} accountId={accountId} revision={revision} selectedId={selectedId} onSelected={onSelected||(()=>{})} onChanged={onChanged} onNavigate={(route,id)=>onNavigate(route as ResourceName,id)} /></section>
 }

 return <TooltipProvider><section className="records-page flex min-h-0 flex-1 flex-col gap-5">
  <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleFileImport} />
  <PageHeader title="运营数据" description={view==='execution'?'每天做了什么：发帖、发出回复、其他动作和有明确完成时间的任务。':'逐条查看内容在指定观测窗口内的表现，固定窗口不会自动用最新累计补位。'} eyebrow={`${currentReport.total} ${view==='content'?'条内容':'天'}`} actions={<><Button variant="outline" onClick={()=>fileInputRef.current?.click()} disabled={importing||loading} className="gap-2"><Upload className={classNames('size-4',importing&&'animate-pulse')} />{importing?'正在导入...':'导入 Twitter CSV'}</Button><Button variant="outline" size="icon" aria-label="刷新" onClick={()=>loadReport(currentReport.offset)} disabled={loading}><RefreshCw className={classNames('size-4',loading&&'animate-spin')} /></Button><Button variant="outline" onClick={()=>setRawMode(true)} className="gap-2"><Table2 className="size-4" />原始记录</Button></>} />
  {importMessage&&<div role="status" className="rounded-lg border border-emerald-300/80 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 shadow-sm dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{importMessage}</div>}
  <div className="surface records-table records-card">
   <div className="records-toolbar"><div className="compact-filter-row">
    <div className="relative filter-search"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="搜索记录" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')resetAndLoad()}} placeholder="搜索记录..." className="pl-9" /></div>
    <Select value={productFilter} onValueChange={setProductFilter}><SelectTrigger aria-label="产品筛选" className="filter-product"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部产品</SelectItem>{products.map(product=><SelectItem key={product.id} value={product.id}>{product.title}</SelectItem>)}</SelectContent></Select>
    {view==='content'&&<Select value={typeFilter} onValueChange={value=>setTypeFilter(value as ActionTypeFilter)}><SelectTrigger aria-label="动作类型筛选" className="filter-select"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部动作</SelectItem><SelectItem value="publish">发布内容</SelectItem><SelectItem value="reply">发出回复</SelectItem></SelectContent></Select>}
    {view==='content'&&<Select value={contentWindow} onValueChange={value=>setContentWindow(value as ContentWindow)}><SelectTrigger aria-label="观测窗口" className="filter-select"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="24h">24 小时</SelectItem><SelectItem value="72h">72 小时</SelectItem><SelectItem value="7d">7 天</SelectItem><SelectItem value="latest">最新累计</SelectItem></SelectContent></Select>}
    <Collapsible className="contents"><CollapsibleTrigger asChild><Button type="button" variant="outline" className="gap-2"><Clock className="size-4" />时间范围</Button></CollapsibleTrigger><CollapsibleContent className="compact-filter-row basis-full pt-3"><Input className="filter-datetime" type="date" value={dateFrom} onChange={event=>setDateFrom(event.target.value)} aria-label="开始日期" /><span className="filter-date-separator" aria-hidden="true">至</span><Input className="filter-datetime" type="date" value={dateTo} onChange={event=>setDateTo(event.target.value)} aria-label="结束日期" /></CollapsibleContent></Collapsible>
    <Button variant="secondary" onClick={resetAndLoad}>筛选</Button>
   </div></div>
   <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3"><Tabs value={view} onValueChange={value=>switchView(value as ReportView)}><TabsList><TabsTrigger value="execution">每日执行</TabsTrigger><TabsTrigger value="content">内容表现</TabsTrigger></TabsList></Tabs><div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span>发帖 {summary.recorded_posts??'—'}</span><span>发出回复 {summary.recorded_replies??'—'}</span><span>内容 {summary.content_count??'—'}</span></div></div>
   <OperationsCharts view={view} chartData={currentReport.chart_data} renderTarget={renderTarget} onShowLatest={()=>{setContentWindow('latest');switchView('content')}} />
   {error&&<div role="alert" className="border-b px-5 py-3 text-sm text-destructive">{error}</div>}
   <span role="status" className="sr-only">{loading?(hasLoaded?'正在更新报表':'正在加载报表'):''}</span>
    <div className="border-b px-5 py-3"><h2 className="text-base font-semibold">{view==='execution'?'每日执行 · 一天一行':'内容明细 · 一条帖子或回复一行'}</h2><p className="mt-1 text-sm text-muted-foreground">{view==='execution'?'这里统计动作发生时间；没有实际完成时间的历史任务显示为未知。':'固定窗口采集容差为 ±30 分钟；未命中精准窗口时自动展示带有波浪号 (~) 的最新累计参考。'}</p></div>
   {view==='execution'&&<ExecutionTable report={execution} loading={loading} hasLoaded={hasLoaded}/>}
   {view==='content'&&<ContentTable report={content} loading={loading} hasLoaded={hasLoaded} renderTarget={renderTarget} onNavigate={onNavigate}/>}
   <div className="table-footer"><span>{currentReport.total===0?'共 0 条记录':`第 ${pageStart}-${pageEnd} 条，共 ${currentReport.total} 条`}</span><div className="flex gap-2"><Button variant="outline" size="sm" onClick={()=>loadReport(Math.max(0,currentReport.offset-PAGE_SIZE))} disabled={currentReport.offset<=0||loading}><ChevronLeft className="size-4" />上一页</Button><Button variant="outline" size="sm" onClick={()=>loadReport(currentReport.offset+PAGE_SIZE)} disabled={currentReport.offset+PAGE_SIZE>=currentReport.total||loading}>下一页<ChevronRight className="size-4" /></Button></div></div>
  </div>
 </section></TooltipProvider>
}

function ExecutionTable({report,loading,hasLoaded}:{report:ExecutionReport;loading:boolean;hasLoaded:boolean}){
 return <Table aria-busy={loading} className="resource-table" style={{minWidth:860}}><colgroup><col style={{width:160}}/><col style={{width:130}}/><col style={{width:130}}/><col style={{width:130}}/><col style={{width:150}}/><col style={{width:160}}/></colgroup><TableHeader><TableRow className="bg-muted/60"><TableHead className="frozen-title">日期</TableHead><TableHead>发帖</TableHead><TableHead>发出回复</TableHead><TableHead>其他动作</TableHead><TableHead>完成任务</TableHead><TableHead>内容记录</TableHead></TableRow></TableHeader><TableBody>{loading&&!hasLoaded&&Array.from({length:PAGE_SIZE}).map((_,index)=><TableRow key={index}><TableCell colSpan={6}><Skeleton className="h-8 w-full" /></TableCell></TableRow>)}{hasLoaded&&report.items.length===0&&<TableRow><TableCell colSpan={6} className="table-empty-cell">暂无记录</TableCell></TableRow>}{report.items.map(item=><TableRow key={item.date} className="hover:bg-muted"><TableCell className="frozen-title font-medium">{dateLabel(item.date)}</TableCell><TableCell>{item.posts}{item.deleted_posts?<Badge variant="outline" className="ml-2 rounded-md">删 {item.deleted_posts}</Badge>:null}</TableCell><TableCell>{item.replies}</TableCell><TableCell>{item.other_actions}</TableCell><TableCell>{countText(item.completed_tasks)}</TableCell><TableCell>{item.content_count}</TableCell></TableRow>)}</TableBody></Table>
}

function ContentTable({report,loading,hasLoaded,renderTarget,onNavigate}:{report:ContentReport;loading:boolean;hasLoaded:boolean;renderTarget:(productId:string|null,accountId:string|null)=>ReactNode;onNavigate:(resource:ResourceName,id?:string)=>void}){
 const metricCell=(metric:ContentMetric|null|undefined,fallbackMetric:ContentMetric|null|undefined,windowLabel?:string)=>{
  const isFallback=!metric&&Boolean(fallbackMetric&&typeof fallbackMetric.value==='number')
  return <Tooltip delayDuration={250}><TooltipTrigger asChild><span tabIndex={0} className={classNames('block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',isFallback&&'text-muted-foreground/80 italic')}>{formatContentMetric(metric,fallbackMetric)}</span></TooltipTrigger><TooltipContent>{contentMetricTip(metric,fallbackMetric,windowLabel)}</TooltipContent></Tooltip>
 }
 return <Table aria-busy={loading} className="resource-table" style={{minWidth:1380}}><colgroup><col style={{width:300}}/><col style={{width:120}}/><col style={{width:210}}/><col style={{width:140}}/><col style={{width:140}}/><col style={{width:110}}/><col style={{width:110}}/><col style={{width:110}}/><col style={{width:110}}/><col style={{width:120}}/><col style={{width:110}}/></colgroup><TableHeader><TableRow className="bg-muted/60"><TableHead className="frozen-title">标题</TableHead><TableHead>动作类型</TableHead><TableHead>运营对象</TableHead><TableHead>发布时间</TableHead><TableHead>采集时间</TableHead><TableHead>浏览</TableHead><TableHead>点赞</TableHead><TableHead>收到回复</TableHead><TableHead>收藏</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{loading&&!hasLoaded&&Array.from({length:PAGE_SIZE}).map((_,index)=><TableRow key={index}><TableCell colSpan={11}><Skeleton className="h-8 w-full" /></TableCell></TableRow>)}{hasLoaded&&report.items.length===0&&<TableRow><TableCell colSpan={11} className="table-empty-cell">当前窗口暂无记录</TableCell></TableRow>}{report.items.map(item=>{const observed=item.metrics?.views?.observed_at||item.metrics?.likes?.observed_at||item.metrics?.replies?.observed_at||item.metrics?.bookmarks?.observed_at||item.latest_metrics?.views?.observed_at||item.latest_metrics?.likes?.observed_at||item.latest_metrics?.replies?.observed_at||item.latest_metrics?.bookmarks?.observed_at;return <TableRow key={item.id} className="hover:bg-muted"><TableCell className="frozen-title"><Tooltip delayDuration={250}><TooltipTrigger asChild><span tabIndex={0} className="block truncate rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">{item.title}</span></TooltipTrigger><TooltipContent className="record-full-text" side="bottom" align="start" sideOffset={8}>{item.title}</TooltipContent></Tooltip></TableCell><TableCell>{actionTypeLabel(item.action_type||'')}</TableCell><TableCell className="text-sm text-secondary-foreground">{renderTarget(item.product_id,item.account_id)}</TableCell><TableCell className="text-sm text-secondary-foreground">{contentDate(item)}</TableCell><TableCell className="text-sm text-secondary-foreground">{observed?displayDate(observed,item.metrics?.views?.precision||item.latest_metrics?.views?.precision):'—'}</TableCell><TableCell>{metricCell(item.metrics?.views,item.latest_metrics?.views,item.window_label)}</TableCell><TableCell>{metricCell(item.metrics?.likes,item.latest_metrics?.likes,item.window_label)}</TableCell><TableCell>{metricCell(item.metrics?.replies,item.latest_metrics?.replies,item.window_label)}</TableCell><TableCell>{metricCell(item.metrics?.bookmarks,item.latest_metrics?.bookmarks,item.window_label)}</TableCell><TableCell><Badge data-status={item.publication_state||undefined} variant="secondary" className="rounded-md">{statusText(item.publication_state)}</Badge></TableCell><TableCell><div className="flex items-center gap-2"><Button variant="outline" size="sm" onClick={()=>onNavigate('actions',item.id)}>查看动作</Button>{item.evidence_url&&<Button asChild variant="ghost" size="icon" aria-label={`打开 ${shortTitle(item.title,24)}`}><a href={item.evidence_url} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /></a></Button>}</div></TableCell></TableRow>})}</TableBody></Table>
}

function useChartWidth(){const ref=useRef<HTMLElement|null>(null);const [width,setWidth]=useState(0);useEffect(()=>{const element=ref.current;if(!element)return;const observer=new ResizeObserver(entries=>{const entry=entries[0];if(entry)setWidth(Math.floor(entry.contentRect.width))});observer.observe(element);return()=>observer.disconnect()},[]);return [ref,width] as const}
type ChartAnchor={x:number;y:number}
function chartAnchor(event:MouseEvent<Element>|KeyboardEvent<Element>|FocusEvent<Element>):ChartAnchor{if('clientX' in event)return {x:event.clientX,y:event.clientY};const rect=event.currentTarget.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+Math.min(rect.height/2,40)}}
function ChartTooltip({title,children,onClose,anchor}:{title:string;children:ReactNode;onClose:()=>void;anchor:ChartAnchor}){useEffect(()=>{window.addEventListener('scroll',onClose,true);window.addEventListener('resize',onClose);return()=>{window.removeEventListener('scroll',onClose,true);window.removeEventListener('resize',onClose)}},[onClose]);const virtualRef=useMemo(()=>({current:{getBoundingClientRect:()=>new DOMRect(anchor.x,anchor.y,0,0)}}),[anchor.x,anchor.y]);return <Popover.Root open onOpenChange={open=>{if(!open)onClose()}}><Popover.Anchor virtualRef={virtualRef}/><Popover.Portal><Popover.Content role="tooltip" side="top" align="center" sideOffset={10} collisionPadding={12} onInteractOutside={event=>event.preventDefault()} onOpenAutoFocus={event=>event.preventDefault()} onCloseAutoFocus={event=>event.preventDefault()} className="pointer-events-none z-50 w-max max-w-[min(280px,calc(100vw_-_24px))] rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg outline-none"><div className="mb-1 max-w-64 truncate font-medium" title={title}>{title}</div><div className="space-y-1 leading-6">{children}</div><Popover.Arrow className="fill-popover"/></Popover.Content></Popover.Portal></Popover.Root>}

function DailyActivityChart({items}:{items:Array<{date:string;posts:number;replies:number;completed_tasks?:number|null;other_actions?:number}>}){
 const [chartRef,chartWidth]=useChartWidth();const [anchor,setAnchor]=useState<ChartAnchor>({x:0,y:0});const [selectedDate,setSelectedDate]=useState<string|null>(null);const selected=items.find(item=>item.date===selectedDate);const total=(item:{posts:number;replies:number;completed_tasks?:number|null;other_actions?:number})=>item.posts+item.replies+(item.completed_tasks??0)+(item.other_actions??0);const max=Math.max(1,...items.map(total));const width=Math.max(chartWidth||560,56+items.length*36);const height=230;const padding={top:20,right:16,bottom:36,left:40};const innerWidth=width-padding.left-padding.right;const innerHeight=height-padding.top-padding.bottom;const band=items.length>0?innerWidth/items.length:28;const barWidth=items.length>0?Math.min(36,band*.58):18
 return <section ref={chartRef} className="relative h-[340px] min-w-0 rounded-lg border bg-card/50 p-5" aria-label="每日执行统计图"><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">每日执行</h2><p className="text-sm text-muted-foreground">按动作发生日期统计发帖、发出回复和已登记完成时间的任务。</p></div><div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-primary" />发帖</span><span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{background:'#65a8ff'}} />发出回复</span><span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm" style={{background:'#c6c6d1'}} />完成任务</span></div></div>{items.length===0?<div className="flex h-40 items-center justify-center text-sm text-muted-foreground">暂无可绘制数据</div>:<div className="max-w-full overflow-x-auto"><svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="每日执行堆叠柱状图" className="block max-w-none"><line x1={padding.left} y1={padding.top+innerHeight} x2={padding.left+innerWidth} y2={padding.top+innerHeight} stroke="var(--border)" /><text x={0} y={padding.top+5} className="fill-muted-foreground text-[12px]">{max}</text><text x={0} y={padding.top+innerHeight/2+4} className="fill-muted-foreground text-[12px]">{Math.round(max/2)}</text><text x={0} y={padding.top+innerHeight+4} className="fill-muted-foreground text-[12px]">0</text>{items.map((item,index)=>{const x=padding.left+(innerWidth/items.length)*index+(innerWidth/items.length-barWidth)/2;const postHeight=innerHeight*(item.posts/max);const replyHeight=innerHeight*(item.replies/max);const taskHeight=innerHeight*((item.completed_tasks??0)/max);const otherHeight=innerHeight*((item.other_actions??0)/max);const baseY=padding.top+innerHeight;return <g key={item.date} role="button" tabIndex={0} aria-label={`${dateLabel(item.date)}，发帖${item.posts}条，发出回复${item.replies}条，完成任务${item.completed_tasks??'未知'}条`} className="cursor-pointer outline-none focus:opacity-70" onMouseEnter={event=>{setAnchor(chartAnchor(event));setSelectedDate(item.date)}} onMouseMove={event=>setAnchor(chartAnchor(event))} onMouseLeave={()=>setSelectedDate(null)} onFocus={event=>{setAnchor(chartAnchor(event));setSelectedDate(item.date)}} onBlur={()=>setSelectedDate(null)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setAnchor(chartAnchor(event));setSelectedDate(item.date)}if(event.key==='Escape')setSelectedDate(null)}}><rect x={x-6} y={padding.top} width={barWidth+12} height={innerHeight+padding.bottom} fill="transparent"/><rect x={x} y={baseY-postHeight} width={barWidth} height={postHeight} rx="4" fill="var(--primary)" /><rect x={x} y={baseY-postHeight-replyHeight} width={barWidth} height={replyHeight} rx="4" fill="#65a8ff" /><rect x={x} y={baseY-postHeight-replyHeight-taskHeight} width={barWidth} height={taskHeight} rx="4" fill="#c6c6d1" /><rect x={x} y={baseY-postHeight-replyHeight-taskHeight-otherHeight} width={barWidth} height={otherHeight} rx="4" fill="#9d839b" /><text x={x+barWidth/2} y={height-9} textAnchor="middle" className="fill-muted-foreground text-[12px]">{item.date.slice(5).replace('-','/')}</text></g>})}</svg></div>}{selected&&<ChartTooltip anchor={anchor} title={dateLabel(selected.date)} onClose={()=>setSelectedDate(null)}><p>发帖 <strong>{selected.posts}</strong> · 发出回复 <strong>{selected.replies}</strong></p><p>完成任务 <strong>{countText(selected.completed_tasks)}</strong> · 其他动作 <strong>{selected.other_actions??0}</strong></p><p className="text-muted-foreground">共 {total(selected)} 条已记录执行</p></ChartTooltip>}</section>
}

function OperationsCharts({view,chartData,renderTarget,onShowLatest}:{view:ReportView;chartData:ChartData|undefined;renderTarget:(productId:string|null,accountId:string|null)=>ReactNode;onShowLatest:()=>void}){
 const extent=chartData?.extent
 const extentText=extent?.from||extent?.to?`图表范围：${dateLabel(extent.from)} 至 ${dateLabel(extent.to)}${extent.truncated?'，结果已截断':''}`:''
 return <div className="grid min-w-0 gap-4 border-b px-5 py-4 xl:grid-cols-2">{extentText&&<div className="text-sm text-muted-foreground xl:col-span-2">{extentText}</div>}{view==='execution'&&<div className="min-w-0 xl:col-span-2"><DailyActivityChart items={chartData?.daily_activity||[]}/></div>}{view==='content'&&<div className="min-w-0 xl:col-span-2"><TopContentChart items={chartData?.top_content||[]} renderTarget={renderTarget} window={chartData?.window||'latest'} onShowLatest={onShowLatest}/></div>}</div>
}

function TopContentChart({items,renderTarget,window,onShowLatest}:{items:Array<{id:string;title:string;action_type?:string|null;views:number|null;product_id?:string|null}>;renderTarget:(productId:string|null,accountId:string|null)=>ReactNode;window:ContentWindow;onShowLatest:()=>void}){
 const [anchor,setAnchor]=useState<ChartAnchor>({x:0,y:0});const [selectedId,setSelectedId]=useState<string|null>(null);const selected=items.find(item=>item.id===selectedId);const known=items.filter(item=>typeof item.views==='number'&&Number.isFinite(item.views));const max=Math.max(1,...known.map(item=>item.views as number));const windowLabel=window==='latest'?'最新累计':window==='7d'?'7 天':window==='72h'?'72 小时':'24 小时'
 return <section className="relative flex h-[340px] min-w-0 flex-col rounded-lg border bg-card/50 p-5" aria-label="内容浏览排行"><div className="mb-3 flex items-start justify-between gap-3"><div><h2 className="text-base font-semibold">内容表现 Top 10</h2><p className="text-sm text-muted-foreground">按{windowLabel}浏览排序，未知值不按 0 处理。</p></div>{window!=='latest'&&<Button variant="outline" size="sm" onClick={onShowLatest}>查看最新累计</Button>}</div>{items.length===0?<div className="flex h-40 items-center justify-center text-sm text-muted-foreground">当前窗口暂无可绘制数据</div>:<div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">{items.slice(0,10).map(item=>{const value=typeof item.views==='number'&&Number.isFinite(item.views)?item.views:null;const width=value===null||value===0?0:(value/max)*100;return <div key={item.id} role="button" tabIndex={0} aria-label={`查看内容数据：${item.title}`} onMouseEnter={event=>{setAnchor(chartAnchor(event));setSelectedId(item.id)}} onMouseMove={event=>setAnchor(chartAnchor(event))} onMouseLeave={()=>setSelectedId(null)} onFocus={event=>{setAnchor(chartAnchor(event));setSelectedId(item.id)}} onBlur={()=>setSelectedId(null)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setAnchor(chartAnchor(event));setSelectedId(item.id)}if(event.key==='Escape')setSelectedId(null)}} className="grid cursor-pointer gap-2 rounded-md outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"><div className="flex items-center justify-between gap-3 text-sm"><span className="min-w-0 truncate font-medium">{item.title}</span><span className="shrink-0 text-secondary-foreground">{metricNumber(value)}</span></div><div className="flex items-center gap-3"><div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{width:`${width}%`}} /></div><span className="w-20 shrink-0 truncate text-xs text-muted-foreground">{actionTypeLabel(item.action_type||'')}</span></div>{item.product_id&&<div className="text-xs text-muted-foreground">{renderTarget(item.product_id,null)}</div>}</div>})}</div>}{selected&&<ChartTooltip anchor={anchor} title={selected.title} onClose={()=>setSelectedId(null)}><p>{actionTypeLabel(selected.action_type)} · {windowLabel}浏览 <strong>{metricNumber(selected.views)}</strong></p></ChartTooltip>}</section>
}
