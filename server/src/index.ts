/**
 * IDCA Local Server — 메인 엔트리포인트
 * Express (설정 UI + config API) + node-cron 스케줄러
 */

import express from 'express';
import * as path from 'path';
import { config } from './config';
import { initLocalStore } from './lib/localStore';
import { registerAllCrons } from './cron';
import { configRoutes } from './routes/config';

const app = express();

// 미들웨어
app.use(express.json());

// 정적 파일 (설정 UI)
app.use(express.static(path.resolve(__dirname, '../public')));

// 헬스체크
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 설정 API
app.use('/config', configRoutes);

// 서버 시작
async function start() {
  initLocalStore();
  registerAllCrons();

  app.listen(config.port, () => {
    console.log(`[IDCA-Local] 서버 시작: http://localhost:${config.port}`);
    console.log(`[IDCA-Local] 설정 UI: http://localhost:${config.port}/`);
    console.log(`[IDCA-Local] 데이터 경로: ${config.dataDir}`);
  });
}

start().catch((err) => {
  console.error('[IDCA-Local] 서버 시작 실패:', err);
  process.exit(1);
});
