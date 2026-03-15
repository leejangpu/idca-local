# 스윙매매 — 개발 히스토리 & 다음 목표

## 전략 개요

국내 주식 스윙매매. 일봉 기반 4단계 진입 평가 + D-confirmed LIMIT 체결 정책.
유니버스 자동 스크리닝 (거래량순위 + 시가총액순위).

## 개발 히스토리

### Phase 1: 기본 설계 + 백테스트

- **진입 판단**: 4단계 평가 (추세→조정→지지→트리거)
  - EMA9/20/60, RSI14, ADX, PSAR, ATR20 등 기술적 지표
  - `swingCalculator.ts` — 순수 함수 모듈, 백테스트 공유
- **청산 전략**: 목표가 익절 / 트레일링 스탑 / 고정 손절 / 시간 손절
- **포지션 라이프사이클**: INIT_RISK → DE_RISKED → RUNNER → WEAKENING

### Phase 2: D-confirmed 실행 정책

- 즉시 체결(Instant) 대신 **전일 시그널 → 익일 지정가 매수**
- Stage1-only LIMIT (chase/fallback 없음)
- 5-zone adaptive LIMIT 가격:

| Zone | premiumATR | LIMIT 가격 | Risk 배수 |
|------|-----------|-----------|----------|
| 1a (<0.3) | 저평가 | supportZone.upper × 1.003 | 0.5x |
| 1b (0.3~0.5) | 초기 | supportZone.upper × 1.003 | 0.75x |
| 2 (0.5~1.0) | sweet spot | close - 0.3×ATR | 1.0x |
| 3 (1.0~1.25) | late | close - 0.5×ATR | 0.75x |
| 4 (>1.25) | chase | SKIP | — |

### Phase 3: 유니버스 자동 스크리닝 (2026-03)

- KIS API: 거래량순위(KOSPI 30 + KOSDAQ 30) + 시가총액순위(30) → 합집합
- 필터: 가격 5,000~200,000원, 시총 3,000억~5조, 거래대금 50억+, 우선주/스팩 제외
- 보유 중인 종목 자동 유지
- 1일 1회 캐시
- 예상 유니버스: 80~120종목

### 백테스트 결과

**D-confirmed vs Instant Fill (51종목 × 200일봉)**

| 지표 | 즉시체결 | D Stage1-only |
|---|---|---|
| 거래 수 | 40 | 24 |
| 체결률 | — | 58.5% |
| 승률 | 45.0% | 41.7% |
| 평균 수익률/거래 | +1.90% | +1.90% |

**OOS 검증 (과적합 없음)**

| 지표 | IS | OOS |
|---|---|---|
| 승률 | 39.3% | 61.5% |
| 평균 수익률 | +1.49% | +2.87% |

**핵심 이슈**: 포트폴리오 수준 수익률 낮음 (~5%/10개월). 원인은 거래 빈도 부족 → 유니버스 확대로 개선 기대.

## 일일 운영 스케줄 (D-confirmed)

```
17:00 KST  [EOD Scan] 유니버스 갱신 + 후보 평가 → pending LIMIT 생성
08:50 KST  [Submit] LIMIT 주문 제출 (shadow: 로그만)
09:00~15:30 [Loop] 보유종목 트레일링/청산 체크 (5분마다)
15:50 KST  [Fill Check] 체결 확인 (당일 저가 vs 지정가)
15:55 KST  [Cancel] 미체결 주문 정리
```

## 쉐도우 모드 계획 (다음 목표)

### 목표
- `shadowMode=true` — 실제 주문 없이 가상 체결 데이터 수집
- **1주간 (약 5 영업일)** 운영 후 분석

### 수집 데이터
- `swingScanLogs`: 일별 유니버스 스캔 기록 (종목 수, 후보, zone 분포)
- `swingShadowLogs`: D-confirmed 가상 체결 기록 (limitPrice vs 실제 low/open)
- `swingShadowTrades`: 메인 루프 가상 매매 기록 (BUY/SELL/ADDITIONAL_BUY, 가격, 수량, 지표, 수익률 등)
- `swingState`: 보유종목 상태 (트레일링, 청산 판단)

### 분석 체크포인트 (1주 후)
1. 유니버스 규모: 매일 몇 종목 스캔?
2. 후보 빈도: 하루 평균 shouldBuy 후보 수
3. zone 분포: 어떤 zone에서 시그널 집중?
4. LIMIT 체결률: shadow 모드에서 limitPrice vs 실제 당일 low
5. 종목 다양성: 같은 종목 반복 vs 다양한 종목
6. API 안정성: 에러 로그, 타임아웃

### 쉐도우 후 실전 전환 단계
1. 쉐도우 데이터 분석 → 유니버스 필터 튜닝
2. 소액 실전 (`shadowMode=false`, principal 축소)
3. 정상 운영 (principal 정상화)
4. (선택) fallback 재검토, rolling walk-forward 검증

## 관련 소스 파일

| 파일 | 역할 |
|---|---|
| `runners/swingTrading.ts` | 오케스트레이터 (EOD scan, submit, fill check, cancel) |
| `lib/swingCalculator.ts` | 매매 판단 순수 함수 (4단계 평가, zone-adaptive LIMIT) |
| `lib/kisApi.ts` | VolumeRanking, MarketCapRanking, DailyBars |
| `lib/localStore.ts` | swingState, pendingOrders, shadowLogs, scanLogs |
