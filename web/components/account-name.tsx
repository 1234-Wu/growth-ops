import { PlatformIcon } from './platform-icon';
import type { OpsRecord } from '@/lib/types';
import { accountLabel, accountPlatform } from '@/lib/account-label';

export function AccountName({ account, platforms, iconOnly = false }: { account: OpsRecord; platforms: OpsRecord[]; iconOnly?: boolean }) {
 return <span className="account-name" title={accountLabel(account, platforms)}>
  <span className="account-name-title">{account.title}</span>
  {iconOnly ? <PlatformIcon name={accountPlatform(account, platforms)}/> : <span className="account-platform-tag">{accountPlatform(account, platforms)}</span>}
 </span>;
}
