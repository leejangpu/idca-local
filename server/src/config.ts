/**
 * 환경 설정 로더
 * .env 파일에서 모든 설정을 읽어옴
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
  // KIS API
  kis: {
    appKey: requireEnv('KIS_APP_KEY'),
    appSecret: requireEnv('KIS_APP_SECRET'),
    accountNo: requireEnv('KIS_ACCOUNT_NO'),
    htsUserId: requireEnv('KIS_HTS_USER_ID'),
    paperTrading: optionalEnv('KIS_PAPER_TRADING', 'false') === 'true',
  },

  // Telegram
  telegram: {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    adminChatId: requireEnv('ADMIN_TELEGRAM_CHAT_ID'),
  },

  // Server
  port: parseInt(optionalEnv('PORT', '3001'), 10),

  // 단일 사용자 (Firestore 경로 대체)
  userId: optionalEnv('USER_ID', 'default_user'),
  accountId: optionalEnv('ACCOUNT_ID', 'default_account'),

  // 데이터 경로
  dataDir: path.resolve(__dirname, '../data'),
} as const;
