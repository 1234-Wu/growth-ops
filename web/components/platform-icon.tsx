import { Globe2 } from 'lucide-react';

/** Platform marks follow the linked platform name, never the account name. */
export function PlatformIcon({ name }: { name: string }) {
 const normalized = name.trim().toLowerCase();
 return <span className="platform-icon" role="img" aria-label={name} title={name}>
  {['x', 'twitter', 'twitter/x', 'x/twitter', 'x（推特）', '推特'].includes(normalized)
   ? <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932 6.064-6.933ZM17.61 20.644h2.039L6.486 3.24H4.298L17.61 20.644Z"/></svg>
   : <Globe2 size={14} aria-hidden="true"/>}
 </span>;
}
