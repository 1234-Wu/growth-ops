'use client'

import {useState} from 'react'
import {Check,Copy,Lightbulb,Link2,Target} from 'lucide-react'
import type {OpsRecord} from '@/lib/types'
import {Badge} from '@/components/ui/badge'
import {Button} from '@/components/ui/button'

export const TASK_TYPE_LABELS:Record<string,string>={
 account_operations:'账号互动',
 content_publishing:'内容发布',
 asset_creation:'素材制作',
 product_preparation:'产品准备',
 analysis_review:'数据复盘',
 strategy_planning:'策略规划',
 other:'其他任务',
}

type Fields=Record<string,unknown>
type ExecutionItem={title?:string;target_url?:string;copy?:string}

function originalFields(record:OpsRecord):Fields{
 const value=record.data?.original_fields
 return value&&typeof value==='object'&&!Array.isArray(value)?value as Fields:{}
}

function textField(fields:Fields,patterns:RegExp[]){
 for(const [key,value] of Object.entries(fields)){
  if(patterns.some(pattern=>pattern.test(key))&&typeof value==='string'&&value.trim())return value.trim()
 }
 return ''
}

function taskCore(record:OpsRecord){
 const fields=originalFields(record)
 return textField(fields,[/^任务$/, /动作.*负责人/, /具体动作/])||record.title.replace(/^\d{4}-\d{2}-\d{2}\s+P\d\s+/,'')
}

export function taskTypeValue(record:OpsRecord){
 const saved=record.data?.task_type
 if(typeof saved==='string'&&saved)return saved
 const title=taskCore(record)
 const source=`${title} ${taskAcceptance(record)}`
 if(/发布|原创|推文|发帖/.test(title))return 'content_publishing'
 if(/回复|评论|互动/.test(source))return 'account_operations'
 if(/复盘|归因|分析数据|数据统计/.test(source))return 'analysis_review'
 if(/截图|录屏|素材|关键帧|演示图|三图/.test(source)&&!/发布|原创|推文/.test(taskCore(record)))return 'asset_creation'
 if(/发布|原创|推文|发帖/.test(source))return 'content_publishing'
 if(/入口|版本|产品资料|App Store|落地页/.test(source))return 'product_preparation'
 if(/策略|规划|排期/.test(source))return 'strategy_planning'
 return 'other'
}

export function taskTypeLabel(record:OpsRecord){return TASK_TYPE_LABELS[taskTypeValue(record)]||'未分类'}

export function taskPriority(record:OpsRecord){
 const value=record.data?.priority
 return typeof value==='string'&&value?value:''
}

