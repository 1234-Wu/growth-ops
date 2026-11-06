import type { OpsRecord } from './types';

export function accountPlatform(account: OpsRecord, platforms: OpsRecord[]): string {
 const id = account.data.platform_id;
 if (typeof id !== 'string' || !id) return '未关联平台';
 return platforms.find(platform => platform.id === id)?.title || '未知平台';
}

export function accountLabel(account: OpsRecord, platforms: OpsRecord[]): string {
 return `${account.title} · ${accountPlatform(account, platforms)}`;
}
