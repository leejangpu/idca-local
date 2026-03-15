/**
 * IDCA Local Server — 메인 엔트리포인트
 * Express API 서버 + node-cron 스케줄러
 */

import express from 'express';
import cors from 'cors';
import { config } from './config';
import { initLocalStore } from './lib/localStore';
import { registerAllCrons } from './cron';
import { apiRoutes } from './routes/api';
import { dataRoutes } from './routes/data';

const app = express();

// 미들웨어
app.use(cors({ origin: `http://localhost:${process.env.WEB_PORT || 3000}` }));
app.use(express.json());

// 헬스체크
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 라우트
app.use('/api', apiRoutes);
app.use('/data', dataRoutes);

// 서버 시작
async function start() {
  // 로컬 스토어 초기화 (디렉토리 생성)
  initLocalStore();

  // cron 스케줄러 등록
  registerAllCrons();

  app.listen(config.port, () => {
    console.log(`[IDCA-Local] 서버 시작: http://localhost:${config.port}`);
    console.log(`[IDCA-Local] 데이터 경로: ${config.dataDir}`);
    console.log(`[IDCA-Local] 환경: ${process.env.NODE_ENV || 'development'}`);
  });
}

start().catch((err) => {
  console.error('[IDCA-Local] 서버 시작 실패:', err);
  process.exit(1);
});
