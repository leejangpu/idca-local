#!/usr/bin/env npx tsx
/**
 * Firestore → 로컬 JSON 마이그레이션 스크립트 (일회성)
 *
 * 사전 조건:
 *   1. gcloud auth application-default login
 *   2. firebase-admin 설치: npm install firebase-admin (임시)
 *   3. .env에 USER_ID, ACCOUNT_ID 설정
 *
 * 실행:
 *   npx tsx scripts/migrate-firestore.ts
 *
 * 마이그레이션 대상:
 *   - config/trading → data/config/trading.json
 *   - domestic/{strategy} → data/config/domestic/{strategy}.json
 *   - overseas/{strategy} → data/config/overseas/{strategy}.json
 *   - credentials/main → data/credentials/main.json
 *   - cache/kisToken → data/cache/kisToken.json
 *   - realtimeDdsobV2State/* → data/state/realtimeDdsobV2State/*.json
 *   - momentumScalpState/* → data/state/momentumScalpState/*.json
 *   - cycles/* → data/state/cycles/*.json
 *   - vrState/* → data/state/vrState/*.json
 *   - ddsobState/* → data/state/ddsobState/*.json
 *   - balanceHistory/* → data/history/balanceHistory/*.json
 *   - cycleHistory/* → data/history/cycleHistory/*.json
 *   - tradeLogs/* → data/logs/tradeLogs/*.json
 *   - scalpTradeLogs/* → data/logs/scalpTradeLogs/*.json
 *   - scalpShadowLogs/* → data/logs/scalpShadowLogs/*.json
 *   - scalpScanLogs/* → data/logs/scalpScanLogs/*.json
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

// Firebase Admin 초기화 (gcloud 기본 인증 사용)
admin.initializeApp({
  projectId: 'idca-9a681',
});

const db = admin.firestore();
const DATA_ROOT = path.resolve(__dirname, '../server/data');

// ==================== 유틸리티 ====================

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Firestore 문서 데이터를 JSON-safe 형식으로 변환
 * Timestamp → ISO string, GeoPoint → {lat, lng} 등
 */
