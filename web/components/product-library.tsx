'use client'

import {useCallback,useEffect,useRef,useState} from 'react'
import {AlertCircle,ArrowLeft,ArrowUpRight,Archive,Boxes,Check,ChevronLeft,ChevronRight,Clock,Download,FileText,History,ImageIcon,Loader2,PackageOpen,Plus,RefreshCw,Save,Search,Upload, X} from 'lucide-react'
import {PageHeader} from '@/components/page-header'
import {ProductIcon} from '@/components/product-icon'
import {Alert,AlertDescription,AlertTitle} from '@/components/ui/alert'
import {Badge} from '@/components/ui/badge'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import {Label} from '@/components/ui/label'
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select'
import {Sheet,SheetContent,SheetDescription,SheetFooter,SheetHeader,SheetTitle} from '@/components/ui/sheet'
import {Skeleton} from '@/components/ui/skeleton'
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from '@/components/ui/table'
import {Tabs,TabsContent,TabsList,TabsTrigger} from '@/components/ui/tabs'
import {Textarea} from '@/components/ui/textarea'
import {Tooltip,TooltipContent,TooltipProvider,TooltipTrigger} from '@/components/ui/tooltip'
import type {Api,OpsRecord,RecordPage} from '@/lib/types'
import {displayDate,queryString,statusLabels} from '@/lib/resources'

type Props={api:Api;accountId?:string;revision:number;onChanged:()=>void}

type ProductDraft={
 title:string
 status:string
 description:string
 url:string
 positioning:string
 audience:string
 release_status:string
}

type LibraryKind='document'|'asset'
type LibraryEntry={
 id:string
 product_id:string
 kind:LibraryKind
 title:string
 category:string
 status:string
 version:number
 created_at:string
 updated_at:string
 body?:string
 filename?:string
 mime_type?:string
 size_bytes?:number
 sha256?:string
 source_path?:string
}
type LibraryPage={items:LibraryEntry[];total:number;limit:number;offset:number}
type LibraryDraft={title:string;category:string;body:string;status:string;version?:number}
type AssetDraft={title:string;category:string;status:string;file:File|null;version?:number}

const PAGE_SIZE=10
const PRODUCT_STATUSES=['active','draft','planned','archived']
const DOCUMENT_CATEGORIES=[
 {value:'brief',label:'推广资料'},
 {value:'manifest',label:'资料清单'},
 {value:'strategy',label:'推广策略'},
 {value:'correction',label:'更正记录'},
 {value:'checklist',label:'检查清单'},
 {value:'owner_input',label:'人工补充'},
 {value:'other',label:'其他文档'},
]
const ASSET_CATEGORIES=[
 {value:'icon',label:'图标'},
 {value:'brand',label:'品牌素材'},
 {value:'store_screenshot',label:'商店截图'},
 {value:'product_screenshot',label:'产品截图'},
 {value:'other',label:'其他素材'},
]