export function taskFriendlyTitle(record:OpsRecord){
 let core=taskCore(record).replace(/^运营(?:人员)?/, '').trim()
 const type=taskTypeValue(record)
 if(type==='content_publishing'){
  const quote=core.match(/(?:发|发布)下方\d+字符[“"]([^”"]+)[”"]原创/)
  if(quote)return `发布原创：${quote[1]}`
  core=core.replace(/^(完成|发布|发)\s*/, '').replace(/推文$/, '').trim()
  return `发布内容：${core}`
 }
 if(type==='account_operations'){
  core=core.replace(/^(完成|进行)\s*/, '').replace(/^回复/, '').replace(/各1条/g,'各 1 条').trim()
  return `互动回复：${core}`
 }
 if(type==='asset_creation'){
  core=core.replace(/^(获取并验收|获取|制作并验收|制作|准备)\s*/, '').trim()
  return `准备素材：${core}`
 }
 if(type==='analysis_review')return `数据复盘：${core.replace(/^完成/,'').trim()}`
 if(type==='product_preparation')return `产品准备：${core.replace(/^(完成|确认并登记|关闭)/,'').trim()}`
 if(type==='strategy_planning')return `策略规划：${core.replace(/^(完成|制定)/,'').trim()}`
 return core
}

export function taskAcceptance(record:OpsRecord){
 return textField(originalFields(record),[/验收/, /完成标准/])
}

export function taskListSummary(record:OpsRecord){
 return taskAcceptance(record)||textField(originalFields(record),[/为什么今天做/, /实际证据/, /原因/])||'暂无执行说明'
}

function taskReason(record:OpsRecord){return textField(originalFields(record),[/为什么今天做/])}
function taskEvidence(record:OpsRecord){return textField(originalFields(record),[/实际证据/, /计划证据/, /预期证据/])}

function executionCopy(record:OpsRecord){
 const value=record.data?.execution_copy
 if(typeof value==='string'&&value.trim())return value.trim()
 return ''
}

function executionGoal(record:OpsRecord){
 const value=record.data?.execution_goal
 return typeof value==='string'&&value.trim()?value.trim():taskCore(record)
}

function executionSteps(record:OpsRecord){
 const value=record.data?.execution_steps
 if(Array.isArray(value))return value.filter(step=>typeof step==='string'&&step.trim()) as string[]
 const type=taskTypeValue(record)
 if(type==='content_publishing')return ['核对任务要求的素材和事实','将下方文案作为帖子正文，并附上要求的素材','发布后记录公开链接和首轮数据']
 if(type==='account_operations')return ['打开目标原帖，确认本账号尚未回复','使用对应草稿回复','保存本账号回复链接']
 return []
}

function executionItems(record:OpsRecord):ExecutionItem[]{
 const value=record.data?.execution_items
 if(!Array.isArray(value))return []
 return value.filter(item=>item&&typeof item==='object').map(item=>item as ExecutionItem)
}

function InfoBlock({icon,title,children}:{icon:React.ReactNode;title:string;children:React.ReactNode}){
 return <section className="task-guide-block"><div className="task-guide-label">{icon}<span>{title}</span></div><div className="task-guide-value">{children}</div></section>
}

function CopyButton({value}:{value:string}){
 const [copied,setCopied]=useState(false)
 return <Button type="button" variant="outline" size="sm" onClick={async()=>{await navigator.clipboard.writeText(value);setCopied(true);setTimeout(()=>setCopied(false),1600)}}>{copied?<Check className="size-4"/>:<Copy className="size-4"/>}{copied?'已复制':'复制'}</Button>
}

export function TaskExecutionGuide({record}:{record:OpsRecord}){
 const objective=executionGoal(record),steps=executionSteps(record),acceptance=taskAcceptance(record),reason=taskReason(record),evidence=taskEvidence(record)
 const prepared=executionCopy(record),items=executionItems(record),priority=taskPriority(record)
 return <section className="task-guide" aria-labelledby="task-guide-title">
  <header className="task-guide-head"><div><p className="task-guide-kicker">执行指导</p><h2 id="task-guide-title">{taskFriendlyTitle(record)}</h2></div><div className="flex flex-wrap gap-2">{priority&&<Badge variant="outline">{priority}</Badge>}<Badge variant="secondary">{taskTypeLabel(record)}</Badge></div></header>
  <div className="task-guide-grid">
   <InfoBlock icon={<Target className="size-4"/>} title="执行目标">{objective}</InfoBlock>
   <InfoBlock icon={<Check className="size-4"/>} title="完成验收">{acceptance||'尚未记录验收标准'}</InfoBlock>
   {reason&&<InfoBlock icon={<Lightbulb className="size-4"/>} title="为什么现在做">{reason}</InfoBlock>}
   {evidence&&<InfoBlock icon={<Link2 className="size-4"/>} title="需要留下的证据">{evidence}</InfoBlock>}
  </div>
  {steps.length>0&&<section className="task-items"><strong>怎么执行</strong><ol className="task-steps">{steps.map((step,index)=><li key={step}><span>{index+1}</span><p>{step}</p></li>)}</ol></section>}
  {prepared&&<section className="task-copy"><div className="task-copy-head"><div><strong>发布正文</strong><p className="mt-1 text-sm text-muted-foreground">完成上方准备后，把下面内容复制到发布平台。</p></div><CopyButton value={prepared}/></div><pre>{prepared}</pre></section>}
  {items.length>0&&<section className="task-items"><strong>目标与回复草稿</strong><div className="mt-3 space-y-3">{items.map((item,index)=><article key={`${item.target_url||item.title}-${index}`} className="task-item"><div className="task-copy-head"><div className="min-w-0"><p className="font-medium">{item.title||`目标 ${index+1}`}</p>{item.target_url&&<a href={item.target_url} target="_blank" rel="noreferrer" className="task-target-link">打开原帖</a>}</div>{item.copy&&<CopyButton value={item.copy}/>}</div>{item.copy&&<p className="mt-3 whitespace-pre-wrap text-secondary-foreground">{item.copy}</p>}</article>)}</div></section>}
 </section>
}
