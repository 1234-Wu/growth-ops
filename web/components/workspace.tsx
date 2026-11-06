'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, BarChart3, BookOpen, Boxes, Check, ChevronLeft, ChevronRight, CircleCheck, Compass, Copy, Eye, EyeOff, FileText, Globe2, KeyRound, LayoutDashboard, ListChecks, Loader2, LogOut, Menu, RefreshCw, Settings2, ShieldCheck, Sparkles, Users, Workflow, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { PlatformIcon } from './platform-icon';
import { AccountName } from './account-name';
import { accountLabel, accountPlatform } from '@/lib/account-label';
import { PageHeader } from './page-header';
import { ResourcePage } from './resource-page';
import { ProductLibrary } from './product-library';
import { OperationsData } from './operations-data';
import { DashboardView, type DashboardData } from './dashboard';
import { createApi } from '@/lib/api';
import { displayDate, isResource, queryString, resources, statusLabels } from '@/lib/resources';
import type { Api, OpsRecord, RecordPage, Reconciliation } from '@/lib/types';

const icons:Record<string,LucideIcon>={dashboard:LayoutDashboard,reconciliation:ShieldCheck,tasks:ListChecks,actions:Activity,contents:FileText,observations:Eye,metrics:BarChart3,strategies:Compass,reviews:Workflow,knowledge:BookOpen,skills:Sparkles,accounts:Users,products:Boxes,platforms:Globe2,settings:Settings2};
const groups=[
  {label:'日常运营',routes:['dashboard','tasks','actions','metrics','reviews']},
  {label:'资产与知识库',routes:['strategies','products','knowledge','skills']},
  {label:'系统设置',routes:['platforms','accounts','settings']}
];
const label=(route:string)=>{
  if(route==='strategies')return '策略库';
  if(route==='products')return '产品与物料';
  if(route==='knowledge')return '知识与选题';
  if(route==='skills')return '技能中心';
  if(route==='platforms')return '平台与渠道';
  if(route==='actions')return '运营动作';
  if(isResource(route))return resources[route].label;
  return ({dashboard:'仪表盘',reconciliation:'执行对账',settings:'设置与接入'}[route]||'仪表盘');
};
const issueLabels:Record<string,string>={overdue_task:'逾期任务',missing_evidence:'缺少凭证',unverified_action:'待核验',overdue_observation:'逾期监测',review_due:'待复盘'};
const validRoute=(route:string)=>Boolean(icons[route]);

