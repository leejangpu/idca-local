/**
 * 환경 설정 로더
 * .env 파일에서 모든 설정을 읽어옴
 *
 * KIS 자격증명은 계좌별로 data/accounts/{id}/credentials/main.json에 저장.
 * .env의 KIS_* 변수는 마이그레이션 호환용으로만 유지 (optional).
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// 프로젝트 루트의 .env 파일 로드
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`환경변수 ${key}가 설정되지 않았습니다. .env 파일을 확인하세요.`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  // KIS API (레거시 호환 — 계좌 마이그레이션 전까지 사용)
  kis: {
    appKey: optionalEnv('KIS_APP_KEY', ''),
    appSecret: optionalEnv('KIS_APP_SECRET', ''),
    accountNo: optionalEnv('KIS_ACCOUNT_NO', ''),
    htsUserId: optionalEnv('KIS_HTS_USER_ID', ''),
  },

  // Telegram
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    adminChatId: requireEnv('ADMIN_TELEGRAM_CHAT_ID'),
  },

  // Server
  port: parseInt(optionalEnv('PORT', '3001'), 10),

  // 단일 사용자 (레거시 호환)
  userId: optionalEnv('USER_ID', 'default_user'),
  accountId: optionalEnv('ACCOUNT_ID', 'default_account'),

  // 데이터 경로 — 프로젝트 루트/data (server/ 밖)
  dataDir: path.resolve(optionalEnv('DATA_DIR', path.resolve(__dirname, '../../data'))),
} as const;