function makeIdempotencyKey(){return globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`}
function classNames(...values:Array<string|false|undefined|null>){return values.filter(Boolean).join(' ')}
function statusText(value:string){return statusLabels[value]||value||'未设置'}
function productDescription(product:OpsRecord){return String(product.data.description||product.data.positioning||'暂无产品介绍')}
function productUrl(product:OpsRecord){return String(product.data.url||'')}
function isProductAssociated(product:OpsRecord,accountId?:string){
 if(!accountId)return true
 if(product.account_id===accountId)return true
 const list=product.data?.account_ids
 if(Array.isArray(list)&&list.includes(accountId))return true
 return false
}
function safeFilename(value:string){return value.replace(/[\\/:*?"<>|]+/g,'-').replace(/\s+/g,' ').trim().slice(0,96)||'download'}
function categoryLabel(kind:LibraryKind,value:string){
 const options=kind==='document'?DOCUMENT_CATEGORIES:ASSET_CATEGORIES
 return options.find(item=>item.value===value)?.label||value||'未分类'
}
function fileToBase64(file:File){
 return new Promise<string>((resolve,reject)=>{
  const reader=new FileReader()
  reader.onerror=()=>reject(new Error('文件读取失败'))
  reader.onload=()=>resolve(String(reader.result||'').split(',')[1]||'')
  reader.readAsDataURL(file)
 })
}

function createProductDraft(record?:OpsRecord|null):ProductDraft{
 const data=record?.data||{}
 return {
  title:record?.title||'',
  status:record?.status||'active',
  description:String(data.description||''),
  url:String(data.url||''),
  positioning:String(data.positioning||''),
  audience:String(data.audience||''),
  release_status:String(data.release_status||''),
 }
}

export function ProductLibrary({api,accountId,revision,onChanged}:Props){
 const [products,setProducts]=useState<OpsRecord[]>([])
 const [total,setTotal]=useState(0)
 const [offset,setOffset]=useState(0)
 const [query,setQuery]=useState('')
 const [status,setStatus]=useState('all')
 const [loading,setLoading]=useState(false)
 const [hasLoaded,setHasLoaded]=useState(false)
 const [error,setError]=useState('')
 const [selected,setSelected]=useState<OpsRecord|null>(null)
 const [detailId,setDetailId]=useState<string|null>(null)
 const [routeReady,setRouteReady]=useState(false)
 const [detailError,setDetailError]=useState('')
 const selectedIdRef=useRef<string|null>(null)
 const [productSheet,setProductSheet]=useState(false)
 const [productMode,setProductMode]=useState<'create'|'edit'>('create')
 const [productDraft,setProductDraft]=useState<ProductDraft>(()=>createProductDraft(null))
 const [savingProduct,setSavingProduct]=useState(false)
 const [productError,setProductError]=useState('')
 const listGeneration=useRef(0)
 const productCreateKey=useRef(makeIdempotencyKey())
 const [productTab,setProductTab]=useState<'account'|'all'>(accountId?'account':'all')
 const [associatingId,setAssociatingId]=useState<string|null>(null)

 useEffect(()=>{if(accountId)setProductTab('account');else setProductTab('all')},[accountId])

 const toggleAssociation=useCallback(async(product:OpsRecord,associate:boolean)=>{
  if(!accountId||associatingId)return
  setAssociatingId(product.id)
  try{
   const rawIds=product.data?.account_ids
   let nextIds:string[]=Array.isArray(rawIds)?[...rawIds]:[]
   if(product.account_id&&!nextIds.includes(product.account_id)){
    nextIds.push(product.account_id)
   }
   let nextAccountId=product.account_id
   if(associate){
    if(!nextIds.includes(accountId))nextIds.push(accountId)
    if(!nextAccountId)nextAccountId=accountId
   }else{
    nextIds=nextIds.filter(id=>id!==accountId)
    if(nextAccountId===accountId){
     nextAccountId=nextIds[0]||null
    }
   }
   const nextData={
    ...(product.data||{}),
    account_ids:nextIds,
   }
   const result=await api<{item:OpsRecord}>(`/products/${encodeURIComponent(product.id)}`,{
    method:'PATCH',
    body:JSON.stringify({
     version:product.version,
     account_id:nextAccountId,
     data:nextData,
    })
   })
   setProducts(prev=>prev.map(p=>p.id===product.id?result.item:p))
   setSelected(prev=>prev?.id===product.id?result.item:prev)
   onChanged()
  }catch(err){
   alert(err instanceof Error?err.message:'产品关联失败')
  }finally{
   setAssociatingId(null)
  }
 },[accountId,api,associatingId,onChanged])

 const loadProducts=useCallback(async(nextOffset=0)=>{
  const generation=++listGeneration.current
  setLoading(true);setError('')
  try{
   const page=await api<RecordPage>(`/products${queryString({q:query||undefined,status:status==='all'?undefined:status,limit:200,offset:0})}`)
   if(generation!==listGeneration.current)return
   setProducts(page.items);setTotal(page.total);setOffset(nextOffset);setHasLoaded(true)
   const selectedId=selectedIdRef.current
   if(selectedId)setSelected(previous=>previous?.id===selectedId?(page.items.find(item=>item.id===selectedId)||previous):previous)
  }catch(err){if(generation===listGeneration.current)setError(err instanceof Error?err.message:'产品列表加载失败')}
  finally{if(generation===listGeneration.current)setLoading(false)}
 },[api,query,status])

 const detailHref=(id:string)=>`/products/detail/?id=${encodeURIComponent(id)}`
 const selectProduct=(product:OpsRecord)=>{
  window.history.pushState({},'',detailHref(product.id));selectedIdRef.current=product.id;setSelected(product);setDetailId(product.id);setDetailError('');window.scrollTo(0,0)
 }
 const clearSelected=()=>{
  window.history.pushState({},'','/products/');selectedIdRef.current=null;setSelected(null);setDetailId(null);setDetailError('');window.scrollTo(0,0)
 }
 useEffect(()=>{
  const syncLocation=()=>{
   if(!location.pathname.startsWith('/products'))return
   const id=location.pathname.startsWith('/products/detail')?new URLSearchParams(location.search).get('id'):null
   selectedIdRef.current=id;setDetailId(id);setSelected(previous=>previous?.id===id?previous:null);setDetailError(location.pathname.startsWith('/products/detail')&&!id?'详情链接缺少产品编号。':'');setRouteReady(true)
  }
  const onNavigate=(event:Event)=>{queueMicrotask(()=>{if(!event.defaultPrevented)syncLocation()})}
  queueMicrotask(syncLocation);window.addEventListener('popstate',syncLocation);window.addEventListener('ops-before-navigate',onNavigate)
  return()=>{window.removeEventListener('popstate',syncLocation);window.removeEventListener('ops-before-navigate',onNavigate)}
 },[])
 useEffect(()=>{
  if(!detailId)return
  let active=true
  api<{item:OpsRecord}>(`/products/${encodeURIComponent(detailId)}`).then(result=>{if(active){setSelected(result.item);setDetailError('')}}).catch(err=>{if(active)setDetailError(err instanceof Error?err.message:'产品不存在或暂时无法读取。')})
  return()=>{active=false}
 },[api,detailId,revision])

 useEffect(()=>{queueMicrotask(()=>{void loadProducts(0)})},[loadProducts,revision])

 const openCreateProduct=()=>{
  setProductMode('create');setProductDraft(createProductDraft(null));setProductError('');productCreateKey.current=makeIdempotencyKey();setProductSheet(true)
 }
 const openEditProduct=(product:OpsRecord)=>{
  setProductMode('edit');setProductDraft(createProductDraft(product));setProductError('');setProductSheet(true)
 }
 const saveProduct=async()=>{
  if(!productDraft.title.trim()){setProductError('产品名称不能为空');return}
  setSavingProduct(true);setProductError('')
  const data={
   description:productDraft.description.trim(),
   url:productDraft.url.trim(),
   positioning:productDraft.positioning.trim(),
   audience:productDraft.audience.trim(),
   release_status:productDraft.release_status.trim(),
  }
  try{
   if(productMode==='create'){
    await api<{item:OpsRecord}>('/products',{method:'POST',headers:{'Idempotency-Key':productCreateKey.current},body:JSON.stringify({title:productDraft.title.trim(),status:productDraft.status,data})})
    productCreateKey.current=makeIdempotencyKey()
   }else if(selected){
    const result=await api<{item:OpsRecord}>(`/products/${selected.id}`,{method:'PATCH',body:JSON.stringify({version:selected.version,title:productDraft.title.trim(),status:productDraft.status,data})})
    setSelected(result.item)
   }
   setProductSheet(false);onChanged();void loadProducts(offset)
  }catch(err){setProductError(err instanceof Error?err.message:'产品保存失败')}
  finally{setSavingProduct(false)}
 }

 if(!routeReady||(detailId&&!selected&&!detailError))return <div role="status" className="flex items-center gap-2 py-10 text-muted-foreground"><Loader2 className="size-4 animate-spin"/>正在读取产品…</div>
 if(detailError)return <section className="space-y-4"><Alert variant="destructive"><AlertTitle>无法打开产品详情</AlertTitle><AlertDescription>{detailError}</AlertDescription></Alert><Button variant="outline" onClick={clearSelected}>返回产品列表</Button><Button onClick={()=>{setDetailError('');onChanged()}}>重试</Button></section>
 if(selected&&detailId){
  return <TooltipProvider>
   <ProductDetail key={selected.id} api={api} product={selected} accountId={accountId} revision={revision} onBack={clearSelected} onEdit={()=>openEditProduct(selected)} onChanged={onChanged} onToggleAssociation={toggleAssociation} associatingId={associatingId} />
   <ProductSheet open={productSheet} onOpenChange={setProductSheet} mode={productMode} draft={productDraft} setDraft={setProductDraft} error={productError} saving={savingProduct} onSave={saveProduct}/>
  </TooltipProvider>
 }

 const accountProducts=products.filter(p=>isProductAssociated(p,accountId))
 const displayedProducts=(productTab==='account'&&accountId)?accountProducts:products
 const currentTotal=displayedProducts.length
 const pageStart=currentTotal===0?0:offset+1
 const pageEnd=Math.min(offset+PAGE_SIZE,currentTotal)
 const pagedProducts=displayedProducts.slice(offset,offset+PAGE_SIZE)

 return <TooltipProvider>
  <section className="records-page flex min-h-0 flex-1 flex-col gap-5">
   <PageHeader title="产品推广知识库" description="按产品沉淀推广资料、策略文档和可下载素材，后续可以持续维护更新。" count={currentTotal} actions={<>
    <Tooltip><TooltipTrigger asChild><Button aria-label="刷新" variant="outline" size="icon" onClick={()=>loadProducts(offset)} disabled={loading}><RefreshCw className={classNames('size-4',loading&&'animate-spin')}/></Button></TooltipTrigger><TooltipContent>刷新</TooltipContent></Tooltip>
    <Button onClick={openCreateProduct}><Plus className="size-4"/>新建产品</Button>
   </>} />

   <div className="surface records-table records-card">
    {accountId&&(
     <div className="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
      <Tabs value={productTab} onValueChange={v=>{setProductTab(v as 'account'|'all');setOffset(0)}}>
       <TabsList>
        <TabsTrigger value="account" className="gap-1.5">
         当前账号推广产品
         <span className="text-xs text-muted-foreground ml-1">({accountProducts.length})</span>
        </TabsTrigger>
        <TabsTrigger value="all" className="gap-1.5">
         全部产品库
         <span className="text-xs text-muted-foreground ml-1">({products.length})</span>
        </TabsTrigger>
       </TabsList>
      </Tabs>
     </div>
    )}

    <div className="records-toolbar">
     <div className="compact-filter-row">
      <div className="relative filter-search">
       <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
       <Input aria-label="搜索产品" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')void loadProducts(0)}} placeholder="搜索产品..." className="pl-9"/>
      </div>
      <Select value={status} onValueChange={value=>{setStatus(value);setOffset(0)}}>
       <SelectTrigger aria-label="状态筛选" className="filter-select"><SelectValue/></SelectTrigger>
       <SelectContent><SelectItem value="all">全部状态</SelectItem>{PRODUCT_STATUSES.map(item=><SelectItem key={item} value={item}>{statusText(item)}</SelectItem>)}</SelectContent>
      </Select>
      <Button variant="secondary" onClick={()=>loadProducts(0)}>筛选</Button>
     </div>
    </div>
    {error&&<Alert variant="destructive" className="m-5"><AlertTitle>加载失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    <Table aria-busy={loading} className="resource-table" style={{minWidth:900}}>
     <colgroup><col style={{width:260}}/><col style={{width:100}}/><col style={{width:150}}/><col style={{width:150}}/><col/><col style={{width:130}}/></colgroup>
     <TableHeader><TableRow><TableHead className="frozen-title">产品</TableHead><TableHead>状态</TableHead><TableHead>账号关联</TableHead><TableHead>更新时间</TableHead><TableHead>摘要</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
     <TableBody>
      {loading&&!hasLoaded&&Array.from({length:PAGE_SIZE}).map((_,index)=><TableRow key={index}><TableCell colSpan={6}><Skeleton className="h-8 w-full"/></TableCell></TableRow>)}
      {hasLoaded&&displayedProducts.length===0&&<TableRow><TableCell colSpan={6} className="py-12 text-center">
       <div className="flex flex-col items-center justify-center gap-2">
        <PackageOpen className="size-8 text-muted-foreground"/>
        <p className="font-medium text-foreground">暂无{productTab==='account'?'本账号推广':''}产品</p>
        <p className="text-sm text-muted-foreground">{productTab==='account'?'当前账号暂未关联推广产品，可从全部产品库中选择产品关联。':'暂无产品记录，可点击上方按钮新建产品。'}</p>
        {productTab==='account'&&accountId&&products.length>0&&<Button variant="outline" size="sm" className="mt-2" onClick={()=>setProductTab('all')}>浏览全部产品库 ({products.length})</Button>}
       </div>
      </TableCell></TableRow>}
      {pagedProducts.map(product=>{
       const isAssoc=isProductAssociated(product,accountId)
       return <TableRow key={product.id} className="hover:bg-muted">
        <TableCell className="frozen-title"><button className="flex w-full items-center gap-3 rounded-sm text-left font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>selectProduct(product)} title={product.title}><ProductIcon api={api} productId={product.id} revision={revision}/><span className="min-w-0 truncate">{product.title}</span></button>{productUrl(product)&&<a className="table-subtext block truncate hover:text-foreground" href={productUrl(product)} target="_blank" rel="noreferrer" onClick={event=>event.stopPropagation()}>{productUrl(product)}</a>}</TableCell>
        <TableCell><Badge data-status={product.status} variant="secondary" className="rounded-md">{statusText(product.status)}</Badge></TableCell>
        <TableCell>
         {accountId?(
          isAssoc?(
           <div className="flex items-center gap-2">
            <Badge variant="outline" className="rounded-md border-emerald-500/30 text-emerald-600 bg-emerald-500/10">推广中</Badge>
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs text-muted-foreground hover:text-destructive" disabled={associatingId===product.id} onClick={e=>{e.stopPropagation();void toggleAssociation(product,false)}}>取消</Button>
           </div>
          ):(
           <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs gap-1" disabled={associatingId===product.id} onClick={e=>{e.stopPropagation();void toggleAssociation(product,true)}}>
            <Plus className="size-3.5"/>{associatingId===product.id?'关联中…':'关联本账号'}
           </Button>
          )
         ):(
          <span className="text-xs text-muted-foreground">
           {Array.isArray(product.data?.account_ids)?`${product.data.account_ids.length} 个账号`:(product.account_id?'1 个账号':'未关联')}
          </span>
         )}
        </TableCell>
        <TableCell className="text-sm text-secondary-foreground">{displayDate(product.updated_at)}</TableCell>
        <TableCell className="text-sm text-muted-foreground"><Tooltip delayDuration={250}><TooltipTrigger asChild><button className="block w-full truncate text-left" onClick={()=>selectProduct(product)}>{productDescription(product)}</button></TooltipTrigger><TooltipContent className="record-full-text" side="bottom" align="start">{productDescription(product)}</TooltipContent></Tooltip></TableCell>
        <TableCell><Button asChild variant="outline" size="sm"><a href={detailHref(product.id)} onClick={event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();selectProduct(product)}}>查看详情<ArrowUpRight className="size-4"/></a></Button></TableCell>
       </TableRow>
      })}
     </TableBody>
    </Table>
    <div className="table-footer">
     <span>{currentTotal===0?'共 0 条记录':`第 ${pageStart}-${pageEnd} 条，共 ${currentTotal} 条`}</span>
     <div className="flex gap-2">
      <Button variant="outline" size="sm" disabled={offset<=0||loading} onClick={()=>setOffset(Math.max(0,offset-PAGE_SIZE))}><ChevronLeft className="size-4"/>上一页</Button>
      <Button variant="outline" size="sm" disabled={offset+PAGE_SIZE>=currentTotal||loading} onClick={()=>setOffset(offset+PAGE_SIZE)}>下一页<ChevronRight className="size-4"/></Button>
     </div>
    </div>
   </div>

   <ProductSheet open={productSheet} onOpenChange={setProductSheet} mode={productMode} draft={productDraft} setDraft={setProductDraft} error={productError} saving={savingProduct} onSave={saveProduct}/>
  </section>
 </TooltipProvider>
}

function ProductDetail({api,product,accountId,revision,onBack,onEdit,onChanged,onToggleAssociation,associatingId}:{api:Api;product:OpsRecord;accountId?:string;revision:number;onBack:()=>void;onEdit:()=>void;onChanged:()=>void;onToggleAssociation?:(product:OpsRecord,associate:boolean)=>Promise<void>;associatingId?:string|null}){
 const [activeTab,setActiveTab]=useState<'profile'|'documents'|'assets'>('profile')
 const [documents,setDocuments]=useState<LibraryPage>({items:[],total:0,limit:PAGE_SIZE,offset:0})
 const [assets,setAssets]=useState<LibraryPage>({items:[],total:0,limit:PAGE_SIZE,offset:0})
 const [docQuery,setDocQuery]=useState('')
 const [assetQuery,setAssetQuery]=useState('')
 const [docCategory,setDocCategory]=useState('all')
 const [assetCategory,setAssetCategory]=useState('all')
 const [docStatus,setDocStatus]=useState('active')
 const [assetStatus,setAssetStatus]=useState('active')
 const [loading,setLoading]=useState<LibraryKind|null>(null)
 const [error,setError]=useState('')
 const [docSheet,setDocSheet]=useState(false)
 const [docMode,setDocMode]=useState<'create'|'edit'>('create')
 const [docDraft,setDocDraft]=useState<LibraryDraft>({title:'',category:'brief',body:'',status:'active'})
 const [currentDoc,setCurrentDoc]=useState<LibraryEntry|null>(null)
 const [history,setHistory]=useState<LibraryEntry[]>([])
 const [assetSheet,setAssetSheet]=useState(false)
 const [assetEditSheet,setAssetEditSheet]=useState(false)
 const [currentAsset,setCurrentAsset]=useState<LibraryEntry|null>(null)
 const [assetDraft,setAssetDraft]=useState<AssetDraft>({title:'',category:'product_screenshot',status:'active',file:null})
 const [assetHistory,setAssetHistory]=useState<LibraryEntry[]>([])
 const [uploadError,setUploadError]=useState('')
 const [downloadingId,setDownloadingId]=useState<string|null>(null)
 const [saving,setSaving]=useState(false)
 const [detailLoading,setDetailLoading]=useState(false)
 const [draftDirty,setDraftDirty]=useState(false)
 const [closeWarning,setCloseWarning]=useState('')
 const libraryGeneration=useRef<Record<LibraryKind,number>>({document:0,asset:0})
 const detailGeneration=useRef(0)
 const draftDirtyRef=useRef(false)
 const docCreateKey=useRef(makeIdempotencyKey())
 const assetCreateKey=useRef(makeIdempotencyKey())
 const markDraftDirty=()=>{draftDirtyRef.current=true;setDraftDirty(true);setCloseWarning('')}
 const clearDraftDirty=()=>{draftDirtyRef.current=false;setDraftDirty(false);setCloseWarning('')}

 const loadLibrary=useCallback(async(kind:LibraryKind,nextOffset=0)=>{
  const generation=++libraryGeneration.current[kind]
  setLoading(kind);setError('')
  const isDocument=kind==='document'
  const q=isDocument?docQuery:assetQuery
  const selectedCategory=isDocument?docCategory:assetCategory
  const selectedStatus=isDocument?docStatus:assetStatus
  try{
   const page=await api<LibraryPage>(`/products/${product.id}/library${queryString({kind,q:q||undefined,category:selectedCategory==='all'?undefined:selectedCategory,status:selectedStatus,limit:PAGE_SIZE,offset:nextOffset})}`)
   if(generation!==libraryGeneration.current[kind])return
   if(isDocument)setDocuments(page);else setAssets(page)
  }catch(err){if(generation===libraryGeneration.current[kind])setError(err instanceof Error?err.message:'资料加载失败')}
  finally{if(generation===libraryGeneration.current[kind])setLoading(current=>current===kind?null:current)}
 },[api,assetCategory,assetQuery,assetStatus,docCategory,docQuery,docStatus,product.id])

 useEffect(()=>{queueMicrotask(()=>{void loadLibrary('document',0);void loadLibrary('asset',0)})},[loadLibrary,revision])
 useEffect(()=>{
  function beforeNavigate(event:Event){
   if(!draftDirtyRef.current)return
   event.preventDefault()
   setCloseWarning('请先保存或放弃当前资料修改，再切换页面。')
  }
  window.addEventListener('ops-before-navigate',beforeNavigate)
  return ()=>window.removeEventListener('ops-before-navigate',beforeNavigate)
 },[])

 const requestBack=()=>{
  if(draftDirtyRef.current){setCloseWarning('请先保存或放弃当前资料修改，再返回产品列表。');return}
  onBack()
 }

 const openNewDoc=()=>{
  if(draftDirty){setCloseWarning('请先保存或放弃当前草稿，再新建文档。');return}
  setDocMode('create');setCurrentDoc(null);setHistory([]);setDocDraft({title:'',category:'brief',body:'',status:'active'});clearDraftDirty();docCreateKey.current=makeIdempotencyKey();setDocSheet(true)
 }
 const openDoc=async(entry:LibraryEntry)=>{
  if(draftDirty){setCloseWarning('请先保存或放弃当前草稿，再打开其他资料。');return}
  const generation=++detailGeneration.current
  setDocMode('edit');setCurrentDoc(entry);setDocDraft({title:entry.title,category:entry.category||'brief',body:entry.body||'',status:entry.status||'active',version:entry.version});setHistory([]);clearDraftDirty();setDetailLoading(true);setDocSheet(true)
  try{
   const [detail,versions]=await Promise.all([
    api<{item:LibraryEntry}>(`/products/${product.id}/library/${entry.id}`),
    api<{items:LibraryEntry[]}>(`/products/${product.id}/library/${entry.id}/history`),
   ])
   if(generation!==detailGeneration.current)return
   setCurrentDoc(detail.item);setHistory(versions.items)
   if(!draftDirtyRef.current)setDocDraft({title:detail.item.title,category:detail.item.category||'brief',body:detail.item.body||'',status:detail.item.status||'active',version:detail.item.version})
  }catch(err){if(generation===detailGeneration.current)setError(err instanceof Error?err.message:'文档详情加载失败')}
  finally{if(generation===detailGeneration.current)setDetailLoading(false)}
 }
 const saveDoc=async()=>{
  if(saving)return
  if(!docDraft.title.trim()){setError('文档标题不能为空');return}
  setSaving(true);setError('')
  try{
   if(docMode==='create'){
    await api<{item:LibraryEntry}>(`/products/${product.id}/library`,{method:'POST',headers:{'Idempotency-Key':docCreateKey.current},body:JSON.stringify({kind:'document',title:docDraft.title.trim(),category:docDraft.category,status:docDraft.status,body:docDraft.body})})
    docCreateKey.current=makeIdempotencyKey()
   }else if(currentDoc){
    await api<{item:LibraryEntry}>(`/products/${product.id}/library/${currentDoc.id}`,{method:'PATCH',body:JSON.stringify({version:currentDoc.version,title:docDraft.title.trim(),category:docDraft.category,status:docDraft.status,body:docDraft.body})})
   }
   clearDraftDirty();setDocSheet(false);onChanged();void loadLibrary('document',documents.offset)
  }catch(err){setError(err instanceof Error?err.message:'文档保存失败')}
  finally{setSaving(false)}
 }
 const archiveDoc=async()=>{
  if(saving)return
  if(!currentDoc)return
  setSaving(true);setError('')
  const nextStatus=currentDoc.status==='archived'?'active':'archived'
  setDocDraft(previous=>({...previous,status:nextStatus}))
  try{
   await api<{item:LibraryEntry}>(`/products/${product.id}/library/${currentDoc.id}`,{method:'PATCH',body:JSON.stringify({version:currentDoc.version,status:nextStatus})})
   clearDraftDirty();setDocSheet(false);onChanged();void loadLibrary('document',documents.offset)
  }catch(err){setError(err instanceof Error?err.message:'归档失败')}
  finally{setSaving(false)}
 }
 const uploadAsset=async(file:File|null,category:string,title:string)=>{
  if(saving)return
  if(!file){setUploadError('请选择文件');return}
  if(file.size>10*1024*1024){setUploadError('文件不能超过 10 MB');return}
  setSaving(true);setUploadError('')
  try{
   const content_base64=await fileToBase64(file)
   await api<{item:LibraryEntry}>(`/products/${product.id}/library`,{method:'POST',headers:{'Idempotency-Key':assetCreateKey.current},body:JSON.stringify({kind:'asset',title:title.trim()||file.name,category,filename:file.name,mime_type:file.type||'application/octet-stream',content_base64})})
   assetCreateKey.current=makeIdempotencyKey();setAssetSheet(false);onChanged();void loadLibrary('asset',assets.offset)
  }catch(err){setUploadError(err instanceof Error?err.message:'上传失败')}
  finally{setSaving(false)}
 }
 const openAsset=async(entry:LibraryEntry)=>{
  if(draftDirty){setCloseWarning('请先保存或放弃当前草稿，再打开其他素材。');return}
  const generation=++detailGeneration.current
  setCurrentAsset(entry);setAssetDraft({title:entry.title,category:entry.category||'product_screenshot',status:entry.status||'active',file:null,version:entry.version});setAssetHistory([]);clearDraftDirty();setDetailLoading(true);setAssetEditSheet(true)
  try{
   const [detail,versions]=await Promise.all([
    api<{item:LibraryEntry}>(`/products/${product.id}/library/${entry.id}`),
    api<{items:LibraryEntry[]}>(`/products/${product.id}/library/${entry.id}/history`),
   ])
   if(generation!==detailGeneration.current)return
   setCurrentAsset(detail.item);setAssetHistory(versions.items)
   if(!draftDirtyRef.current)setAssetDraft({title:detail.item.title,category:detail.item.category||'product_screenshot',status:detail.item.status||'active',file:null,version:detail.item.version})
  }catch(err){if(generation===detailGeneration.current)setError(err instanceof Error?err.message:'素材详情加载失败')}
  finally{if(generation===detailGeneration.current)setDetailLoading(false)}
 }
 const saveAsset=async(archive=false)=>{
  if(saving||!currentAsset)return
  if(!assetDraft.title.trim()){setError('素材标题不能为空');return}
  if(assetDraft.file&&assetDraft.file.size>10*1024*1024){setError('文件不能超过 10 MB');return}
  setSaving(true);setError('')
  try{
   const payload:Record<string,unknown>={version:currentAsset.version,title:assetDraft.title.trim(),category:assetDraft.category,status:archive?(currentAsset.status==='archived'?'active':'archived'):assetDraft.status}
   if(assetDraft.file){
    payload.filename=assetDraft.file.name
    payload.mime_type=assetDraft.file.type||'application/octet-stream'
    payload.content_base64=await fileToBase64(assetDraft.file)
   }
   await api<{item:LibraryEntry}>(`/products/${product.id}/library/${currentAsset.id}`,{method:'PATCH',body:JSON.stringify(payload)})
   clearDraftDirty();setAssetEditSheet(false);onChanged();void loadLibrary('asset',assets.offset)
  }catch(err){setError(err instanceof Error?err.message:(archive?'归档失败':'素材保存失败'))}
  finally{setSaving(false)}
 }
 const downloadEntry=async(entry:LibraryEntry)=>{
  setDownloadingId(entry.id);setError('')
  try{
   const blob=await api<Blob>(`/products/${product.id}/library/${entry.id}/download`)
   const url=URL.createObjectURL(blob)
   const link=document.createElement('a')
   link.href=url
   link.download=safeFilename(entry.filename||(entry.kind==='document'?entry.title+'.md':entry.title))
   document.body.appendChild(link);link.click();link.remove()
   setTimeout(()=>URL.revokeObjectURL(url),1000)
  }catch(err){setError(err instanceof Error?err.message:'下载失败')}
  finally{setDownloadingId(null)}
 }

  const editorNotice=<>
   {error&&<Alert variant="destructive" className="mb-2"><AlertCircle className="size-4"/><AlertDescription>{error}</AlertDescription></Alert>}
   {closeWarning&&(
    <div role="alert" className="animate-in fade-in slide-in-from-top-1 duration-200">
     <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5 min-w-0">
       <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
       <div className="space-y-0.5 min-w-0">
        <div className="text-xs font-semibold text-amber-900 dark:text-amber-200">有未保存修改</div>
        <div className="text-xs leading-relaxed text-amber-800/80 dark:text-amber-300/80">{closeWarning}</div>
       </div>
      </div>
      <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
       <Button size="sm" variant="outline" className="h-7 px-3 text-xs" onClick={()=>setCloseWarning('')}>继续编辑</Button>
       <Button size="sm" variant="outline" className="h-7 px-3 text-xs border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={()=>{clearDraftDirty();setCloseWarning('');setDocSheet(false);setAssetEditSheet(false)}}>放弃修改</Button>
      </div>
     </div>
    </div>
   )}
  </>
 return <TooltipProvider>
  <section className="records-page flex min-h-0 flex-1 flex-col gap-5">
   <PageHeader icon={<ProductIcon api={api} productId={product.id} revision={revision} size={36}/>} title={product.title} description={productDescription(product)} count={documents.total+assets.total} actions={<>
    {accountId&&(
     isProductAssociated(product,accountId)?(
      <div className="flex items-center gap-2">
       <Badge variant="outline" className="rounded-md border-emerald-500/30 text-emerald-600 bg-emerald-500/10 py-1.5 px-3">本账号推广中</Badge>
       <Button variant="outline" size="sm" disabled={associatingId===product.id} onClick={()=>onToggleAssociation?.(product,false)}>取消关联</Button>
      </div>
     ):(
      <Button variant="outline" size="sm" className="gap-1.5" disabled={associatingId===product.id} onClick={()=>onToggleAssociation?.(product,true)}>
       <Plus className="size-4"/>关联到本账号
      </Button>
     )
    )}
    <Button variant="outline" onClick={requestBack}><ArrowLeft className="size-4"/>产品列表</Button>
    <Button variant="outline" onClick={onEdit}><Save className="size-4"/>编辑产品</Button>
   </>}/>

   {error&&<Alert variant="destructive"><AlertTitle>操作失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}

   <Tabs value={activeTab} onValueChange={value=>setActiveTab(value as typeof activeTab)} className="w-full">
    <TabsList className="grid w-full max-w-xl grid-cols-3">
     <TabsTrigger value="profile"><Boxes className="size-4"/>产品资料</TabsTrigger>
     <TabsTrigger value="documents"><FileText className="size-4"/>推广文档</TabsTrigger>
     <TabsTrigger value="assets"><ImageIcon className="size-4"/>素材库</TabsTrigger>
    </TabsList>

    <TabsContent value="profile" className="mt-4">
     <section className="surface p-5">
      <div className="grid gap-4 md:grid-cols-2">
       <InfoBlock label="产品链接" value={productUrl(product)||'未记录'}/>
       <InfoBlock label="发布状态" value={String(product.data.release_status||'未记录')}/>
       <InfoBlock label="关联账号" value={Array.isArray(product.data?.account_ids)&&product.data.account_ids.length?product.data.account_ids.join(', '):(product.account_id||'未关联账号')}/>
       <InfoBlock label="定位" value={String(product.data.positioning||'未记录')}/>
       <InfoBlock label="目标用户" value={String(product.data.audience||'未记录')}/>
       <InfoBlock label="产品介绍" value={productDescription(product)} wide/>
      </div>
     </section>
    </TabsContent>

    <TabsContent value="documents" className="mt-4">
     <section className="surface records-table">
      <LibraryToolbar query={docQuery} setQuery={setDocQuery} category={docCategory} setCategory={setDocCategory} status={docStatus} setStatus={setDocStatus} options={DOCUMENT_CATEGORIES} placeholder="搜索推广文档..." loading={loading==='document'} onFilter={()=>loadLibrary('document',0)} action={<Button onClick={openNewDoc}><Plus className="size-4"/>新建文档</Button>}/>
      <EntryTable kind="document" items={documents.items} loading={loading==='document'} onOpen={openDoc} onDownload={downloadEntry} downloadingId={downloadingId}/>
      <Pagination page={documents} loading={loading==='document'} onPage={next=>loadLibrary('document',next)}/>
     </section>
    </TabsContent>

    <TabsContent value="assets" className="mt-4">
     <section className="surface records-table">
      <LibraryToolbar query={assetQuery} setQuery={setAssetQuery} category={assetCategory} setCategory={setAssetCategory} status={assetStatus} setStatus={setAssetStatus} options={ASSET_CATEGORIES} placeholder="搜索素材..." loading={loading==='asset'} onFilter={()=>loadLibrary('asset',0)} action={<Button onClick={()=>{setUploadError('');setAssetSheet(true)}}><Upload className="size-4"/>上传素材</Button>}/>
      <AssetGrid api={api} productId={product.id} items={assets.items} loading={loading==='asset'} onOpen={openAsset} onDownload={downloadEntry} downloadingId={downloadingId}/>
      <Pagination page={assets} loading={loading==='asset'} onPage={next=>loadLibrary('asset',next)}/>
     </section>
    </TabsContent>
   </Tabs>


   <DocumentSheet notice={editorNotice} open={docSheet} onOpenChange={(open)=>{
    if(open){setDocSheet(true);return}
    if(draftDirty){
     if(closeWarning){clearDraftDirty();setCloseWarning('');setDocSheet(false);return}
     setCloseWarning('请先保存或放弃当前文档修改。再次点击关闭将直接放弃。')
     return
    }
    setDocSheet(false)
   }} mode={docMode} draft={docDraft} setDraft={(next)=>{setDocDraft(next);markDraftDirty()}} current={currentDoc} history={history} detailLoading={detailLoading} saving={saving} onSave={saveDoc} onArchive={archiveDoc}/>
   <AssetUploadSheet open={assetSheet} onOpenChange={setAssetSheet} error={uploadError} saving={saving} onUpload={uploadAsset}/>
   <AssetEditSheet notice={editorNotice} open={assetEditSheet} onOpenChange={(open)=>{
    if(open){setAssetEditSheet(true);return}
    if(draftDirty){
     if(closeWarning){clearDraftDirty();setCloseWarning('');setAssetEditSheet(false);return}
     setCloseWarning('请先保存或放弃当前素材修改。再次点击关闭将直接放弃。')
     return
    }
    setAssetEditSheet(false)
   }} draft={assetDraft} setDraft={(next)=>{setAssetDraft(next);markDraftDirty()}} current={currentAsset} history={assetHistory} detailLoading={detailLoading} saving={saving} onSave={()=>saveAsset(false)} onArchive={()=>saveAsset(true)}/>
  </section>
 </TooltipProvider>
}

function ProductSheet({open,onOpenChange,mode,draft,setDraft,error,saving,onSave}:{open:boolean;onOpenChange:(open:boolean)=>void;mode:'create'|'edit';draft:ProductDraft;setDraft:(draft:ProductDraft)=>void;error:string;saving:boolean;onSave:()=>void}){
 const set=(key:keyof ProductDraft,value:string)=>setDraft({...draft,[key]:value})
 return <Sheet open={open} onOpenChange={onOpenChange}>
  <SheetContent showCloseButton={false} className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
   <SheetHeader className="border-b px-6 py-5"><div className="flex items-start justify-between gap-3"><div><SheetTitle>{mode==='create'?'新建产品':'编辑产品资料'}</SheetTitle><SheetDescription>维护产品推广知识库的基础信息。</SheetDescription></div><Button variant="ghost" size="icon" onClick={()=>onOpenChange(false)} aria-label="关闭"><X className="size-4"/></Button></div></SheetHeader>
   <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
    {error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="space-y-2"><Label>产品名称</Label><Input value={draft.title} onChange={event=>set('title',event.target.value)}/></div>
    <div className="grid gap-4 md:grid-cols-2">
     <div className="space-y-2"><Label>状态</Label><Select value={draft.status} onValueChange={value=>set('status',value)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{PRODUCT_STATUSES.map(item=><SelectItem key={item} value={item}>{statusText(item)}</SelectItem>)}</SelectContent></Select></div>
     <div className="space-y-2"><Label>产品链接</Label><Input value={draft.url} onChange={event=>set('url',event.target.value)}/></div>
    </div>
    <div className="space-y-2"><Label>产品介绍</Label><Textarea className="min-h-24" value={draft.description} onChange={event=>set('description',event.target.value)}/></div>
    <div className="space-y-2"><Label>产品定位</Label><Textarea className="min-h-24" value={draft.positioning} onChange={event=>set('positioning',event.target.value)}/></div>
    <div className="space-y-2"><Label>目标用户</Label><Textarea className="min-h-24" value={draft.audience} onChange={event=>set('audience',event.target.value)}/></div>
    <div className="space-y-2"><Label>发布状态</Label><Input value={draft.release_status} onChange={event=>set('release_status',event.target.value)}/></div>
   </div>
   <SheetFooter className="border-t px-6 py-4"><Button variant="outline" onClick={()=>onOpenChange(false)}>关闭</Button><Button onClick={onSave} disabled={saving}>{saving?<Loader2 className="size-4 animate-spin"/>:<Save className="size-4"/>}保存</Button></SheetFooter>
  </SheetContent>
 </Sheet>
}

function LibraryToolbar({query,setQuery,category,setCategory,status,setStatus,options,placeholder,loading,onFilter,action}:{query:string;setQuery:(value:string)=>void;category:string;setCategory:(value:string)=>void;status:string;setStatus:(value:string)=>void;options:{value:string;label:string}[];placeholder:string;loading:boolean;onFilter:()=>void;action:React.ReactNode}){
 return <div className="records-toolbar">
  <div className="compact-filter-row">
   <div className="relative filter-search">
    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
    <Input aria-label={placeholder} value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')onFilter()}} placeholder={placeholder} className="pl-9"/>
   </div>
   <Select value={category} onValueChange={setCategory}><SelectTrigger aria-label="分类筛选" className="filter-select"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">全部分类</SelectItem>{options.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select>
   <Select value={status} onValueChange={setStatus}><SelectTrigger aria-label="状态筛选" className="filter-select"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="active">使用中</SelectItem><SelectItem value="archived">已归档</SelectItem><SelectItem value="all">全部状态</SelectItem></SelectContent></Select>
   <Button variant="secondary" onClick={onFilter} disabled={loading}>{loading&&<Loader2 className="size-4 animate-spin"/>}筛选</Button>
   <div className="ml-auto">{action}</div>
  </div>
 </div>
}

function EntryTable({kind,items,loading,onOpen,onDownload,downloadingId}:{kind:LibraryKind;items:LibraryEntry[];loading:boolean;onOpen:(entry:LibraryEntry)=>void;onDownload:(entry:LibraryEntry)=>void;downloadingId:string|null}){
 return <Table aria-busy={loading} className="resource-table" style={{minWidth:900}}>
  <colgroup><col style={{width:300}}/><col style={{width:130}}/><col style={{width:120}}/><col style={{width:160}}/><col/><col style={{width:120}}/></colgroup>
  <TableHeader><TableRow><TableHead className="frozen-title">标题</TableHead><TableHead>分类</TableHead><TableHead>状态</TableHead><TableHead>更新时间</TableHead><TableHead>来源</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
  <TableBody>
   {loading&&items.length===0&&Array.from({length:PAGE_SIZE}).map((_,index)=><TableRow key={index}><TableCell colSpan={6}><Skeleton className="h-8 w-full"/></TableCell></TableRow>)}
   {!loading&&items.length===0&&<TableRow><TableCell colSpan={6} className="table-empty-cell">暂无记录</TableCell></TableRow>}
   {items.map(entry=><TableRow key={entry.id} className="hover:bg-muted">
    <TableCell className="frozen-title"><Tooltip delayDuration={250}><TooltipTrigger asChild><button className="block w-full truncate rounded-sm text-left font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>onOpen(entry)}>{entry.title}</button></TooltipTrigger><TooltipContent className="record-full-text" side="bottom" align="start">{entry.title}</TooltipContent></Tooltip></TableCell>
    <TableCell><Badge variant="outline">{categoryLabel(kind,entry.category)}</Badge></TableCell>
    <TableCell><Badge data-status={entry.status} variant="secondary" className="rounded-md">{statusText(entry.status)}</Badge></TableCell>
    <TableCell className="text-sm text-secondary-foreground">{displayDate(entry.updated_at)}</TableCell>
    <TableCell className="text-sm text-muted-foreground"><span className="block truncate" title={entry.source_path||entry.filename||''}>{entry.source_path||entry.filename||'未记录'}</span></TableCell>
    <TableCell><Button variant="outline" size="sm" onClick={()=>onDownload(entry)} disabled={downloadingId!==null}><Download className="size-4"/>{downloadingId===entry.id?'下载中':'下载'}</Button></TableCell>
   </TableRow>)}
  </TableBody>
 </Table>
}

function AssetGrid({api,productId,items,loading,onOpen,onDownload,downloadingId}:{api:Api;productId:string;items:LibraryEntry[];loading:boolean;onOpen:(entry:LibraryEntry)=>void;onDownload:(entry:LibraryEntry)=>void;downloadingId:string|null}){
 if(loading&&items.length===0)return <div className="grid gap-3 p-5 md:grid-cols-3">{Array.from({length:6}).map((_,index)=><Skeleton key={index} className="h-44 w-full"/>)}</div>
 if(!loading&&items.length===0)return <div className="empty-state py-16"><PackageOpen className="size-7"/><h3>暂无素材</h3><p>上传图标、品牌素材、商店截图或产品截图后，会在这里维护和下载。</p></div>
 return <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
  {items.map(entry=><AssetCard key={entry.id} api={api} productId={productId} entry={entry} onOpen={onOpen} onDownload={onDownload} disabled={downloadingId!==null}/>)}
 </div>
}

function AssetCard({api,productId,entry,onOpen,onDownload,disabled}:{api:Api;productId:string;entry:LibraryEntry;onOpen:(entry:LibraryEntry)=>void;onDownload:(entry:LibraryEntry)=>void;disabled:boolean}){
 const [preview,setPreview]=useState('')
 const [failed,setFailed]=useState(false)
 const isImage=entry.mime_type?.startsWith('image/')
 useEffect(()=>{
  if(!isImage)return
  let url=''
  let alive=true
  api<Blob>(`/products/${productId}/library/${entry.id}/download`).then(blob=>{
   if(!alive)return
   url=URL.createObjectURL(blob);setPreview(url)
  }).catch(()=>{if(alive)setFailed(true)})
  return ()=>{alive=false;if(url)URL.revokeObjectURL(url)}
 },[api,entry.id,isImage,productId])
 return <article className="rounded-lg border border-border bg-card p-3">
  <div className="mb-3 flex aspect-video items-center justify-center overflow-hidden rounded-md bg-muted">
   {preview?
    // eslint-disable-next-line @next/next/no-img-element
    <img src={preview} alt={entry.title} className="h-full w-full object-contain"/>:
    <div className="flex flex-col items-center gap-2 text-muted-foreground">{failed||!isImage?<FileText className="size-7"/>:<Loader2 className="size-6 animate-spin"/>}<span className="text-sm">{isImage?'预览加载中':'文件素材'}</span></div>}
  </div>
  <div className="min-w-0">
   <Tooltip delayDuration={250}><TooltipTrigger asChild><h3 className="truncate text-sm font-medium text-foreground">{entry.title}</h3></TooltipTrigger><TooltipContent className="record-full-text" side="bottom" align="start">{entry.title}</TooltipContent></Tooltip>
   <p className="table-subtext truncate">{categoryLabel('asset',entry.category)} · {formatBytes(entry.size_bytes)} · v{entry.version}</p>
   <p className="table-subtext truncate" title={entry.source_path||entry.filename||''}>{entry.source_path||entry.filename||'未记录来源'}</p>
  </div>
  <div className="mt-3 flex justify-end gap-2"><Button variant="outline" size="sm" onClick={()=>onOpen(entry)}><FileText className="size-4"/>维护</Button><Button variant="outline" size="sm" onClick={()=>onDownload(entry)} disabled={disabled}><Download className="size-4"/>下载</Button></div>
 </article>
}

function DocumentSheet({notice,open,onOpenChange,mode,draft,setDraft,current,history,detailLoading,saving,onSave,onArchive}:{notice?:React.ReactNode;open:boolean;onOpenChange:(open:boolean)=>void;mode:'create'|'edit';draft:LibraryDraft;setDraft:(draft:LibraryDraft)=>void;current:LibraryEntry|null;history:LibraryEntry[];detailLoading:boolean;saving:boolean;onSave:()=>void;onArchive:()=>void}){
 const set=(key:keyof LibraryDraft,value:string)=>setDraft({...draft,[key]:value})
 return <Sheet open={open} onOpenChange={onOpenChange}>
  <SheetContent showCloseButton={false} className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
   <SheetHeader className="border-b px-6 py-5"><div className="flex items-start justify-between gap-3"><div><SheetTitle>{mode==='create'?'新建推广文档':draft.title||'推广文档'}</SheetTitle><SheetDescription>{current?`v${current.version} · 更新于 ${displayDate(current.updated_at)}`:'文档以纯文本保存，适合给 AI 直接读取。'}</SheetDescription></div><Button variant="ghost" size="icon" onClick={()=>onOpenChange(false)} aria-label="关闭"><X className="size-4"/></Button></div></SheetHeader>
   {notice&&<div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-3 dark:border-amber-500/20 dark:bg-amber-950/35">{notice}</div>}
   <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
    {detailLoading&&<div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin"/>正在读取详情…</div>}
    <div className="grid gap-4 md:grid-cols-[1fr_180px_140px]">
     <div className="space-y-2"><Label>标题</Label><Input value={draft.title} onChange={event=>set('title',event.target.value)}/></div>
     <div className="space-y-2"><Label>分类</Label><Select value={draft.category} onValueChange={value=>set('category',value)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{DOCUMENT_CATEGORIES.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
     <div className="space-y-2"><Label>状态</Label><Select value={draft.status} onValueChange={value=>set('status',value)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="active">使用中</SelectItem><SelectItem value="archived">已归档</SelectItem></SelectContent></Select></div>
    </div>
    <div className="space-y-2"><Label>正文</Label><Textarea className="min-h-[360px] font-mono text-sm leading-7" value={draft.body} onChange={event=>set('body',event.target.value)} placeholder="记录定位、卖点、证据、可用话术、注意事项..."/></div>
    {history.length>0&&<div className="rounded-lg border p-4">
     <div className="mb-3 flex items-center gap-2 text-sm font-medium"><History className="size-4"/>历史版本</div>
     <div className="space-y-3">{history.map(item=><div key={`${item.id}-${item.version}`} className="rounded-md bg-muted p-3"><div className="flex items-center justify-between text-sm"><span className="font-medium">v{item.version}</span><span className="text-muted-foreground">{displayDate(item.updated_at)}</span></div><details className="mt-2 text-sm"><summary className="cursor-pointer">查看版本正文</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans leading-7">{item.body||'无正文'}</pre></details></div>)}</div>
    </div>}
   </div>
   <SheetFooter className="border-t px-6 py-4">{mode==='edit'&&current&&<Button variant="outline" onClick={onArchive} disabled={saving} className="mr-auto"><Archive className="size-4"/>{current.status==='archived'?'恢复使用':'归档'}</Button>}<Button variant="outline" onClick={()=>onOpenChange(false)}>关闭</Button><Button onClick={onSave} disabled={saving||detailLoading}>{saving?<Loader2 className="size-4 animate-spin"/>:<Save className="size-4"/>}保存</Button></SheetFooter>
  </SheetContent>
 </Sheet>
}

function AssetUploadSheet({open,onOpenChange,error,saving,onUpload}:{open:boolean;onOpenChange:(open:boolean)=>void;error:string;saving:boolean;onUpload:(file:File|null,category:string,title:string)=>void}){
 const [file,setFile]=useState<File|null>(null)
 const [category,setCategory]=useState('product_screenshot')
 const [title,setTitle]=useState('')
 useEffect(()=>{if(open)queueMicrotask(()=>{setFile(null);setTitle('');setCategory('product_screenshot')})},[open])
 return <Sheet open={open} onOpenChange={onOpenChange}>
  <SheetContent showCloseButton={false} className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
   <SheetHeader className="border-b px-6 py-5"><div className="flex items-start justify-between gap-3"><div><SheetTitle>上传素材</SheetTitle><SheetDescription>支持图标、品牌素材、商店截图和产品截图，单个文件不超过 10 MB。</SheetDescription></div><Button variant="ghost" size="icon" onClick={()=>onOpenChange(false)} aria-label="关闭"><X className="size-4"/></Button></div></SheetHeader>
   <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
    {error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="space-y-2"><Label>文件</Label><Input type="file" onChange={event=>setFile(event.target.files?.[0]||null)}/></div>
    <div className="space-y-2"><Label>标题</Label><Input value={title} onChange={event=>setTitle(event.target.value)} placeholder={file?.name||'默认使用文件名'}/></div>
    <div className="space-y-2"><Label>分类</Label><Select value={category} onValueChange={setCategory}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{ASSET_CATEGORIES.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
    {file&&<div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground"><Check className="mr-2 inline size-4"/>{file.name} · {formatBytes(file.size)}</div>}
   </div>
   <SheetFooter className="border-t px-6 py-4"><Button variant="outline" onClick={()=>onOpenChange(false)}>关闭</Button><Button onClick={()=>onUpload(file,category,title)} disabled={saving}>{saving?<Loader2 className="size-4 animate-spin"/>:<Upload className="size-4"/>}上传</Button></SheetFooter>
  </SheetContent>
 </Sheet>
}

function AssetEditSheet({notice,open,onOpenChange,draft,setDraft,current,history,detailLoading,saving,onSave,onArchive}:{notice?:React.ReactNode;open:boolean;onOpenChange:(open:boolean)=>void;draft:AssetDraft;setDraft:(draft:AssetDraft)=>void;current:LibraryEntry|null;history:LibraryEntry[];detailLoading:boolean;saving:boolean;onSave:()=>void;onArchive:()=>void}){
 const set=(key:keyof AssetDraft,value:string|File|null)=>setDraft({...draft,[key]:value})
 return <Sheet open={open} onOpenChange={onOpenChange}>
  <SheetContent showCloseButton={false} className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
   <SheetHeader className="border-b px-6 py-5"><div className="flex items-start justify-between gap-3"><div><SheetTitle>{draft.title||'维护素材'}</SheetTitle><SheetDescription>{current?`v${current.version} · ${current.filename||'未记录文件名'} · ${formatBytes(current.size_bytes)}`:'维护产品推广素材。'}</SheetDescription></div><Button variant="ghost" size="icon" onClick={()=>onOpenChange(false)} aria-label="关闭"><X className="size-4"/></Button></div></SheetHeader>
   {notice&&<div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-3 dark:border-amber-500/20 dark:bg-amber-950/35">{notice}</div>}
   <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
    {detailLoading&&<div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin"/>正在读取详情…</div>}
    <div className="space-y-2"><Label>标题</Label><Input value={draft.title} onChange={event=>set('title',event.target.value)}/></div>
    <div className="grid gap-4 md:grid-cols-2">
     <div className="space-y-2"><Label>分类</Label><Select value={draft.category} onValueChange={value=>set('category',value)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent>{ASSET_CATEGORIES.map(item=><SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>
     <div className="space-y-2"><Label>状态</Label><Select value={draft.status} onValueChange={value=>set('status',value)}><SelectTrigger><SelectValue/></SelectTrigger><SelectContent><SelectItem value="active">使用中</SelectItem><SelectItem value="archived">已归档</SelectItem></SelectContent></Select></div>
    </div>
    <div className="space-y-2"><Label>替换文件</Label><Input type="file" onChange={event=>set('file',event.target.files?.[0]||null)}/>{draft.file&&<p className="table-subtext">{draft.file.name} · {formatBytes(draft.file.size)}</p>}</div>
    {current&&<div className="grid gap-2 rounded-md bg-muted p-3 text-xs text-muted-foreground md:grid-cols-2"><div>ID：{current.id}</div><div>SHA256：{current.sha256||'未记录'}</div><div>来源：{current.source_path||'未记录'}</div><div>更新：{current.updated_at}</div></div>}
    {history.length>0&&<div className="rounded-lg border p-4">
     <div className="mb-3 flex items-center gap-2 text-sm font-medium"><History className="size-4"/>历史版本</div>
     <div className="space-y-3">{history.map(item=><div key={`${item.id}-${item.version}`} className="rounded-md bg-muted p-3"><div className="flex items-center justify-between text-sm"><span className="font-medium">v{item.version}</span><span className="text-muted-foreground">{displayDate(item.updated_at)}</span></div><p className="mt-2 truncate text-sm text-secondary-foreground">{item.filename||item.title} · {categoryLabel('asset',item.category)} · {formatBytes(item.size_bytes)}</p></div>)}</div>
    </div>}
   </div>
   <SheetFooter className="border-t px-6 py-4">{current&&<Button variant="outline" onClick={onArchive} disabled={saving} className="mr-auto"><Archive className="size-4"/>{current.status==='archived'?'恢复使用':'归档'}</Button>}<Button variant="outline" onClick={()=>onOpenChange(false)}>关闭</Button><Button onClick={onSave} disabled={saving||detailLoading}>{saving?<Loader2 className="size-4 animate-spin"/>:<Save className="size-4"/>}保存</Button></SheetFooter>
  </SheetContent>
 </Sheet>
}

function Pagination({page,loading,onPage}:{page:{items:unknown[];total:number;offset:number;limit:number};loading:boolean;onPage:(offset:number)=>void}){
 const start=page.total===0?0:page.offset+1
 const end=Math.min(page.offset+page.items.length,page.total)
 return <div className="table-footer"><span>{page.total===0?'共 0 条记录':`第 ${start}-${end} 条，共 ${page.total} 条`}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={page.offset<=0||loading} onClick={()=>onPage(Math.max(0,page.offset-PAGE_SIZE))}><ChevronLeft className="size-4"/>上一页</Button><Button variant="outline" size="sm" disabled={page.offset+PAGE_SIZE>=page.total||loading} onClick={()=>onPage(page.offset+PAGE_SIZE)}>下一页<ChevronRight className="size-4"/></Button></div></div>
}

function InfoBlock({label,value,wide}:{label:string;value:string;wide?:boolean}){
 return <div className={classNames('rounded-lg border border-border bg-card p-4',wide&&'md:col-span-2')}><div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground"><Clock className="size-4"/>{label}</div><p className="whitespace-pre-wrap break-words text-sm leading-7 text-secondary-foreground">{value}</p></div>
}

function formatBytes(value?:number){
 if(!value&&value!==0)return '未知大小'
 if(value<1024)return `${value} B`
 if(value<1024*1024)return `${(value/1024).toFixed(1)} KB`
 return `${(value/1024/1024).toFixed(1)} MB`
}
