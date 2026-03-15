/**
 * 계좌 컨텍스트 — 러너에 전달되는 계좌별 정보 번들
 */

import { AccountStore, forAccount, getAccountRegistry } from './localStore';
import { KisApiClient } from './kisApi';

export interface AccountCredentials {
  appKey: string;
  appSecret: string;
  accountNo: string;
  htsUserId: string;
  paperTrading: boolean;
}

export interface AccountContext {
  accountId: string;
  nickname: string;
  credentials: AccountCredentials;
  kisClient: KisApiClient;
  store: AccountStore;
}

export function getEnabledAccounts(): AccountContext[] {
  const registry = getAccountRegistry();
  const result: AccountContext[] = [];

  for (const entry of registry.accounts) {
    const store = forAccount(entry.id);
    const creds = store.getCredentials<AccountCredentials>();
    if (!creds || !creds.appKey || !creds.appSecret || !creds.accountNo) continue;

    result.push({
      accountId: entry.id,
      nickname: entry.nickname,
      credentials: {
        appKey: creds.appKey,
        appSecret: creds.appSecret,
        accountNo: creds.accountNo,
        htsUserId: creds.htsUserId || '',
        paperTrading: creds.paperTrading || false,
      },
      kisClient: new KisApiClient(creds.paperTrading || false),
      store,
    });
  }

  return result;
}
