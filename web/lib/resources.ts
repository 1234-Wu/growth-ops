import type {ResourceDefinition,ResourceName} from './types';
const relation=(key:string,label:string,target:ResourceName)=>({key,label,type:'relation' as const,relation:target,group:'links' as const});
export const statusLabels:Record<string,string>={active:'使用中',planned:'待执行',pending:'待处理',in_progress:'进行中',observing:'观察中',review_due:'待复盘',published:'已发布',partial:'部分完成',unknown:'无法验证',deleted:'已删除',completed:'已完成',done:'已完成',success:'成功',failed:'失败',blocked:'阻塞',cancelled:'已取消',canceled:'已取消',draft:'草稿',archived:'已归档'};
export const actionTypeLabels:Record<string,string>={
 publish:'发布内容',post:'发布内容',tweet:'发布推文',reply:'回复互动',comment:'评论互动',
 repost:'转发内容',retweet:'转发内容',quote:'引用转发',like:'点赞互动',follow:'关注账号',
 profile_update:'更新账号资料',asset_creation:'制作素材',data_collection:'采集数据',review:'运营复盘',
};
export function actionTypeLabel(value:unknown){
 if(typeof value!=='string'||!value.trim())return '未分类';
 return actionTypeLabels[value.trim().toLowerCase()]||value.trim();
}
export const taskTypes=[
 {value:'account_operations',label:'账号运营'},
 {value:'content_publishing',label:'内容发布'},
 {value:'asset_creation',label:'素材制作'},
 {value:'product_preparation',label:'产品准备'},
 {value:'analysis_review',label:'数据复盘'},
 {value:'strategy_planning',label:'策略规划'},
 {value:'other',label:'其他'},
];
export const resources:Record<ResourceName,ResourceDefinition>={
 tasks:{label:'运营任务',singular:'任务',description:'把策略拆成可执行的计划，追踪每一次推进。',icon:'check',defaultStatus:'planned',timeField:'due_at',fields:[{key:'task_type',label:'任务类型',type:'select',options:taskTypes},{key:'acceptance_criteria',label:'完成标准',type:'textarea'},{key:'due_at',label:'截止时间',type:'datetime'},{key:'completed_at',label:'实际完成时间',type:'datetime',group:'evidence'},relation('review_id','来源复盘','reviews'),relation('strategy_id','关联策略','strategies')]},
 actions:{label:'运营动作',singular:'动作',description:'记录真实发生的行动，让结果有迹可循。',icon:'activity',defaultStatus:'completed',timeField:'occurred_at',fields:[{key:'action_type',label:'动作类型'},{key:'occurred_at',label:'发生时间',type:'datetime'},{key:'result',label:'执行结果',type:'textarea'},{key:'evidence_url',label:'证据链接',group:'evidence'},{key:'external_id',label:'外部内容 ID',group:'evidence'},{key:'verification_status',label:'核验状态',type:'select',group:'evidence',options:[{value:'pending',label:'待核验'},{value:'verified',label:'已核验'},{value:'failed',label:'核验失败'},{value:'not_applicable',label:'不适用'}]},{key:'verified_at',label:'核验时间',type:'datetime',group:'evidence'},{key:'verification_evidence',label:'核验依据',type:'textarea',group:'evidence'},{key:'requires_verification',label:'此动作需要核验',type:'boolean',group:'evidence'},{key:'review_due_at',label:'复盘时间',type:'datetime'},relation('task_id','关联任务','tasks'),relation('strategy_id','执行策略','strategies'),relation('content_id','关联内容','contents'),relation('parent_action_id','前序动作','actions')]},
 contents:{label:'内容管理',singular:'内容',description:'从一个真实素材，到一条值得发布的内容。',icon:'file',defaultStatus:'draft',fields:[{key:'body',label:'内容正文',type:'textarea'},{key:'url',label:'发布链接'}]},
 observations:{label:'监测计划',singular:'监测',description:'安排观察窗口，记录下一次检查的时间。',icon:'eye',defaultStatus:'pending',timeField:'due_at',fields:[{key:'due_at',label:'检查时间',type:'datetime'},{key:'requirements',label:'观察要求',type:'textarea'},relation('action_id','关联动作','actions')]},
 metrics:{label:'运营数据',singular:'数据',description:'保存每一次观测，区分真实的零与未知。',icon:'chart',defaultStatus:'active',timeField:'observed_at',fields:[{key:'metric_name',label:'指标名称'},{key:'value',label:'指标数值',type:'number'},{key:'availability',label:'数据状态',type:'select',options:[{value:'valid',label:'已观测'},{value:'missing',label:'未采集'},{value:'unavailable',label:'不可获取'},{value:'not_applicable',label:'不适用'}]},{key:'metric_type',label:'统计口径',type:'select',options:[{value:'cumulative',label:'累计快照'},{value:'interval',label:'区间数值'}]},{key:'observed_at',label:'观测时间',type:'datetime'},{key:'observed_at_precision',label:'观测时间精度',type:'select',options:[{value:'instant',label:'精确时间'},{value:'minute',label:'精确到分钟'},{value:'day',label:'仅有日期'}]},{key:'source',label:'数据来源'},{key:'period_start',label:'统计区间开始（区间数值）',type:'datetime',group:'evidence'},{key:'period_end',label:'统计区间结束（区间数值）',type:'datetime',group:'evidence'},relation('action_id','关联动作','actions')]},
 strategies:{label:'策略库',singular:'策略',description:'明确方向，并保留每个阶段的判断依据。',icon:'compass',defaultStatus:'active',global:true,fields:[{key:'body',label:'策略正文',type:'textarea'}]},
 reviews:{label:'复盘归因',singular:'复盘',description:'整理事实与假设，把经验转化为下一步行动。',icon:'repeat',defaultStatus:'active',timeField:'review_period',fields:[{key:'facts',label:'观察到的事实',type:'textarea'},{key:'hypothesis',label:'原因与假设',type:'textarea'},{key:'evidence',label:'支持证据',type:'textarea'},{key:'next_steps',label:'下一步行动',type:'textarea'},{key:'period_start',label:'覆盖开始时间',type:'datetime'},{key:'period_end',label:'覆盖结束时间',type:'datetime'},relation('action_id','关联动作','actions')]},
 knowledge:{label:'知识与选题',singular:'知识',description:'留下方法、案例与失败经验，供下一次决策参考。',icon:'book',defaultStatus:'active',global:true,fields:[{key:'body',label:'知识正文',type:'textarea'},{key:'source',label:'来源'}]},
 skills:{label:'技能中心',singular:'Skill',description:'让验证过的方法成为可以重复使用的工作流程。',icon:'sparkles',defaultStatus:'active',global:true,fields:[{key:'body',label:'Skill 正文',type:'textarea'},{key:'trigger',label:'适用场景'}]},
 accounts:{label:'账号管理',singular:'账号',description:'连接不同平台的运营身份，分别积累策略和数据。',icon:'users',defaultStatus:'active',global:true,fields:[relation('platform_id','所属平台','platforms'),{key:'handle',label:'账号用户名'},{key:'url',label:'主页链接'},{key:'positioning',label:'账号定位',type:'textarea'}]},
 products:{label:'产品管理',singular:'产品',description:'把内容和运营结果关联到实际推广的产品。',icon:'box',defaultStatus:'active',global:true,fields:[{key:'url',label:'产品链接'},{key:'description',label:'产品介绍',type:'textarea'}]},
 platforms:{label:'平台管理',singular:'平台',description:'从 X 开始，逐步拓展新的内容渠道。',icon:'layers',defaultStatus:'active',global:true,fields:[{key:'code',label:'平台代码'},{key:'url',label:'官网链接'}]}
};
export const resourceNames=Object.keys(resources) as ResourceName[];
export function isResource(value:string):value is ResourceName{return value in resources;}
export function displayDate(value:unknown,precision?:unknown){if(!value||typeof value!=='string')return '未记录';const date=new Date(value);if(Number.isNaN(date.getTime()))return value;if(precision==='day')return new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}).format(date);return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);}
export function queryString(params:Record<string,string|number|undefined|null>){const q=new URLSearchParams();Object.entries(params).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')q.set(k,String(v));});return q.size?'?'+q.toString():'';}
