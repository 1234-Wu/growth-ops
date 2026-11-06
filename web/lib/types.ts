export type ResourceName = 'platforms'|'accounts'|'products'|'strategies'|'tasks'|'actions'|'contents'|'metrics'|'reviews'|'knowledge'|'skills'|'observations';
export interface OpsRecord { id:string; resource:ResourceName; title:string; account_id:string|null; product_id:string|null; status:string; version:number; created_at:string; updated_at:string; data:Record<string,unknown>; }
export interface RecordPage { items:OpsRecord[]; total:number; limit:number; offset:number; }
export type Api = <T>(path:string, init?:RequestInit)=>Promise<T>;
export interface Field { key:string; label:string; type?:'text'|'textarea'|'number'|'datetime'|'select'|'boolean'|'relation'; options?:{value:string;label:string}[]; relation?:ResourceName; group?:'basic'|'links'|'evidence'; }
export interface ResourceDefinition { label:string; singular:string; description:string; icon:string; defaultStatus:string; fields:Field[]; timeField?:string; global?:boolean; }
export interface Issue {id:string;kind:string;resource:ResourceName;record_id:string;title:string;account_id:string|null;product_id:string|null;reason:string;due_at:string|null;}
export interface Reconciliation {items:Issue[];total:number;limit:number;offset:number;counts:Record<string,number>;as_of:string;}
export interface ActionContext { action:OpsRecord; task:OpsRecord|null;strategy:OpsRecord|null;strategy_resolution:'exact'|'current_unpinned'|'missing';content:OpsRecord|null;parent_action:OpsRecord|null;collections:Record<string,RecordPage>; }