function sanitize(data: admin.firestore.DocumentData): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      result[key] = value;
    } else if (value instanceof admin.firestore.Timestamp) {
      result[key] = value.toDate().toISOString();
    } else if (value instanceof admin.firestore.GeoPoint) {
      result[key] = { lat: value.latitude, lng: value.longitude };
    } else if (Array.isArray(value)) {
      result[key] = value.map(v =>
        v instanceof admin.firestore.Timestamp ? v.toDate().toISOString() :
        (typeof v === 'object' && v !== null) ? sanitize(v) : v
      );
    } else if (typeof value === 'object') {
      result[key] = sanitize(value as admin.firestore.DocumentData);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ==================== 마이그레이션 함수 ====================

async function migrateDoc(firestorePath: string, localPath: string, label: string): Promise<boolean> {
  const doc = await db.doc(firestorePath).get();
  if (!doc.exists) {
    console.log(`  [SKIP] ${label} — 문서 없음`);
    return false;
  }
  writeJson(localPath, sanitize(doc.data()!));
  console.log(`  [OK] ${label}`);
  return true;
}

async function migrateCollection(
  firestorePath: string,
  localDir: string,
  label: string,
  fileNameFn?: (docId: string) => string
): Promise<number> {
  const snapshot = await db.collection(firestorePath).get();
  if (snapshot.empty) {
    console.log(`  [SKIP] ${label} — 컬렉션 비어있음`);
    return 0;
  }

  ensureDir(localDir);
  let count = 0;
  for (const doc of snapshot.docs) {
    const fileName = fileNameFn ? fileNameFn(doc.id) : `${doc.id}.json`;
    writeJson(path.join(localDir, fileName), sanitize(doc.data()));
    count++;
  }
  console.log(`  [OK] ${label} — ${count}건`);
  return count;
}

// ==================== 메인 ====================

async function main() {
  const userId = process.env.USER_ID || 'default_user';
  const accountId = process.env.ACCOUNT_ID || 'default_account';
  const accountPath = `users/${userId}/accounts/${accountId}`;

  console.log('==========================================');
  console.log('  Firestore → 로컬 JSON 마이그레이션');
  console.log(`  userId: ${userId}`);
  console.log(`  accountId: ${accountId}`);
  console.log(`  출력 경로: ${DATA_ROOT}`);
  console.log('==========================================\n');

  // 유저 문서 존재 확인
  const userDoc = await db.doc(`users/${userId}`).get();
  if (!userDoc.exists) {
    // accounts 서브컬렉션 직접 확인
    const accountsSnap = await db.collection(`users/${userId}/accounts`).limit(1).get();
    if (accountsSnap.empty) {
      console.error(`❌ 유저 ${userId}를 찾을 수 없습니다.`);
      console.log('\n사용 가능한 유저 목록:');
      const usersSnap = await db.collection('users').limit(10).get();
      for (const u of usersSnap.docs) {
        console.log(`  - ${u.id}`);
      }
      process.exit(1);
    }
  }

  // 1. Config
  console.log('[Config]');
  await migrateDoc(`${accountPath}/config/trading`, path.join(DATA_ROOT, 'config', 'trading.json'), 'config/trading');

  // 전략별 config (시장별)
  for (const market of ['domestic', 'overseas']) {
    const strategies = market === 'domestic'
      ? ['momentumScalp', 'realtimeDdsobV2']
      : ['infinite', 'vr', 'realtimeDdsobV2', 'realtimeDdsobV2_1'];
    for (const strategy of strategies) {
      await migrateDoc(
        `${accountPath}/${market}/${strategy}`,
        path.join(DATA_ROOT, 'config', market, `${strategy}.json`),
        `${market}/${strategy}`
      );
    }
  }

  // 레거시 config 경로도 확인
  for (const strategy of ['infinite', 'vr', 'realtimeDdsobV2', 'realtimeDdsobV2_1', 'momentumScalp', 'swing']) {
    await migrateDoc(
      `${accountPath}/config/${strategy}`,
      path.join(DATA_ROOT, 'config', 'legacy', `${strategy}.json`),
      `config/${strategy} (legacy)`
    );
  }

  // 2. Credentials & Cache
  console.log('\n[Credentials & Cache]');
  await migrateDoc(`${accountPath}/credentials/main`, path.join(DATA_ROOT, 'credentials', 'main.json'), 'credentials/main');
  await migrateDoc(`${accountPath}/cache/kisToken`, path.join(DATA_ROOT, 'cache', 'kisToken.json'), 'cache/kisToken');

  // 3. State collections
  console.log('\n[State]');
  for (const collection of ['realtimeDdsobV2State', 'momentumScalpState', 'cycles', 'vrState', 'ddsobState']) {
    await migrateCollection(
      `${accountPath}/${collection}`,
      path.join(DATA_ROOT, 'state', collection),
      collection
    );
  }

  // 4. Logs
  console.log('\n[Logs]');
  for (const logType of ['tradeLogs', 'scalpTradeLogs', 'scalpShadowLogs', 'scalpScanLogs']) {
    await migrateCollection(
      `${accountPath}/${logType}`,
      path.join(DATA_ROOT, 'logs', logType),
      logType
    );
  }

  // 5. History
  console.log('\n[History]');
  await migrateCollection(
    `${accountPath}/balanceHistory`,
    path.join(DATA_ROOT, 'history', 'balanceHistory'),
    'balanceHistory'
  );

  // cycleHistory는 유저 레벨
  await migrateCollection(
    `users/${userId}/cycleHistory`,
    path.join(DATA_ROOT, 'history', 'cycleHistory'),
    'cycleHistory (user-level)'
  );

  // 6. Swing data (이미 로컬이면 스킵)
  const swingDir = path.join(DATA_ROOT, 'swing');
  if (fs.existsSync(swingDir) && fs.readdirSync(swingDir).length > 0) {
    console.log('\n[Swing] 이미 로컬 데이터 존재 — 스킵');
  } else {
    console.log('\n[Swing] 로컬 데이터 없음 — Firestore 미사용 (localStore 전용)');
  }

  console.log('\n==========================================');
  console.log('  마이그레이션 완료');
  console.log('==========================================');

  process.exit(0);
}

main().catch(err => {
  console.error('마이그레이션 실패:', err);
  process.exit(1);
});
