'use client'

import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {AccountName} from '@/components/account-name'
import {accountLabel,accountPlatform} from '@/lib/account-label'
import {PlatformIcon} from '@/components/platform-icon'
import {ProductIcon} from '@/components/product-icon'
import {PageHeader} from '@/components/page-header'
import {AlertCircle,Archive,ChevronLeft,ChevronRight,ChevronsUpDown,Clock,Download,ExternalLink,FileJson,History,Loader2,Plus,RefreshCw,Save,Search,X} from 'lucide-react'
import type {ActionContext,Api,Field,OpsRecord,RecordPage,ResourceName} from '@/lib/types'
import {actionTypeLabel,displayDate,queryString,resources,statusLabels,taskTypes} from '@/lib/resources'
import {Alert,AlertDescription,AlertTitle} from '@/components/ui/alert'
import {Badge} from '@/components/ui/badge'
import {Button} from '@/components/ui/button'
import {Collapsible,CollapsibleContent,CollapsibleTrigger} from '@/components/ui/collapsible'
import {Input} from '@/components/ui/input'
import {Label} from '@/components/ui/label'
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select'
import {Separator} from '@/components/ui/separator'
import {Sheet,SheetContent,SheetDescription,SheetFooter,SheetHeader,SheetTitle} from '@/components/ui/sheet'
import {Skeleton} from '@/components/ui/skeleton'
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table'
import {Tabs,TabsContent,TabsList,TabsTrigger} from '@/components/ui/tabs'
import {Textarea} from '@/components/ui/textarea'
import {Tooltip,TooltipContent,TooltipProvider,TooltipTrigger} from '@/components/ui/tooltip'
import {TaskExecutionGuide,taskFriendlyTitle,taskListSummary,taskPriority,taskTypeLabel} from '@/components/task-presentation'

type Props={
 resource:ResourceName
 api:Api
 accountId:string
 revision?:number
 selectedId?:string
 onSelected:()=>void
 onChanged:()=>void
 onNavigate:(route:string,id?:string)=>void
}

type Draft={
 title:string
 account_id:string
 product_id:string
 status:string
 data:Record<string,unknown>
 json:string
 jsonTouched:boolean
 touchedTop:Set<'title'|'account_id'|'product_id'|'status'>
 touchedData:Set<string>
}

type RelationOptions=Partial<Record<ResourceName,OpsRecord[]>>
type FieldGroup='basic'|'evidence'|'links'

const PAGE_SIZE=10
const ALL_STATUSES=['active','planned','pending','in_progress','observing','review_due','published','partial','unknown','deleted','completed','done','success','failed','blocked','cancelled','draft','archived']
const NULL_SELECT='__null__'
const GROUP_LABELS:Record<FieldGroup,string>={basic:'基础',evidence:'证据',links:'关联'}
const READABLE_DATA_KEYS=['body','result','facts','hypothesis','next_steps','requirements','positioning','description','source','trigger','action_type','metric_name','verification_evidence']
const CONTEXT_LABELS:Record<string,string>={metrics:'指标',observations:'监测',reviews:'复盘',follow_up_tasks:'后续任务',follow_up_actions:'后续动作'}
const STRATEGY_RESOLUTION_LABELS:Record<ActionContext['strategy_resolution'],string>={exact:'精确策略版本',current_unpinned:'当前策略（旧动作未锁定版本）',missing:'缺少策略'}

