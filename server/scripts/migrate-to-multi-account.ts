/**
 * 단일 계좌 → 멀티 계좌 마이그레이션
 *
 * 기존 data/ 하위의 config, credentials, cache, state, logs, history, swing을
 * data/accounts/main/ 아래로 이동합니다.
 *
 * 실행: npx ts-node server/scripts/migrate-to-multi-account.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DATA_ROOT = path.resolve(__dirname, '../data');
const ACCOUNTS_DIR = path.join(DATA_ROOT, 'accounts');
const MAIN_DIR = path.join(ACCOUNTS_DIR, 'main');
const REGISTRY_FILE = path.join(DATA_ROOT, 'accounts.json');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function moveDir(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest)) {
    // dest already exists — merge files
    const files = fs.readdirSync(src, { withFileTypes: true });
    for (const f of files) {
      const srcPath = path.join(src, f.name);
      const destPath = path.join(dest, f.name);
      if (f.isDirectory()) {
        moveDir(srcPath, destPath);
      } else if (!fs.existsSync(destPath)) {
        fs.renameSync(srcPath, destPath);
      }
    }
    // remove empty src dir
    try { fs.rmdirSync(src); } catch { /* not empty */ }
  } else {
    fs.renameSync(src, dest);
  }
}

function moveFile(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  ensureDir(path.dirname(dest));
  if (!fs.existsSync(dest)) {
    fs.renameSync(src, dest);
  }
}

function main() {
  // 이미 마이그레이션 완료 확인
  if (fs.existsSync(REGISTRY_FILE)) {
    console.log('[Migration] accounts.json 이미 존재 — 마이그레이션 건너뜀');
    return;
  }

  console.log('[Migration] 단일 계좌 → 멀티 계좌 마이그레이션 시작');
  ensureDir(MAIN_DIR);

  // 1. config 이동 (telegram.json은 글로벌 유지)
  const configSrc = path.join(DATA_ROOT, 'config');
  if (fs.existsSync(configSrc)) {
    // telegram.json은 글로벌로 유지
    const telegramSrc = path.join(configSrc, 'telegram.json');
    const telegramBackup = fs.existsSync(telegramSrc) ? fs.readFileSync(telegramSrc, 'utf-8') : null;

    moveDir(path.join(configSrc, 'domestic'), path.join(MAIN_DIR, 'config', 'domestic'));
    moveDir(path.join(configSrc, 'overseas'), path.join(MAIN_DIR, 'config', 'overseas'));
    moveFile(path.join(configSrc, 'trading.json'), path.join(MAIN_DIR, 'config', 'trading.json'));

    // telegram.json을 글로벌 config에 복원
    if (telegramBackup) {
      ensureDir(configSrc);
      fs.writeFileSync(telegramSrc, telegramBackup, 'utf-8');
    }

    // legacy 폴더는 그대로 둠
    console.log('  ✓ config 이동 완료');
  }

  // 2. credentials 이동
  moveDir(path.join(DATA_ROOT, 'credentials'), path.join(MAIN_DIR, 'credentials'));
  console.log('  ✓ credentials 이동 완료');

  // 3. cache 이동
  moveDir(path.join(DATA_ROOT, 'cache'), path.join(MAIN_DIR, 'cache'));
  console.log('  ✓ cache 이동 완료');

  // 4. state 이동
  moveDir(path.join(DATA_ROOT, 'state'), path.join(MAIN_DIR, 'state'));
  console.log('  ✓ state 이동 완료');

  // 5. logs 이동 (text 로그 포함)
  moveDir(path.join(DATA_ROOT, 'logs'), path.join(MAIN_DIR, 'logs'));
  console.log('  ✓ logs 이동 완료');

  // 6. history 이동
  moveDir(path.join(DATA_ROOT, 'history'), path.join(MAIN_DIR, 'history'));
  console.log('  ✓ history 이동 완료');

  // 7. swing 이동
  moveDir(path.join(DATA_ROOT, 'swing'), path.join(MAIN_DIR, 'swing'));
  console.log('  ✓ swing 이동 완료');

  // 8. .env의 KIS 정보로 credentials 생성 (없으면)
  const credFile = path.join(MAIN_DIR, 'credentials', 'main.json');
  if (!fs.existsSync(credFile)) {
    const appKey = process.env.KIS_APP_KEY || '';
    const appSecret = process.env.KIS_APP_SECRET || '';
    const accountNo = process.env.KIS_ACCOUNT_NO || '';
    const htsUserId = process.env.KIS_HTS_USER_ID || '';
    if (appKey && appSecret && accountNo) {
      ensureDir(path.dirname(credFile));
      fs.writeFileSync(credFile, JSON.stringify({
        appKey, appSecret, accountNo, htsUserId,
        createdAt: new Date().toISOString(),
      }, null, 2), 'utf-8');
      console.log('  ✓ .env에서 credentials 생성');
    }
  }

  // 9. accounts.json 레지스트리 생성
  const accountNo = process.env.KIS_ACCOUNT_NO || '';
  const nickname = '주계좌';
  const registry = {
    accounts: [{
      id: 'main',
      nickname,
      accountNo,
      createdAt: new Date().toISOString(),
      order: 0,
    }],
    defaultAccountId: 'main',
  };
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
  console.log('  ✓ accounts.json 생성');

  console.log('[Migration] 마이그레이션 완료!');
  console.log(`  계좌 ID: main`);
  console.log(`  데이터 경로: ${MAIN_DIR}`);
}

main();
