import type { Api } from './types';
export class ApiError extends Error { constructor(public status:number,message:string){super(message);} }
export function createApi(token:string,onUnauthorized:()=>void):Api {
 return async function request<T>(path:string,init:RequestInit={}):Promise<T>{
  const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${token}`);headers.set('Accept','application/json');
  if(init.body)headers.set('Content-Type','application/json');
  const response=await fetch('/api/v1'+path,{...init,headers,cache:'no-store'});
  if(response.status===401){onUnauthorized();throw new ApiError(401,'访问密钥无效或已失效，请重新登录。');}
  if(response.ok&&(response.headers.get('Content-Type')?.includes('application/zip')||response.headers.get('Content-Disposition')?.startsWith('attachment')))return await response.blob() as T;
  const text=await response.text();let payload;
  try{payload=text?JSON.parse(text):null;}catch{throw new ApiError(response.status,'服务返回了无法识别的响应，请重试。');}
  if(!response.ok)throw new ApiError(response.status,payload?.error?.message||`请求失败（${response.status}）`);
  return payload as T;
 };
}
