/**
 * 데이터 라우트 — 웹 프론트엔드용 REST API
 * Firebase Firestore 직접 접근 대체
 */

import { Router } from 'express';

export const dataRoutes = Router();

// TODO: Phase 3에서 구현
// GET /data/config — 공통 설정
// PUT /data/config — 공통 설정 저장
// GET /data/config/:market/:strategy — 전략별 설정
// PUT /data/config/:market/:strategy — 전략별 설정 저장
// GET /data/dashboard — 대시보드 (보유종목, 손익)
// GET /data/pending-orders — 미체결 주문
// GET /data/order-history — 주문 내역
// GET /data/cycle-history — 사이클 히스토리
// GET /data/balance-history — 잔고 히스토리
// GET /data/state/:collection/:ticker — 종목별 상태
// GET /data/scalp-logs — 스캘핑 로그
// POST /data/force-stop/:strategy/:ticker — 강제 종료
// GET /data/runner-status — 러너 상태
