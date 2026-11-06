'use client'

import {useEffect,useState} from 'react'
import {Box} from 'lucide-react'
import type {Api} from '@/lib/types'

export function ProductIcon({api,productId,revision=0,size=32}:{api:Api;productId:string;revision?:number;size?:number}){
 const [image,setImage]=useState<{productId:string;url:string}|null>(null)
 useEffect(()=>{
  let active=true
  let objectUrl:string|undefined
  async function load(){
   try{
    const page=await api<{items:{id:string;mime_type?:string}[]}>(`/products/${encodeURIComponent(productId)}/library?kind=asset&category=icon&status=active&limit=1`)
    const icon=page.items[0]
    if(!icon||!/^image\/(png|jpeg|webp|gif|avif)$/.test(icon.mime_type||'')){if(active)setImage(null);return}
    const blob=await api<Blob>(`/products/${encodeURIComponent(productId)}/library/${encodeURIComponent(icon.id)}/download`)
    if(!active)return
    objectUrl=URL.createObjectURL(blob);setImage({productId,url:objectUrl})
   }catch{if(active)setImage(null)}
  }
  void load()
  return()=>{active=false;if(objectUrl)URL.revokeObjectURL(objectUrl)}
 },[api,productId,revision])
 const url=image?.productId===productId?image.url:null
 return <span className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted" style={{width:size,height:size}} aria-hidden="true">
  {url?
   // Authenticated local asset: a Blob URL keeps credentials out of image URLs.
   // eslint-disable-next-line @next/next/no-img-element
   <img src={url} alt="" width={size} height={size} className="h-full w-full object-cover" onError={()=>setImage(null)}/>
   :<Box size={Math.max(14,Math.round(size*.55))} className="text-muted-foreground"/>}
 </span>
}