function classNames(...values:Array<string|false|undefined|null>){return values.filter(Boolean).join(' ')}
function statusText(value:string){return statusLabels[value]||value||'未设置'}
function isHttpUrl(value:string){if(!value)return true;try{const url=new URL(value);return url.protocol==='http:'||url.protocol==='https:'}catch{return false}}
function formatDateTimeLocal(value:unknown){if(!value||typeof value!=='string')return '';const date=new Date(value);if(Number.isNaN(date.getTime()))return '';const offset=date.getTimezoneOffset();const local=new Date(date.getTime()-offset*60_000);return local.toISOString().slice(0,16)}
function localDateTimeToIso(value:string){if(!value)return null;const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toISOString()}
function stringifyData(data:Record<string,unknown>){return JSON.stringify(data,null,2)}
function makeIdempotencyKey(){return globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`}
const METRIC_NAME_LABELS:Record<string,string>={
 views:'曝光阅读',likes:'点赞',retweets:'转推',reposts:'转发',replies:'评论回复',bookmarks:'收藏',
 detail_expands:'详情展开',profile_visits:'主页访问',link_clicks:'链接点击',followers:'粉丝数',
 following:'关注数',downloads:'下载量',video_retention:'视频留存',meaningful_conversations:'有效对话'
}
function metricNameLabel(name:unknown){if(typeof name!=='string')return '';return METRIC_NAME_LABELS[name]||name}

function readableDataPreview(record:OpsRecord){
 if(record.resource==='tasks')return taskListSummary(record)
 if(record.resource==='metrics'){
  const d=record.data||{}
  const val=d.value!==undefined&&d.value!==null?Number(d.value).toLocaleString('zh-CN'):''
  const unit=d.unit?` ${d.unit}`:''
  const nameLabel=metricNameLabel(d.metric_name)
  const sourceStr=d.source?` (来源: ${d.source})`:''
  if(val!==''){
   return nameLabel?`${val}${unit} · ${nameLabel}${sourceStr}`:`${val}${unit}${sourceStr}`
  }
 }
 for(const key of READABLE_DATA_KEYS){
  if(key==='source'&&record.resource==='metrics')continue
  const value=record.data?.[key]
  if(typeof value==='string'&&value.trim())return value.trim()
  if(typeof value==='number')return String(value)
 }
 const value=Object.entries(record.data||{}).find(([k,item])=>k!=='source'&&typeof item==='string'&&item.trim())?.[1] as string|undefined
 return value?.trim()||''
}
function shortText(value:string,max=120){return value.length>max?`${value.slice(0,max)}...`:value}
const businessTimeColumns:Partial<Record<ResourceName,{label:string;fields:string[]}>>={
 tasks:{label:'任务时间',fields:['due_at','planned_on']},
 actions:{label:'发生时间',fields:['occurred_at','occurred_on']},
 contents:{label:'发布时间',fields:['published_at','published_on']},
 metrics:{label:'观测时间',fields:['observed_at']},
 reviews:{label:'复盘时间',fields:['period_end','period_start']},
 observations:{label:'监测时间',fields:['due_at']},
}
function displayBusinessDate(record:OpsRecord){
 const column=businessTimeColumns[record.resource]
 if(!column)return displayDate(record.updated_at)
 for(const field of column.fields){
  const value=record.data?.[field]
  if(typeof value!=='string'||!value)continue
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value.replaceAll('-','/')
  if(Number.isNaN(new Date(value).getTime()))continue
  return displayDate(value,record.resource==='metrics'?record.data.observed_at_precision:undefined)
 }
 return '未记录'
}


function isProductAssociated(product:OpsRecord,accountId?:string){
 if(!accountId)return true
 if(product.account_id===accountId)return true
 const list=product.data?.account_ids
 if(Array.isArray(list)&&list.includes(accountId))return true
 return false
}

function getRecordScope(item:OpsRecord,resource:ResourceName,accountId?:string):'account'|'platform'|'product'|'global'{
 const d=item.data||{}
 const rawScope=String(d.scope||d.strategy_scope||'').toLowerCase()
 if(item.account_id){
  if(accountId&&item.account_id===accountId)return 'account'
  if(!accountId)return 'account'
 }
 if(rawScope==='account')return 'account'
 if(rawScope==='platform'||d.platform_id)return 'platform'
 if(rawScope==='product'||item.product_id){
  if(accountId&&item.account_id===accountId)return 'account'
  return 'product'
 }
 return 'global'
}

function fieldGroup(field:Field):FieldGroup{return field.group||'basic'}
function groupedFields(fields:Field[]){return fields.reduce<Record<FieldGroup,Field[]>>((acc,field)=>{acc[fieldGroup(field)].push(field);return acc},{basic:[],evidence:[],links:[]})}

function createDraft(record:OpsRecord|null,resource:ResourceName,accountId:string):Draft{
 const definition=resources[resource]
 const data={...(record?.data||{})}
 if(!record&&resource==='metrics'){
  data.availability='valid'
  data.metric_type='cumulative'
 }
 return {
  title:record?.title||'',
  account_id:record?.account_id||(!definition.global?accountId:''),
  product_id:record?.product_id||'',
  status:record?.status||definition.defaultStatus,
  data,
  json:stringifyData(data),
  jsonTouched:false,
  touchedTop:new Set(),
  touchedData:new Set()
 }
}

function isDraftDifferent(currentDraft:Draft,initial:Draft|null):boolean{
 if(!initial)return false
 if(currentDraft.title.trim()!==initial.title.trim())return true
 if((currentDraft.account_id||'')!==(initial.account_id||''))return true
 if((currentDraft.product_id||'')!==(initial.product_id||''))return true
 if((currentDraft.status||'')!==(initial.status||''))return true
 if(currentDraft.jsonTouched&&currentDraft.json!==initial.json)return true
 if(JSON.stringify(currentDraft.data)!==JSON.stringify(initial.data))return true
 return false
}

async function fetchPage(api:Api,resource:ResourceName,params:Record<string,string|number|undefined|null>){
 return api<RecordPage>(`/${resource}${queryString(params)}`)
}

async function fetchAll(api:Api,resource:ResourceName,params:Record<string,string|number|undefined|null>={}){
 const items:OpsRecord[]=[]
 let offset=0
 for(;;){
  const page=await fetchPage(api,resource,{...params,limit:200,offset})
  items.push(...page.items)
  offset+=page.limit
  if(items.length>=page.total||page.items.length===0)break
 }
 return items
}

function fieldValueToInput(field:Field,value:unknown){
 if(field.type==='datetime')return formatDateTimeLocal(value)
 if(field.type==='boolean')return value===true
 if(field.type==='number')return value===null||value===undefined?'':String(value)
 return value===null||value===undefined?'':String(value)
}

function inputToFieldValue(field:Field,value:string|boolean){
 if(field.key==='task_type'&&value==='')return null
 if(field.type==='boolean')return Boolean(value)
 if(field.type==='number'){
  if(value==='')return null
  const parsed=Number(value)
  return Number.isFinite(parsed)?parsed:null
 }
 if(field.type==='datetime')return typeof value==='string'?localDateTimeToIso(value):null
 if(field.type==='relation')return value===NULL_SELECT?null:value
 return value
}

function findInvalidUrls(data:Record<string,unknown>){
 const invalid:string[]=[]
 Object.entries(data).forEach(([key,value])=>{
  if(typeof value==='string'&&value&&key.toLowerCase().includes('url')&&!isHttpUrl(value))invalid.push(key)
 })
 return invalid
}

export function ResourcePage({resource,api,accountId,revision,selectedId,onSelected,onChanged,onNavigate}:Props){
 const definition=resources[resource]
 const fields=useMemo(()=>groupedFields(definition.fields),[definition.fields])
 const isAssetResource=resource==='strategies'||resource==='knowledge'||resource==='skills'
 const [viewTab,setViewTab]=useState<'in_use'|'all'>('in_use')
 const [items,setItems]=useState<OpsRecord[]>([])
 const [total,setTotal]=useState(0)
 const [offset,setOffset]=useState(0)
 const [query,setQuery]=useState('')
 const [status,setStatus]=useState('all')
 const [productFilter,setProductFilter]=useState('all')
 const [taskTypeFilter,setTaskTypeFilter]=useState('all')
 const [timeField,setTimeField]=useState(definition.timeField||'created_at')
 const [dateFrom,setDateFrom]=useState('')
 const [dateTo,setDateTo]=useState('')
 const [loading,setLoading]=useState(false)
 const [hasLoaded,setHasLoaded]=useState(false)
 const [error,setError]=useState('')
 const [downloadingId,setDownloadingId]=useState<string|null>(null)
 const [downloadError,setDownloadError]=useState('')
 const [drawerOpen,setDrawerOpen]=useState(false)
 const [mode,setMode]=useState<'create'|'edit'>('create')
 const [current,setCurrent]=useState<OpsRecord|null>(null)
 const [draft,setDraft]=useState<Draft>(()=>createDraft(null,resource,accountId))
 const [dirty,setDirty]=useState(false)
 const [closeWarning,setCloseWarning]=useState(false)
 const [saving,setSaving]=useState(false)
 const [saveError,setSaveError]=useState('')
 const [navigationWarning,setNavigationWarning]=useState('')
 const [relationOptions,setRelationOptions]=useState<RelationOptions>({})
 const [relationsLoading,setRelationsLoading]=useState(false)
 const [history,setHistory]=useState<OpsRecord[]>([])
 const [context,setContext]=useState<ActionContext|null>(null)
 const [contextOffset,setContextOffset]=useState(0)
 const [contextLoading,setContextLoading]=useState(false)
 const [detailLoading,setDetailLoading]=useState(false)
 const createKeyRef=useRef(makeIdempotencyKey())
 const initialDraftRef=useRef<Draft|null>(null)
 const submittingRef=useRef(false)
 const listGeneration=useRef(0)
 const relationGeneration=useRef(0)
 const detailGeneration=useRef(0)
 const contextGeneration=useRef(0)

 const availableTimeFields=useMemo(()=>{
  const base=[{value:'created_at',label:'创建时间'},{value:'updated_at',label:'更新时间'}]
  if(definition.timeField)base.push({value:definition.timeField,label:definition.timeField==='review_period'?'复盘区间':'业务时间'})
  return base
 },[definition.timeField])
 const editStatusOptions=useMemo(()=>{
  const values=new Set(ALL_STATUSES)
  if(draft.status)values.add(draft.status)
  return Array.from(values)
 },[draft.status])

 const loadList=useCallback(async(nextOffset=0)=>{
  const generation=++listGeneration.current
  setLoading(true);setError('')
  try{
   const page=await fetchPage(api,resource,{
    account_id:resources[resource].global?undefined:accountId,
    product_id:!definition.global&&productFilter!=='all'?productFilter:undefined,
    task_type:resource==='tasks'&&taskTypeFilter!=='all'?taskTypeFilter:undefined,
    q:query||undefined,
    status:status==='all'?undefined:status,
    time_field:timeField,
    date_from:dateFrom?localDateTimeToIso(dateFrom):undefined,
    date_to:dateTo?localDateTimeToIso(dateTo):undefined,
    limit:isAssetResource?200:PAGE_SIZE,
    offset:isAssetResource?0:nextOffset
   })
   if(generation===listGeneration.current){setItems(page.items);setTotal(page.total);setOffset(nextOffset);setHasLoaded(true)}
  }catch(err){if(generation===listGeneration.current)setError(err instanceof Error?err.message:'列表加载失败')}
  finally{if(generation===listGeneration.current)setLoading(false)}
 },[accountId,api,dateFrom,dateTo,query,resource,status,timeField,productFilter,definition.global,taskTypeFilter,isAssetResource])

  useEffect(()=>{
   queueMicrotask(()=>{
    setOffset(0);setTimeField(definition.timeField||'created_at');setViewTab('in_use');setCurrent(null);setDrawerOpen(false)
   })
  },[definition.timeField,resource])
 useEffect(()=>{queueMicrotask(()=>{void loadList(0)})},[loadList,resource,accountId,revision])
 useEffect(()=>{
  function beforeNavigate(event:Event){
   if(!dirty)return
   event.preventDefault()
   setDrawerOpen(true)
   setNavigationWarning('请先保存或放弃更改，再切换页面。')
   setCloseWarning(true)
  }
  window.addEventListener('ops-before-navigate',beforeNavigate)
  return ()=>window.removeEventListener('ops-before-navigate',beforeNavigate)
 },[dirty])

 const loadRelations=useCallback(async()=>{
  const generation=++relationGeneration.current
  const targets=new Set<ResourceName>(['accounts','products','platforms'])
  definition.fields.forEach(field=>{if(field.type==='relation'&&field.relation)targets.add(field.relation)})
  setRelationsLoading(true)
  try{
   const pairs=await Promise.all(Array.from(targets).map(async target=>[target,await fetchAll(api,target,{account_id:resources[target].global?undefined:accountId})] as const))
   if(generation===relationGeneration.current)setRelationOptions(Object.fromEntries(pairs) as RelationOptions)
  }catch(err){if(generation===relationGeneration.current)setSaveError(err instanceof Error?err.message:'关联选项加载失败')}
  finally{if(generation===relationGeneration.current)setRelationsLoading(false)}
 },[accountId,api,definition.fields])

 useEffect(()=>{queueMicrotask(()=>{void loadRelations()})},[loadRelations,resource,accountId,revision])

 const loadActionContext=useCallback(async(id:string,nextOffset=0)=>{
  const generation=++contextGeneration.current
  setContextLoading(true)
  try{
   const value=await api<ActionContext>(`/actions/${id}/context${queryString({limit:20,offset:nextOffset})}`)
   if(generation===contextGeneration.current){setContext(value);setContextOffset(nextOffset)}
  }catch(err){if(generation===contextGeneration.current)setSaveError(err instanceof Error?err.message:'动作上下文加载失败')}
  finally{if(generation===contextGeneration.current)setContextLoading(false)}
 },[api])

 const openCreate=useCallback(()=>{
  const initialDraft=createDraft(null,resource,accountId)
  if(isAssetResource){
   initialDraft.status='active'
   if(accountId){
    initialDraft.account_id=accountId
    initialDraft.data.scope='account'
   }else{
    initialDraft.data.scope='global'
   }
  }
  initialDraftRef.current=initialDraft
  setMode('create');setCurrent(null);setDraft(initialDraft);setDirty(false);setCloseWarning(false);setNavigationWarning('');setSaveError('');setHistory([]);setContext(null);createKeyRef.current=makeIdempotencyKey();setDrawerOpen(true);void loadRelations()
 },[accountId,isAssetResource,loadRelations,resource])

 const openRecord=useCallback(async(id:string)=>{
  if(dirty){setNavigationWarning('请先保存或放弃更改，再打开其他记录。');setCloseWarning(true);return}
  const generation=++detailGeneration.current
  setMode('edit');setCurrent(null);setDrawerOpen(true);setDetailLoading(true);setCloseWarning(false);setNavigationWarning('');setSaveError('');setHistory([]);setContext(null);void loadRelations()
  try{
   const detail=await api<{item:OpsRecord}>(`/${resource}/${id}`)
   if(generation!==detailGeneration.current)return
   const initialDraft=createDraft(detail.item,resource,accountId)
   initialDraftRef.current=initialDraft
   setCurrent(detail.item);setDraft(initialDraft);setDirty(false)
   if(resource==='strategies'||resource==='skills'){
    const value=await api<{items:OpsRecord[]}>(`/${resource}/${id}/history`)
    if(generation===detailGeneration.current)setHistory(value.items)
   }
   if(resource==='actions'){
    await loadActionContext(id,0)
   }
  }catch(err){if(generation===detailGeneration.current)setSaveError(err instanceof Error?err.message:'详情加载失败')}
  finally{if(generation===detailGeneration.current)setDetailLoading(false)}
 },[accountId,api,dirty,loadActionContext,loadRelations,resource])

 useEffect(()=>{if(selectedId)queueMicrotask(()=>{void openRecord(selectedId);onSelected()})},[onSelected,openRecord,selectedId])

 const setTopValue=useCallback((key:'title'|'account_id'|'product_id'|'status',value:string)=>{
  setDraft(previous=>{
   const next={...previous,[key]:value,touchedTop:new Set(previous.touchedTop)}
   next.touchedTop.add(key)
   const changed=isDraftDifferent(next,initialDraftRef.current)
   setDirty(changed)
   if(!changed)setCloseWarning(false)
   return next
  })
  setNavigationWarning('')
 },[])

 const setDataValue=useCallback((field:Field,value:string|boolean)=>{
  setDraft(previous=>{
   const nextData={...previous.data,[field.key]:inputToFieldValue(field,value)}
   const touchedData=new Set(previous.touchedData);touchedData.add(field.key)
   if(resource==='metrics'&&field.key==='availability'&&typeof value==='string'&&value!=='valid'){
    nextData.value=null
    touchedData.add('value')
   }
   const next={...previous,data:nextData,json:previous.jsonTouched?previous.json:stringifyData(nextData),touchedData}
   const changed=isDraftDifferent(next,initialDraftRef.current)
   setDirty(changed)
   if(!changed)setCloseWarning(false)
   return next
  })
  setNavigationWarning('')
 },[resource])

 const setJsonValue=useCallback((value:string)=>{
  setDraft(previous=>{
   const next={...previous,json:value,jsonTouched:true}
   const changed=isDraftDifferent(next,initialDraftRef.current)
   setDirty(changed)
   if(!changed)setCloseWarning(false)
   return next
  })
  setNavigationWarning('')
 },[])

 const discardAndClose=useCallback(()=>{
  initialDraftRef.current=null
  setDirty(false);setCloseWarning(false);setNavigationWarning('');setDrawerOpen(false)
 },[])

 const requestClose=useCallback((open:boolean)=>{
  if(open){setDrawerOpen(true);return}
  if(dirty){
   if(closeWarning){
    discardAndClose()
    return
   }
   setCloseWarning(true)
   return
  }
  setDrawerOpen(false)
 },[closeWarning,dirty,discardAndClose])

 const validateDraft=useCallback(()=>{
  if(!draft.title.trim())return '标题不能为空'
  const dataToValidate=draft.jsonTouched?(()=>{try{return JSON.parse(draft.json) as unknown}catch{return null}})():draft.data
  if(!dataToValidate)return '高级 JSON 不是合法 JSON'
  if(Array.isArray(dataToValidate)||typeof dataToValidate!=='object')return '高级 JSON 必须是对象'
  const invalidUrls=findInvalidUrls(dataToValidate as Record<string,unknown>)
  if(invalidUrls.length)return `外部链接只允许 http 或 https：${invalidUrls.join(', ')}`
  return ''
 },[draft])

 const save=useCallback(async()=>{
  if(submittingRef.current)return
  if(mode==='edit'&&!current){setSaveError('记录尚未加载成功，请关闭后重试。');return}
  const validation=validateDraft()
  if(validation){setSaveError(validation);return}
  submittingRef.current=true;setSaving(true);setSaveError('')
  try{
   const parsedData=draft.jsonTouched?JSON.parse(draft.json) as Record<string,unknown>:{...draft.data}
   if(resource==='metrics'&&parsedData.availability!=='valid')parsedData.value=null
   const topPayload:Record<string,unknown>={}
   const dataPayload:Record<string,unknown>={}
   if(mode==='create'){
    topPayload.title=draft.title.trim()
    topPayload.account_id=draft.account_id||null
    topPayload.product_id=draft.product_id||null
    topPayload.status=draft.status||definition.defaultStatus
    topPayload.data=parsedData
    await api<{item:OpsRecord}>(`/${resource}`,{method:'POST',headers:{'Idempotency-Key':createKeyRef.current},body:JSON.stringify(topPayload)})
    createKeyRef.current=makeIdempotencyKey()
   }else if(current){
    draft.touchedTop.forEach(key=>{topPayload[key]=key==='title'?draft[key].trim():(draft[key]||null)})
    if(draft.jsonTouched)topPayload.data=parsedData
    else draft.touchedData.forEach(key=>{dataPayload[key]=parsedData[key]})
    if(resource==='metrics'&&draft.touchedData.has('availability')&&parsedData.availability!=='valid')dataPayload.value=null
    if(Object.keys(dataPayload).length)topPayload.data=dataPayload
    topPayload.version=current.version
    await api<{item:OpsRecord}>(`/${resource}/${current.id}`,{method:'PATCH',body:JSON.stringify(topPayload)})
   }
   initialDraftRef.current=null
   setDirty(false);setCloseWarning(false);setNavigationWarning('');setDrawerOpen(false);onChanged();void loadList(offset)
  }catch(err){setSaveError(err instanceof Error?err.message:'保存失败')}
  finally{submittingRef.current=false;setSaving(false)}
 },[api,current,definition.defaultStatus,draft,loadList,mode,offset,onChanged,resource,validateDraft])


 const downloadSkill=async(item:OpsRecord)=>{
  if(downloadingId)return
  setDownloadingId(item.id);setDownloadError('')
  try{
   const blob=await api<Blob>(`/skills/${encodeURIComponent(item.id)}/download`)
   const slug=String(item.data.slug||item.id).toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64)||'shared-skill'
   const url=URL.createObjectURL(blob);const link=document.createElement('a')
   link.href=url;link.download=`${slug}-v${item.version}.zip`;document.body.appendChild(link);link.click();link.remove()
   setTimeout(()=>URL.revokeObjectURL(url),1000)
  }catch(err){setDownloadError(err instanceof Error?err.message:'下载失败，请重试')}
  finally{setDownloadingId(null)}
 }
 const renderOperatingTarget=(item:OpsRecord)=>{
  const product=relationOptions.products?.find(record=>record.id===item.product_id)
  const account=relationOptions.accounts?.find(record=>record.id===item.account_id)
  const name=item.product_id?(product?.title||'产品加载中'):account?.title||(item.account_id?'账号加载中':'未指定对象')
  return <span className="inline-flex max-w-full items-center gap-2" title={name}>
   {item.product_id?<ProductIcon api={api} productId={item.product_id} revision={revision} size={22}/>:account?<PlatformIcon name={accountPlatform(account,relationOptions.platforms||[])}/>:null}
   <span className="truncate">{name}</span>
  </span>
 }

 const renderField=useCallback((field:Field)=>{
  const value=fieldValueToInput(field,draft.data[field.key])
  const id=`field-${field.key}`
  if(field.type==='textarea')return <Textarea id={id} value={String(value)} onChange={event=>setDataValue(field,event.target.value)} className="min-h-28 resize-y" />
  if(field.type==='select')return <Select value={String(value||NULL_SELECT)} onValueChange={next=>setDataValue(field,next===NULL_SELECT?'':next)}><SelectTrigger id={id}><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NULL_SELECT}>未设置</SelectItem>{field.options?.map(option=><SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>
  if(field.type==='boolean')return <label htmlFor={id} className="flex h-10 items-center gap-3 rounded-md border px-3 text-sm"><input id={id} type="checkbox" checked={Boolean(value)} onChange={event=>setDataValue(field,event.target.checked)} className="size-4 accent-primary" />{Boolean(value)?'是':'否'}</label>
  if(field.type==='relation'&&field.relation)return <Select value={String(value||NULL_SELECT)} onValueChange={next=>setDataValue(field,next===NULL_SELECT?'':next)}><SelectTrigger id={id}><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NULL_SELECT}>未关联</SelectItem>{relationOptions[field.relation]?.map(option=><SelectItem key={option.id} value={option.id}>{option.title}</SelectItem>)}</SelectContent></Select>
  if(field.type==='number')return <Input id={id} type="number" value={String(value)} onChange={event=>setDataValue(field,event.target.value)} placeholder="空值表示未知，0 表示真实为 0" />
  if(field.type==='datetime')return <Input id={id} type="datetime-local" value={String(value)} onChange={event=>setDataValue(field,event.target.value)} />
  return <Input id={id} value={String(value)} onChange={event=>setDataValue(field,event.target.value)} />
 },[draft.data,relationOptions,setDataValue])

 const isRecordInUse=useCallback((item:OpsRecord)=>{
  if(item.status!=='active')return false
  if(!accountId)return true
  if(item.account_id)return item.account_id===accountId

  const d=item.data||{}
  const rawScope=String(d.scope||d.strategy_scope||'').toLowerCase()
  if(rawScope==='account')return item.account_id===accountId

  if(rawScope==='platform'||d.platform_id){
   const currentAccount=relationOptions.accounts?.find(a=>a.id===accountId)
   const accountPlatformId=String(currentAccount?.data?.platform_id||'')
   if(d.platform_id&&accountPlatformId){
    return String(d.platform_id)===accountPlatformId
   }
   return true
  }

  if(rawScope==='product'||item.product_id){
   if(item.product_id&&relationOptions.products){
    const product=relationOptions.products.find(p=>p.id===item.product_id)
    if(product)return isProductAssociated(product,accountId)
   }
   return true
  }

  return true
 },[accountId,relationOptions.accounts,relationOptions.products])

 const inUseItems=useMemo(()=>{
  if(!isAssetResource)return items
  return items.filter(isRecordInUse)
 },[isAssetResource,items,isRecordInUse])

 const displayedItems=useMemo(()=>{
  if(!isAssetResource)return items
  if(viewTab==='in_use')return inUseItems
  return items
 },[isAssetResource,items,inUseItems,viewTab])

 const renderScopeBadge=(item:OpsRecord)=>{
  const s=getRecordScope(item,resource,accountId)
  if(s==='account')return <Badge variant="outline" className="rounded-md border-emerald-500/30 text-emerald-600 bg-emerald-500/10">本账号专属</Badge>
  if(s==='platform')return <Badge variant="outline" className="rounded-md border-blue-500/30 text-blue-600 bg-blue-500/10">平台策略</Badge>
  if(s==='product')return <Badge variant="outline" className="rounded-md border-purple-500/30 text-purple-600 bg-purple-500/10">产品策略</Badge>
  return <Badge variant="outline" className="rounded-md border-zinc-500/30 text-zinc-600 bg-zinc-500/10">全局共享</Badge>
 }

 const currentTotal=isAssetResource?displayedItems.length:total
 const pageStart=currentTotal===0?0:offset+1
 const pageEnd=Math.min(offset+PAGE_SIZE,currentTotal)
 const pagedItems=isAssetResource?displayedItems.slice(offset,offset+PAGE_SIZE):items

 return <TooltipProvider>
  <section className="records-page flex min-h-0 flex-1 flex-col gap-5">
   <PageHeader title={definition.label} description={definition.description} count={currentTotal} actions={<>
    <Tooltip><TooltipTrigger asChild><Button aria-label="刷新" variant="outline" size="icon" onClick={()=>loadList(offset)} disabled={loading}><RefreshCw className={classNames('size-4',loading&&'animate-spin')} /></Button></TooltipTrigger><TooltipContent>刷新</TooltipContent></Tooltip>
    <Button onClick={openCreate} className="gap-2"><Plus className="size-4" />新建{definition.singular}</Button>
   </>} />

   <div className="surface records-table records-card">
   {isAssetResource&&(
    <div className="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
     <Tabs value={viewTab} onValueChange={v=>{setViewTab(v as 'in_use'|'all');setOffset(0)}}>
      <TabsList>
       <TabsTrigger value="in_use" className="gap-1.5">
        正在使用中
        <span className="text-xs text-muted-foreground ml-1">({inUseItems.length})</span>
       </TabsTrigger>
       <TabsTrigger value="all" className="gap-1.5">
        全部
        <span className="text-xs text-muted-foreground ml-1">({items.length})</span>
       </TabsTrigger>
      </TabsList>
     </Tabs>
    </div>
   )}

   <Collapsible>
    <div className="records-toolbar">
     <div className="compact-filter-row">
      <div className="relative filter-search">
       <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
       <Input aria-label="搜索记录" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')void loadList(0)}} placeholder="搜索记录..." className="pl-9" />
      </div>
      <Select value={status} onValueChange={value=>{setStatus(value);setOffset(0)}}>
       <SelectTrigger aria-label="状态筛选" className="filter-select"><SelectValue /></SelectTrigger>
       <SelectContent><SelectItem value="all">全部状态</SelectItem>{ALL_STATUSES.map(item=><SelectItem key={item} value={item}>{statusText(item)}</SelectItem>)}</SelectContent>
      </Select>
      {resource==='tasks'&&<Select value={taskTypeFilter} onValueChange={value=>{setTaskTypeFilter(value);setOffset(0)}}>
       <SelectTrigger aria-label="任务类型筛选" className="filter-select"><SelectValue /></SelectTrigger>
       <SelectContent><SelectItem value="all">全部类型</SelectItem><SelectItem value="unclassified">未分类</SelectItem>{taskTypes.map(type=><SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>)}</SelectContent>
      </Select>}
      {!definition.global&&<Select value={productFilter} onValueChange={value=>{setProductFilter(value);setOffset(0)}}>
       <SelectTrigger aria-label="产品筛选" className="filter-product"><SelectValue placeholder="全部产品" /></SelectTrigger>
       <SelectContent><SelectItem value="all">全部产品</SelectItem>{relationOptions.products?.map(product=><SelectItem key={product.id} value={product.id}>{product.title}</SelectItem>)}</SelectContent>
      </Select>}
      <CollapsibleTrigger asChild><Button type="button" variant="outline" className="gap-2"><Clock className="size-4" />时间筛选</Button></CollapsibleTrigger>
      <Button variant="secondary" onClick={()=>loadList(0)}>筛选</Button>
     </div>
     <CollapsibleContent className="pt-3">
      <div className="compact-filter-row">
       <Select value={timeField} onValueChange={value=>setTimeField(value)}>
        <SelectTrigger aria-label="时间字段" className="filter-select"><SelectValue /></SelectTrigger>
        <SelectContent>{availableTimeFields.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
       </Select>
       <Input className="filter-datetime" type="datetime-local" value={dateFrom} onChange={event=>setDateFrom(event.target.value)} aria-label="开始时间" />
       <span className="filter-date-separator" aria-hidden="true">至</span>
       <Input className="filter-datetime" type="datetime-local" value={dateTo} onChange={event=>setDateTo(event.target.value)} aria-label="结束时间" />
      </div>
     </CollapsibleContent>
    </div>
   </Collapsible>

   {error&&<Alert variant="destructive"><AlertCircle className="size-4" /><AlertTitle>加载失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}

    {downloadError&&<Alert variant="destructive"><AlertDescription>{downloadError}</AlertDescription></Alert>}
    <span role="status" className="sr-only">{loading?(hasLoaded?'正在更新记录':'正在加载记录'):''}</span>
    <Table aria-busy={loading} className="resource-table" style={{minWidth:resource==='tasks'?1210:resource==='contents'?1080:resource==='actions'?1220:870}}>
     <colgroup><col style={{width:300}}/><col style={{width:110}}/>{isAssetResource&&<col style={{width:120}}/>}{resource==='tasks'&&<col style={{width:130}}/>}{(resource==='tasks'||resource==='contents')&&<col style={{width:210}}/>}{resource==='actions'&&<><col style={{width:140}}/><col style={{width:210}}/></>}<col style={{width:160}}/><col/>{resource==='skills'&&<col style={{width:140}}/>}</colgroup>
     <TableHeader>
      <TableRow className="bg-muted/60">
       <TableHead className="frozen-title">标题</TableHead>
       <TableHead>状态</TableHead>
       {isAssetResource&&<TableHead>所属范围</TableHead>}
       {resource==='tasks'&&<TableHead>任务类型</TableHead>}
       {(resource==='tasks'||resource==='contents')&&<TableHead>运营对象</TableHead>}
       {resource==='actions'&&<><TableHead>动作类型</TableHead><TableHead>运营对象</TableHead></>}
        <TableHead>{businessTimeColumns[resource]?.label||'更新时间'}</TableHead>
        <TableHead>{resource==='metrics'?'指标数值 / 表现':'摘要'}</TableHead>
        {resource==='skills'&&<TableHead>操作</TableHead>}
       </TableRow>
      </TableHeader>
      <TableBody>
       {loading&&!hasLoaded&&Array.from({length:PAGE_SIZE}).map((_,index)=><TableRow key={index}><TableCell colSpan={(resource==='actions'||resource==='tasks'?6:resource==='contents'||resource==='skills'?5:4)+(isAssetResource?1:0)}><Skeleton className="h-8 w-full" /></TableCell></TableRow>)}
       {hasLoaded&&pagedItems.length===0&&<TableRow><TableCell colSpan={(resource==='actions'||resource==='tasks'?6:resource==='contents'||resource==='skills'?5:4)+(isAssetResource?1:0)} className="table-empty-cell py-6">
         {isAssetResource&&viewTab==='in_use'?(
          <div className="flex flex-col items-center justify-center gap-1.5 py-2">
           <span>当前账号暂无使用中的{definition.label}</span>
           {items.length>0&&<Button variant="link" size="sm" className="h-auto p-0 text-xs text-primary" onClick={()=>setViewTab('all')}>查看全部 ({items.length})</Button>}
          </div>
         ):'暂无记录'}
        </TableCell></TableRow>}
       {pagedItems.map(item=><TableRow key={item.id} className="hover:bg-muted">
        <TableCell className="frozen-title"><Tooltip delayDuration={250}><TooltipTrigger asChild><button type="button" className="block w-full truncate rounded-sm text-left font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>openRecord(item.id)}>{resource==='accounts'?<AccountName account={item} platforms={relationOptions.platforms||[]}/>:resource==='tasks'?taskFriendlyTitle(item):item.title}</button></TooltipTrigger><TooltipContent className="record-full-text" side="bottom" align="start" sideOffset={8}>{resource==='tasks'?taskFriendlyTitle(item):item.title}</TooltipContent></Tooltip></TableCell>
        <TableCell><Badge data-status={item.status} variant={item.status==='archived'?'outline':'secondary'} className="rounded-md">{statusText(item.status)}</Badge></TableCell>
        {isAssetResource&&<TableCell>{renderScopeBadge(item)}</TableCell>}
        {resource==='tasks'&&<TableCell><div className="flex items-center gap-2"><Badge variant="outline" className="rounded-md">{taskTypeLabel(item)}</Badge>{taskPriority(item)&&<span className="text-xs text-muted-foreground">{taskPriority(item)}</span>}</div></TableCell>}
        {(resource==='tasks'||resource==='contents')&&<TableCell className="text-sm text-secondary-foreground">{renderOperatingTarget(item)}</TableCell>}
        {resource==='actions'&&<TableCell className="text-sm text-secondary-foreground"><span className="block truncate" title={actionTypeLabel(item.data.action_type||item.data.type||item.data.kind)}>{actionTypeLabel(item.data.action_type||item.data.type||item.data.kind)}</span></TableCell>}
        {resource==='actions'&&<TableCell className="text-sm text-secondary-foreground">{renderOperatingTarget(item)}</TableCell>}
        <TableCell className="text-sm text-secondary-foreground">{displayBusinessDate(item)}</TableCell>
        <TableCell className="text-sm text-muted-foreground">
         {resource==='metrics'?(
          <div className="flex items-center gap-2">
           <span className="font-semibold text-foreground text-sm tabular-nums">
            {item.data.value!==undefined&&item.data.value!==null?Number(item.data.value).toLocaleString('zh-CN'):'—'}
           </span>
           {Boolean(item.data.metric_name)&&(
            <Badge variant="outline" className="text-[11px] font-normal px-1.5 py-0 text-muted-foreground">
             {metricNameLabel(item.data.metric_name)}
            </Badge>
           )}
           {Boolean(item.data.source)&&(
            <span className="text-[11px] text-muted-foreground/60 hidden md:inline">
             来源: {String(item.data.source)}
            </span>
           )}
          </div>
         ):(
          <Tooltip delayDuration={250}><TooltipTrigger asChild><span tabIndex={0} className="block truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">{readableDataPreview(item)||'无摘要'}</span></TooltipTrigger><TooltipContent className="record-full-text" side="bottom" align="start" sideOffset={8}>{readableDataPreview(item)||'无摘要'}</TooltipContent></Tooltip>
         )}
        </TableCell>
       {resource==='skills'&&<TableCell><Button variant="outline" size="sm" disabled={downloadingId!==null} onClick={()=>void downloadSkill(item)}><Download size={14}/>{downloadingId===item.id?'下载中…':'下载 Skill'}</Button></TableCell>}
      </TableRow>)}
     </TableBody>
    </Table>
   <div className="table-footer">
    <span>{currentTotal === 0 ? "共 0 条记录" : `第 ${pageStart}–${pageEnd} 条，共 ${currentTotal} 条`}</span>
    <div className="flex gap-2">
     <Button variant="outline" size="sm" onClick={()=>isAssetResource?setOffset(Math.max(0,offset-PAGE_SIZE)):loadList(Math.max(0,offset-PAGE_SIZE))} disabled={offset<=0||loading}><ChevronLeft className="size-4" />上一页</Button>
     <Button variant="outline" size="sm" onClick={()=>isAssetResource?setOffset(offset+PAGE_SIZE):loadList(offset+PAGE_SIZE)} disabled={offset+PAGE_SIZE>=currentTotal||loading}>下一页<ChevronRight className="size-4" /></Button>
    </div>
   </div>
   </div>

   <Sheet open={drawerOpen} onOpenChange={requestClose}>
    <SheetContent showCloseButton={false} className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
     <SheetHeader className="border-b px-6 py-5">
      <div className="flex items-start justify-between gap-3">
       <div>
        <SheetTitle>{mode==='create'?`新建${definition.singular}`:current?(resource==='tasks'?taskFriendlyTitle(current):current.title):definition.singular}</SheetTitle>
        <SheetDescription>{mode==='edit'&&current?`更新于 ${displayDate(current.updated_at)}`:'记录一次可复盘的运营事实'}</SheetDescription>
       </div>
       <Tooltip><TooltipTrigger asChild><Button aria-label="关闭" variant="ghost" size="icon" onClick={()=>requestClose(false)}><X className="size-4" /></Button></TooltipTrigger><TooltipContent>关闭</TooltipContent></Tooltip>
      </div>
     </SheetHeader>

     {resource==='skills'&&current&&<div className="border-b px-6 py-3"><Button variant="outline" disabled={dirty||downloadingId!==null} onClick={()=>void downloadSkill(current)}><Download size={16}/>{downloadingId===current.id?'下载中…':'下载 Skill'}</Button><p className="mt-2 text-sm text-muted-foreground">{dirty?'保存更改后可下载。':'下载已保存版本的 ZIP 包，包含 SKILL.md 和随包参考文件，可直接转交他人。'}</p>{downloadError&&<p role="alert" className="mt-2 text-sm text-destructive">{downloadError}</p>}</div>}
      {closeWarning&&(
       <div role="alert" className="animate-in fade-in slide-in-from-top-1 duration-200 border-b border-amber-500/30 bg-amber-500/10 px-6 py-3 dark:border-amber-500/20 dark:bg-amber-950/35">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
         <div className="flex items-start gap-2.5 min-w-0">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-0.5 min-w-0">
           <div className="text-xs font-semibold text-amber-900 dark:text-amber-200">有未保存修改</div>
           <div className="text-xs leading-relaxed text-amber-800/80 dark:text-amber-300/80">
            {navigationWarning||'继续编辑或放弃草稿，再次点击关闭将直接放弃。'}
           </div>
          </div>
         </div>
         <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
          <Button size="sm" variant="outline" className="h-7 px-3 text-xs" onClick={()=>{setCloseWarning(false);setNavigationWarning('')}}>保留草稿</Button>
          <Button size="sm" variant="outline" className="h-7 px-3 text-xs border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={discardAndClose}>放弃修改</Button>
          <Button size="sm" className="h-7 px-3 text-xs font-medium" onClick={save} disabled={saving||detailLoading||(mode==='edit'&&!current)}>保存并关闭</Button>
         </div>
        </div>
       </div>
      )}
     {detailLoading?<div className="space-y-4 p-6"><Skeleton className="h-10 w-full" /><Skeleton className="h-32 w-full" /><Skeleton className="h-48 w-full" /></div>:<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {saveError&&<Alert variant="destructive" className="mb-4"><AlertCircle className="size-4" /><AlertTitle>无法保存</AlertTitle><AlertDescription>{saveError}</AlertDescription></Alert>}
      {relationsLoading&&<div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在加载关联选项</div>}

      <div className="editor-form space-y-5">
       {resource==='tasks'&&current&&<TaskExecutionGuide record={current}/>}
        <div className="grid gap-4 md:grid-cols-2">
         <div className="space-y-2 md:col-span-2"><Label htmlFor="title">标题</Label><Input id="title" value={draft.title} onChange={event=>setTopValue('title',event.target.value)} /></div>
         {isAssetResource&&(
          <div className="space-y-2 md:col-span-2"><Label htmlFor="scope">所属范围</Label><Select value={String(draft.data.scope||draft.data.strategy_scope||(draft.account_id?'account':'global'))} onValueChange={value=>{
           setDataValue({key:'scope',label:'所属范围',type:'text'},value)
           if(value==='account'&&accountId&&!draft.account_id){
            setTopValue('account_id',accountId)
           }else if(value==='global'||value==='platform'){
            setTopValue('account_id','')
           }
          }}><SelectTrigger id="scope"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="account">本账号专属</SelectItem>{resource==='strategies'&&<SelectItem value="platform">平台策略</SelectItem>}<SelectItem value="global">全局共享</SelectItem></SelectContent></Select></div>
         )}
         <div className="space-y-2"><Label htmlFor="account">账号</Label><Select value={draft.account_id||NULL_SELECT} onValueChange={value=>setTopValue('account_id',value===NULL_SELECT?'':value)}><SelectTrigger id="account"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NULL_SELECT}>{definition.global?'全局记录':'未关联'}</SelectItem>{relationOptions.accounts?.map(option=><SelectItem key={option.id} value={option.id} aria-label={accountLabel(option,relationOptions.platforms||[])}><AccountName account={option} platforms={relationOptions.platforms||[]}/></SelectItem>)}</SelectContent></Select></div>
         <div className="space-y-2"><Label htmlFor="product">产品</Label><Select value={draft.product_id||NULL_SELECT} onValueChange={value=>setTopValue('product_id',value===NULL_SELECT?'':value)}><SelectTrigger id="product"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NULL_SELECT}>未关联</SelectItem>{relationOptions.products?.map(option=><SelectItem key={option.id} value={option.id}>{option.title}</SelectItem>)}</SelectContent></Select></div>
         <div className="space-y-2"><Label htmlFor="status">状态</Label><Select value={draft.status||definition.defaultStatus} onValueChange={value=>setTopValue('status',value)}><SelectTrigger id="status"><SelectValue /></SelectTrigger><SelectContent>{editStatusOptions.map(item=><SelectItem key={item} value={item}>{statusText(item)}</SelectItem>)}</SelectContent></Select></div>
        </div>

       <Tabs defaultValue="basic" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
         {(['basic','evidence','links'] as FieldGroup[]).map(group=><TabsTrigger key={group} value={group}>{GROUP_LABELS[group]}<span className="ml-1 text-xs text-muted-foreground">{fields[group].length}</span></TabsTrigger>)}
        </TabsList>
        {(['basic','evidence','links'] as FieldGroup[]).map(group=><TabsContent key={group} value={group} className="mt-4 space-y-4">
         {fields[group].length===0?<div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">本组暂无字段</div>:fields[group].map(field=><div key={field.key} className="space-y-2"><Label htmlFor={`field-${field.key}`}>{field.label}</Label>{renderField(field)}</div>)}
        </TabsContent>)}
       </Tabs>

       {resource==='actions'&&context&&current&&<ActionContextPanel context={context} offset={contextOffset} loading={contextLoading} onPage={next=>loadActionContext(current.id,next)} onNavigate={onNavigate} />}
       {(resource==='strategies'||resource==='skills')&&history.length>0&&<HistoryPanel items={history} />}

       <Collapsible>
        <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="w-full justify-between px-0"><span className="flex items-center gap-2"><FileJson className="size-4" />高级 JSON / 版本信息</span><ChevronsUpDown className="size-4" /></Button></CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 pt-3">
         <Textarea value={draft.json} onChange={event=>setJsonValue(event.target.value)} className="min-h-48 font-mono text-xs" />
         {current&&<div className="grid gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground md:grid-cols-2"><div>ID：{current.id}</div><div>Version：{current.version}</div><div>Created：{current.created_at}</div><div>Updated：{current.updated_at}</div></div>}
        </CollapsibleContent>
       </Collapsible>
      </div>
     </div>}

     <SheetFooter className="border-t px-6 py-4">
      {mode==='edit'&&current?.status!=='archived'&&<Button type="button" variant="outline" onClick={()=>setTopValue('status','archived')} className="mr-auto gap-2"><Archive className="size-4" />归档</Button>}
      <Button type="button" variant="outline" onClick={()=>requestClose(false)}>关闭</Button>
      <Button type="button" onClick={save} disabled={saving||detailLoading||(mode==='edit'&&!current)} className="gap-2">{saving?<Loader2 className="size-4 animate-spin" />:<Save className="size-4" />}保存</Button>
     </SheetFooter>
    </SheetContent>
   </Sheet>
  </section>
 </TooltipProvider>
}

function LinkedRecord({record,label,onNavigate}:{record:OpsRecord|null;label:string;onNavigate:(route:string,id?:string)=>void}){
 if(!record)return <div className="text-sm text-muted-foreground">{label}：未关联</div>
 const preview=readableDataPreview(record)
 return <button type="button" className="flex w-full items-start justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted" onClick={()=>onNavigate(record.resource,record.id)}><span className="min-w-0"><span className="text-muted-foreground">{label}：</span>{record.title}{preview&&<span className="mt-1 block truncate text-xs text-muted-foreground">{shortText(preview)}</span>}</span><ExternalLink className="mt-0.5 size-4 shrink-0 text-muted-foreground" /></button>
}

function ActionContextPanel({context,offset,loading,onPage,onNavigate}:{context:ActionContext;offset:number;loading:boolean;onPage:(offset:number)=>void;onNavigate:(route:string,id?:string)=>void}){
 const collectionEntries=Object.entries(context.collections||{})
 return <div className="rounded-lg border bg-muted/40 p-4">
  <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Clock className="size-4" />动作上下文</div>
  <div className="space-y-2">
   <LinkedRecord record={context.task} label="任务" onNavigate={onNavigate} />
   <LinkedRecord record={context.strategy} label={STRATEGY_RESOLUTION_LABELS[context.strategy_resolution]} onNavigate={onNavigate} />
   <LinkedRecord record={context.content} label="内容" onNavigate={onNavigate} />
   <LinkedRecord record={context.parent_action} label="前序动作" onNavigate={onNavigate} />
  </div>
  {collectionEntries.length>0&&<><Separator className="my-3" /><div className="space-y-3">{collectionEntries.map(([name,page])=><div key={name} className="rounded-md bg-card p-3 text-sm"><div className="flex items-center justify-between gap-2"><div className="font-medium text-secondary-foreground">{CONTEXT_LABELS[name]||name} · {page.total}</div><div className="text-xs text-muted-foreground">{page.total===0?'0':`${page.offset+1}-${Math.min(page.offset+page.items.length,page.total)}`}</div></div><div className="mt-2 space-y-1 text-muted-foreground">{page.items.length===0?<div>暂无记录</div>:page.items.map(item=><button key={item.id} type="button" className="block w-full truncate rounded px-1 py-0.5 text-left hover:bg-muted hover:text-foreground" onClick={()=>onNavigate(item.resource,item.id)}>{item.title}{readableDataPreview(item)&&<span className="ml-2 text-xs text-muted-foreground">{shortText(readableDataPreview(item),60)}</span>}</button>)}</div></div>)}</div><div className="mt-3 flex justify-end gap-2"><Button type="button" variant="outline" size="sm" disabled={offset<=0||loading} onClick={()=>onPage(Math.max(0,offset-20))}>上一批</Button><Button type="button" variant="outline" size="sm" disabled={loading||!collectionEntries.some(([,page])=>page.offset+page.limit<page.total)} onClick={()=>onPage(offset+20)}>{loading&&<Loader2 className="size-3 animate-spin" />}下一批</Button></div></>}
 </div>
}

function HistoryPanel({items}:{items:OpsRecord[]}){
 return <div className="rounded-lg border p-4">
  <div className="mb-3 flex items-center gap-2 text-sm font-medium"><History className="size-4" />历史版本</div>
  <div className="space-y-3">
   {items.map(item=><div key={`${item.id}-${item.version}`} className="rounded-md bg-muted p-3">
    <div className="flex items-center justify-between text-sm"><span className="font-medium">v{item.version}</span><span className="text-muted-foreground">{displayDate(item.updated_at)}</span></div>
    <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-secondary-foreground">{typeof item.data.body==='string'?item.data.body:readableDataPreview(item)}</p>
   </div>)}
  </div>
 </div>
}
