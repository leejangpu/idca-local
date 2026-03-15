/**
 * API 라우트 — KIS 프록시 + 계산 엔드포인트
 * Firebase Functions HTTP 엔드포인트 대체
 */

import { Router } from 'express';

export const apiRoutes = Router();

// 헬스체크
apiRoutes.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// TODO: Phase 3에서 구현
// POST /api/calculate — 무한매수법 계산
// POST /api/proxy/token — KIS 토큰
// POST /api/proxy/balance — 잔고 조회
// POST /api/proxy/quote — 시세 조회
// POST /api/proxy/order — 주문
// POST /api/proxy/buyable-amount — 매수 가능 금액
// POST /api/proxy/account-balance — 계좌 자산
// POST /api/proxy/order-history — 주문 내역
// POST /api/proxy/pending-orders — 미체결 내역