export function Workspace({initialRoute}:{initialRoute:string}){
 const [route,setRoute]=useState(initialRoute),[token,setToken]=useState(''),[checking,setChecking]=useState(true),[restoringSession,setRestoringSession]=useState(true),[loginError,setLoginError]=useState(''),[candidate,setCandidate]=useState(''),[accountId,setAccountId]=useState(''),[accounts,setAccounts]=useState<OpsRecord[]>([]),[platforms,setPlatforms]=useState<OpsRecord[]>([]),[mobile,setMobile]=useState(false),[revision,setRevision]=useState(0),[selectedId,setSelectedId]=useState<string>(),[showKey,setShowKey]=useState(false);
 const generation=useRef(0);
 const logout=useCallback((message='')=>{generation.current++;sessionStorage.removeItem('growthOpsApiKey');setToken('');setChecking(false);setLoginError(message);setCandidate('');setAccounts([]);setPlatforms([]);},[]);
 const api:Api=useCallback(async<T,>(path:string,init?:RequestInit):Promise<T>=>createApi(token,()=>{if(sessionStorage.getItem('growthOpsApiKey')===token)logout('访问密钥已失效，请重新登录。');})<T>(path,init),[token,logout]);
 const login=useCallback(async(value:string)=>{
  const key=value.trim();if(!key){setLoginError('请输入访问密钥。');setChecking(false);return;}
  const attempt=++generation.current;setChecking(true);setLoginError('');
  try{const response=await fetch('/api/v1/meta',{headers:{Authorization:`Bearer ${key}`},cache:'no-store'});if(attempt!==generation.current)return;if(!response.ok)throw Error(response.status===401?'密钥不正确，请检查后重试。':'暂时无法连接工作台，请稍后重试。');const result=await response.json();if(!Array.isArray(result.resources))throw Error('服务返回异常，请重试。');if(attempt!==generation.current)return;sessionStorage.setItem('growthOpsApiKey',key);setToken(key);setCandidate('');setChecking(false);}catch(e){if(attempt!==generation.current)return;sessionStorage.removeItem('growthOpsApiKey');setToken('');setChecking(false);setLoginError(e instanceof Error?e.message:'连接失败，请重试。');}
 },[]);
 useEffect(()=>{
  let keyToUse = '';
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const queryKey = params.get('key');
    if (queryKey) {
      keyToUse = queryKey.trim();
      params.delete('key');
      const remaining = params.toString();
      const cleanUrl = window.location.pathname + (remaining ? `?${remaining}` : '') + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
    }
  }
  const saved = keyToUse || (typeof window !== 'undefined' ? sessionStorage.getItem('growthOpsApiKey') : null);
  Promise.resolve().then(()=>{
    setAccountId((typeof window !== 'undefined' && sessionStorage.getItem('growthOpsAccountId'))||'');
    if(saved)void login(saved).finally(()=>setRestoringSession(false));
    else{setChecking(false);setRestoringSession(false);}
  });
 },[login]);
 useEffect(()=>{if(!token)return;let active=true;async function all(resource:string){const items:OpsRecord[]=[];let offset=0;for(;;){const page=await api<RecordPage>(`/${resource}?limit=200&offset=${offset}`);items.push(...page.items);offset+=page.limit;if(items.length>=page.total||page.items.length===0)return items;}}Promise.all([all('accounts'),all('platforms')]).then(([a,p])=>{if(active){setAccounts(a);setPlatforms(p);}}).catch(()=>{});return()=>{active=false;};},[api,token,revision]);
 useEffect(()=>{const onPop=()=>{const next=location.pathname.split('/').filter(Boolean)[0]||'dashboard';setRoute(validRoute(next)?next:'dashboard');setSelectedId(undefined);};window.addEventListener('popstate',onPop);return()=>window.removeEventListener('popstate',onPop);},[]);
 const navigate=useCallback((next:string,id?:string)=>{if(!validRoute(next))return;const event=new CustomEvent('ops-before-navigate',{cancelable:true,detail:{route:next,id}});if(!window.dispatchEvent(event))return;window.history.pushState({},'',`/${next}/`);setRoute(next);setSelectedId(id);setMobile(false);window.scrollTo(0,0);},[]);
 const refresh=useCallback(()=>setRevision(n=>n+1),[]);
 const clearSelected=useCallback(()=>setSelectedId(undefined),[]);
 const sidebarAccount=accounts.find(account=>account.id===accountId)||(!accountId&&accounts.length===1?accounts[0]:undefined);
 const nav=<><div className="brand"><div className="brand-symbol"><Workflow size={22}/></div><div><strong>Growth Notes</strong><span>增长运营工作台</span></div></div><div className="workspace-identity">{sidebarAccount?<PlatformIcon name={accountPlatform(sidebarAccount,platforms)}/>:<Users size={16} aria-hidden="true"/>}<strong title={sidebarAccount?.title}>{sidebarAccount?.title||(accountId?"当前账号":"全部账号")}</strong></div><nav aria-label="主导航">{groups.map(group=><div className="nav-group" key={group.label}><p>{group.label}</p>{group.routes.map(key=>{const Icon=icons[key];return <a key={key} href={`/${key}/`} aria-current={route===key?'page':undefined} onClick={e=>{if(e.metaKey||e.ctrlKey)return;e.preventDefault();navigate(key);}}><Icon size={17} strokeWidth={1.7}/><span>{label(key)}</span>{route===key&&<span className="nav-active-dot"/>}</a>;})}</div>)}</nav><div className="sidebar-footer"><span className="live-dot"/><div><strong>记录每一次进步</strong><p>动作 → 数据 → 复盘 → 优化</p></div></div></>;
 if(restoringSession)return <main className="session-loading" aria-busy="true"><div role="status"><Loader2 size={20} className="animate-spin" aria-hidden="true"/><span>正在加载工作台…</span></div></main>;
 if(!token)return <div className="login-layout"><div className="login-bg-grid" aria-hidden="true"/><div className="login-glow-left" aria-hidden="true"/><div className="login-glow-right" aria-hidden="true"/><div className="login-container"><div className="login-story"><div className="login-story-top"><div className="login-brand"><div className="login-brand-icon"><Workflow size={22}/></div><div className="login-brand-meta"><span className="login-brand-name">Growth Notes</span><span className="login-badge-sub">Local First</span></div></div><div className="login-hero-block"><div className="login-eyebrow-pill"><Sparkles size={13} className="login-pulse-icon"/><span>从行动到经验 · 运营知识沉淀</span></div><h1 className="login-heading">让每一次运营，<br/><span className="login-heading-accent">都有迹可循。</span></h1><p className="login-subheading">记录真实动作，客观观测数据，闭环归因复盘。<br className="hidden sm:inline"/>把今天的执行经验，沉淀为下一次行动与 AI 决策的可靠依据。</p><div className="login-pipeline-card"><div className="login-pipeline-header"><span className="pipeline-dot"/><span className="pipeline-title">标准化运营飞轮</span></div><div className="login-flow-grid"><div className="flow-step"><div className="step-badge">01</div><div className="step-info"><strong>动作落地</strong><span>过程留痕</span></div></div><ArrowRight size={14} className="flow-arrow"/><div className="flow-step"><div className="step-badge">02</div><div className="step-info"><strong>指标观测</strong><span>真实追踪</span></div></div><ArrowRight size={14} className="flow-arrow"/><div className="flow-step"><div className="step-badge">03</div><div className="step-info"><strong>执行对账</strong><span>异常核验</span></div></div><ArrowRight size={14} className="flow-arrow"/><div className="flow-step"><div className="step-badge">04</div><div className="step-info"><strong>归因复盘</strong><span>经验沉淀</span></div></div></div></div></div></div><div className="login-story-foot"><ShieldCheck size={16} className="text-orange-400 shrink-0"/><span>数据全生命周期安全存储在本地 SQLite，为你的 AI 决策提供可信记忆。</span></div></div><main className="login-main"><div className="login-card"><div className="login-card-shine" aria-hidden="true"/><form onSubmit={e=>{e.preventDefault();void login(candidate);}} className="login-form"><div className="login-card-header"><div className="login-key-icon"><KeyRound size={22}/></div><h2>进入工作台</h2><p>输入你的访问密钥，继续记录与复盘。</p></div><div className="space-y-2 mt-7"><div className="flex items-center justify-between"><Label htmlFor="access-key">访问密钥</Label><span className="text-[11px] text-zinc-500 font-mono">API Key</span></div><div className="relative"><Input id="access-key" aria-label="API Key" type={showKey?"text":"password"} autoComplete="current-password" value={candidate} onChange={e=>setCandidate(e.target.value)} disabled={checking} placeholder="输入访问密钥" className="h-11 pr-10"/><button type="button" tabIndex={-1} className="login-eye-btn" onClick={()=>setShowKey(!showKey)} aria-label={showKey?"隐藏密钥":"显示密钥"}>{showKey?<EyeOff size={16}/>:<Eye size={16}/>}</button></div></div>{loginError&&<Alert variant="destructive" className="mt-4"><AlertDescription>{loginError}</AlertDescription></Alert>}<Button className="w-full h-11 mt-6 login-submit-btn" disabled={checking}>{checking?<><Loader2 className="animate-spin mr-1.5"/>正在验证</>:<>进入工作台<ArrowRight size={16} className="ml-1 transition-transform group-hover:translate-x-0.5"/></>}</Button><div className="login-card-notes"><p className="login-hint"><span className="login-hint-dot"/>密钥仅保存在当前浏览器会话中 (SessionStorage)。</p><p className="login-subhint">可在终端启动日志或 <code>data/api-key</code> 中获取密钥。</p></div></form></div><div className="login-footer">Growth Notes · 你的运营经验库</div></main></div></div>;
  return <div className="app-shell"><a className="skip-link" href="#main">跳到主内容</a><aside className="desktop-sidebar">{nav}</aside><Sheet open={mobile} onOpenChange={setMobile}><SheetContent side="left" className="mobile-sidebar"><SheetTitle className="sr-only">工作台导航</SheetTitle>{nav}</SheetContent></Sheet><div className="main-shell"><header className="topbar"><div className="breadcrumb"><Button variant="ghost" size="icon" className="mobile-menu" aria-label="打开导航" onClick={()=>setMobile(true)}><Menu size={19}/></Button><span>工作空间</span><ChevronRight size={13}/><strong>{label(route)}</strong></div><div className="topbar-actions"><Select value={accountId||'__all__'} onValueChange={v=>{const next=v==='__all__'?'':v;setAccountId(next);sessionStorage.setItem('growthOpsAccountId',next);}}><SelectTrigger aria-label="账号筛选" className="account-switch"><Users size={15}/><SelectValue placeholder="全部账号"/></SelectTrigger><SelectContent><SelectItem value="__all__">全部账号</SelectItem>{accounts.map(a=><SelectItem key={a.id} value={a.id} aria-label={accountLabel(a,platforms)}><AccountName account={a} platforms={platforms} iconOnly/></SelectItem>)}</SelectContent></Select><span className="connection-status"><span className="live-dot"/>已连接</span><Button variant="ghost" size="icon" aria-label="刷新数据" onClick={refresh}><RefreshCw size={16}/></Button><Button variant="ghost" size="icon" aria-label="退出" onClick={()=>logout()}><LogOut size={16}/></Button></div></header>  <main id="main" className="page-container">{route==='dashboard'?<Dashboard api={api} accountId={accountId} revision={revision} navigate={navigate} accounts={accounts} platforms={platforms}/>:route==='reconciliation'?<ReconciliationPage api={api} accountId={accountId} revision={revision} navigate={navigate}/>:route==='settings'?<SettingsPage api={api}/>:route==='metrics'?<OperationsData key={accountId||'all-accounts'} api={api} accountId={accountId} revision={revision} onChanged={refresh} onNavigate={navigate} selectedId={selectedId} onSelected={clearSelected}/>:route==='products'?<ProductLibrary api={api} accountId={accountId} revision={revision} onChanged={refresh}/>:isResource(route)?<ResourcePage key={route} resource={route} api={api} accountId={accountId} revision={revision} selectedId={selectedId} onSelected={clearSelected} onChanged={refresh} onNavigate={navigate}/>:null}</main><footer className="workspace-foot">真实记录，持续积累。<span>Growth Notes</span></footer></div></div>;
 }

