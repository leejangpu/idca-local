/**
 * 계좌 관리 CRUD API
 * 멀티 계좌 지원을 위한 레지스트리 + 자격증명 관리
 */

import { Router } from 'express';
import * as localStore from '../lib/localStore';
import { AccountRegistryEntry } from '../lib/localStore';

export const accountRoutes = Router();

// GET /accounts — 계좌 목록
accountRoutes.get('/', (_req, res) => {
  const registry = localStore.getAccountRegistry();
  res.json(registry);
});

// POST /accounts — 새 계좌 추가
accountRoutes.post('/', (req, res) => {
  const { id, nickname, accountNo, appKey, appSecret, htsUserId, paperTrading } = req.body;

  // validate id: alphanumeric + hyphen, no spaces
  if (!id || typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) {
    return res.status(400).json({ error: 'id must be alphanumeric with hyphens only (no spaces)' });
  }
  if (!nickname || !accountNo || !appKey || !appSecret) {
    return res.status(400).json({ error: 'nickname, accountNo, appKey, appSecret are required' });
  }

  const registry = localStore.getAccountRegistry();

  // check duplicate id
  if (registry.accounts.some(a => a.id === id)) {
    return res.status(409).json({ error: `Account with id '${id}' already exists` });
  }

  // add to registry
  const newEntry: AccountRegistryEntry = {
    id,
    nickname,
    accountNo,
    createdAt: new Date().toISOString(),
    order: registry.accounts.length,
  };
  registry.accounts.push(newEntry);

  // set default if first account
  if (registry.accounts.length === 1) {
    registry.defaultAccountId = id;
  }

  localStore.setAccountRegistry(registry);

  // create credentials + initialize directory structure via forAccount
  const store = localStore.forAccount(id);
  store.setCredentials({
    appKey,
    appSecret,
    accountNo,
    htsUserId: htsUserId || '',
    paperTrading: paperTrading || false,
  });

  // set default trading config if none exists
  if (!store.getTradingConfig()) {
    store.setTradingConfig({
      tradingEnabled: false,
      autoApprove: false,
      domestic: { enabled: false },
      overseas: { enabled: false },
    });
  }

  return res.status(201).json({ success: true, account: newEntry });
});

// PUT /accounts/:accountId — 계좌 정보 수정
accountRoutes.put('/:accountId', (req, res) => {
  const { accountId } = req.params;
  const { nickname, accountNo, appKey, appSecret, htsUserId, paperTrading } = req.body;

  const registry = localStore.getAccountRegistry();
  const idx = registry.accounts.findIndex(a => a.id === accountId);
  if (idx === -1) {
    return res.status(404).json({ error: `Account '${accountId}' not found` });
  }

  // update registry entry
  if (nickname !== undefined) registry.accounts[idx].nickname = nickname;
  if (accountNo !== undefined) registry.accounts[idx].accountNo = accountNo;
  localStore.setAccountRegistry(registry);

  // update credentials file
  const store = localStore.forAccount(accountId);
  const existing = store.getCredentials<Record<string, unknown>>() ?? {};
  const updated: Record<string, unknown> = { ...existing };
  if (appKey !== undefined) updated.appKey = appKey;
  if (appSecret !== undefined) updated.appSecret = appSecret;
  if (accountNo !== undefined) updated.accountNo = accountNo;
  if (htsUserId !== undefined) updated.htsUserId = htsUserId;
  if (paperTrading !== undefined) updated.paperTrading = paperTrading;
  store.setCredentials(updated);

  return res.json({ success: true, account: registry.accounts[idx] });
});

// DELETE /accounts/:accountId — 계좌 삭제 (레지스트리에서만 제거, 데이터 보존)
accountRoutes.delete('/:accountId', (req, res) => {
  const { accountId } = req.params;

  const registry = localStore.getAccountRegistry();
  const idx = registry.accounts.findIndex(a => a.id === accountId);
  if (idx === -1) {
    return res.status(404).json({ error: `Account '${accountId}' not found` });
  }

  registry.accounts.splice(idx, 1);

  // update default if deleted account was default
  if (registry.defaultAccountId === accountId) {
    registry.defaultAccountId = registry.accounts.length > 0 ? registry.accounts[0].id : '';
  }

  localStore.setAccountRegistry(registry);

  return res.json({ success: true, message: `Account '${accountId}' removed from registry (data preserved on disk)` });
});

// GET /accounts/:accountId/credentials — 자격증명 조회 (appSecret 마스킹)
accountRoutes.get('/:accountId/credentials', (req, res) => {
  const { accountId } = req.params;

  const registry = localStore.getAccountRegistry();
  if (!registry.accounts.some(a => a.id === accountId)) {
    return res.status(404).json({ error: `Account '${accountId}' not found` });
  }

  const store = localStore.forAccount(accountId);
  const creds = store.getCredentials<Record<string, unknown>>();
  if (!creds) {
    return res.status(404).json({ error: 'Credentials not found for this account' });
  }

  // mask appSecret: show first 4 + last 4 chars
  const secret = creds.appSecret as string;
  const maskedSecret = secret && secret.length > 8
    ? secret.slice(0, 4) + '*'.repeat(secret.length - 8) + secret.slice(-4)
    : '****';

  return res.json({ ...creds, appSecret: maskedSecret });
});