function Dashboard({api,accountId,revision,navigate,accounts,platforms}:{api:Api;accountId:string;revision:number;navigate:(route:string,id?:string)=>void;accounts:OpsRecord[];platforms:OpsRecord[]}){
 const [data,setData]=useState<DashboardData>()
 const [loading,setLoading]=useState(false)
 const [error,setError]=useState('')
 const loadData=useCallback(()=>{
  setLoading(true)
  api<DashboardData>('/dashboard'+queryString({account_id:accountId}))
   .then(d=>{setData(d);setError('')})
   .catch(e=>setError(e.message))
   .finally(()=>setLoading(false))
 },[api,accountId])

 useEffect(()=>{loadData()},[loadData,revision])

 const currentAccount = accounts.find(a=>a.id===accountId)
 const accountTitle = currentAccount ? (currentAccount.title || (currentAccount.data?.handle ? `@${currentAccount.data.handle}` : currentAccount.id)) : undefined

 return (
  <DashboardView
   api={api}
   accountId={accountId}
   accountName={accountTitle}
   data={data}
   loading={loading}
   error={error}
   onRefresh={loadData}
   navigate={navigate}
  />
 )
}
function ReconciliationPage({api,accountId,revision,navigate}:{api:Api;accountId:string;revision:number;navigate:(r:string,id?:string)=>void}){
 const [data,setData]=useState<Reconciliation>(),[kind,setKind]=useState(''),[product,setProduct]=useState(''),[products,setProducts]=useState<OpsRecord[]>([]),[offset,setOffset]=useState(0),[error,setError]=useState('');
 useEffect(()=>{let active=true;api<RecordPage>('/products?limit=200').then(x=>{if(active)setProducts(x.items);}).catch(()=>{});return()=>{active=false;};},[api]);
 useEffect(()=>{let active=true;api<Reconciliation>('/reconciliation'+queryString({account_id:accountId,product_id:product,kind,limit:10,offset})).then(x=>{if(active){setData(x);setError('');}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[api,accountId,product,kind,offset,revision]);
 return <><PageHeader title="执行对账" description="核对该发生的事，和已经发生的事。" eyebrow="让执行有回音" actions={<Badge variant="outline"><ShieldCheck size={14}/>只读检查</Badge>} /><div className="issue-summary">{Object.entries(issueLabels).map(([key,name])=><button key={key} className={kind===key?'selected':''} onClick={()=>{setKind(kind===key?'':key);setOffset(0);}}><span>{name}</span><strong>{data?.counts[key]??'—'}</strong></button>)}</div><section className="surface"><div className="list-toolbar"><div><h2>待处理事项 <span className="count-label">{data?.total??0}</span></h2><p>点击记录，补充凭证或更新处理状态。</p></div><div className="flex gap-2"><Select value={kind||'__all__'} onValueChange={v=>{setKind(v==='__all__'?'':v);setOffset(0);}}><SelectTrigger aria-label="异常类型" className="w-36"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="__all__">全部异常</SelectItem>{Object.entries(issueLabels).map(([v,t])=><SelectItem key={v} value={v}>{t}</SelectItem>)}</SelectContent></Select><Select value={product||'__all__'} onValueChange={v=>{setProduct(v==='__all__'?'':v);setOffset(0);}}><SelectTrigger aria-label="产品筛选" className="w-36"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="__all__">全部产品</SelectItem>{products.map(x=><SelectItem key={x.id} value={x.id}>{x.title}</SelectItem>)}</SelectContent></Select></div></div>{error&&<ErrorBanner message={error}/>}<Table><TableHeader><TableRow><TableHead>事项</TableHead><TableHead>类型</TableHead><TableHead>到期时间</TableHead><TableHead>原因</TableHead><TableHead className="w-12"/></TableRow></TableHeader><TableBody>{data?.items.map(item=><TableRow key={item.id} onClick={()=>navigate(item.resource,item.record_id)} className="cursor-pointer"><TableCell className="font-medium"><button className="text-left" onClick={e=>{e.stopPropagation();navigate(item.resource,item.record_id);}}>{item.title}</button><p className="table-subtext">{label(item.resource)}</p></TableCell><TableCell><Badge variant="secondary" className="issue-badge">{issueLabels[item.kind]}</Badge></TableCell><TableCell className="whitespace-nowrap">{displayDate(item.due_at)}</TableCell><TableCell className="text-muted-foreground">{item.reason}</TableCell><TableCell><ArrowUpRight size={15}/></TableCell></TableRow>)}</TableBody></Table>{!data?<Loading/>:!data.items.length?<Empty title="没有需要处理的异常" description="当前筛选范围内的任务、核验和复盘都已对齐。" icon={ShieldCheck}/>:null}<div className="table-footer"><span>共 {data?.total??0} 项 · {data?`检查于 ${displayDate(data.as_of)}`:'正在读取'}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-10))}><ChevronLeft size={14}/>上一页</Button><Button variant="outline" size="sm" disabled={offset+10>=(data?.total??0)} onClick={()=>setOffset(offset+10)}>下一页<ChevronRight size={14}/></Button></div></div></section></>;
}
function SettingsPage({api}:{api:Api}){
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false);
 const base=typeof window==='undefined'?'':window.location.origin+'/api/v1';
 async function download(){setBusy(true);try{const data=await api<unknown>('/export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`growth-notes-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);setMessage('导出完成，包含业务记录和版本历史。');}catch(e){setMessage(e instanceof Error?e.message:'导出失败');}finally{setBusy(false);}}
 return <><PageHeader title="设置与接入" description="将工作台交给你的 AI，让运营记录自动沉淀。" eyebrow="连接与管理" /><div className="settings-columns"><section className="surface settings-section"><div className="section-icon"><KeyRound size={22}/></div><h2>AI 接口接入</h2><p>AI 负责规划、执行和复盘。工作台保存真实记录，提供上下文与数据查询。</p><Label>API 地址</Label><div className="copy-field"><code>{base}</code><Button variant="ghost" size="icon" aria-label="复制 API 地址" onClick={async()=>{try{await navigator.clipboard.writeText(base);setCopied(true);}catch{setMessage('无法自动复制，请手动选择接口地址。');}}}>{copied?<Check size={16}/>:<Copy size={16}/>}</Button></div><div className="endpoint-list"><div><Badge variant="outline">GET</Badge><code>/accounts/:id/context</code><span>账号上下文</span></div><div><Badge variant="outline">POST</Badge><code>/actions</code><span>记录动作</span></div><div><Badge variant="outline">GET</Badge><code>/reconciliation</code><span>执行对账</span></div><div><Badge variant="outline">POST</Badge><code>/reviews</code><span>保存复盘</span></div></div><p className="small-note">请求使用 Authorization: Bearer &lt;访问密钥&gt;。新增记录附带 Idempotency-Key，更新记录携带当前 version。完整契约通过 /openapi.json 读取。</p></section><section className="surface settings-section"><div className="section-icon"><ArrowDownToLine size={22}/></div><h2>导出与备份</h2><p>下载完整业务记录和策略、Skill 版本历史。原始文件仍保存在本地数据库中。</p><Button onClick={download} disabled={busy}>{busy?<Loader2 className="animate-spin"/>:<ArrowDownToLine size={16}/>}导出 JSON</Button>{message&&<p role="status" className="mt-4 text-sm">{message}</p>}<div className="settings-note"><CircleCheck size={17}/><p>导出不包含访问密钥。需要保留重试状态的完整备份时，使用项目中的 SQLite 备份工具。</p></div></section></div></>;
}
function SectionHead({title,subtitle,action,actionLabel='查看全部'}:{title:string;subtitle:string;action:()=>void;actionLabel?:string}){return <div className="section-head"><div><h2>{title}</h2><p>{subtitle}</p></div><Button variant="ghost" size="sm" onClick={action}>{actionLabel}<ArrowUpRight size={14}/></Button></div>;}
function Loading(){return <div className="loading-state"><Loader2 className="animate-spin" size={20}/><span>正在读取记录…</span></div>;}
function Empty({title,description,icon:Icon}:{title:string;description:string;icon:LucideIcon}){return <div className="empty-state"><Icon size={27}/><h3>{title}</h3><p>{description}</p></div>;}
function ErrorBanner({message}:{message:string}){return <Alert variant="destructive" className="mb-5"><AlertDescription>{message}</AlertDescription></Alert>;}
