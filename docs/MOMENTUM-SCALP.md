# 모멘텀 스캘핑 (빠른 회전 스캘핑 v2) — 개발 히스토리 & 다음 목표

## 전략 개요

국내 주식 초단타 스캘핑. HTS 조건검색 → 코드필터 → 박스하단 반등 진입 → 0.5% TP/SL.
1회 매수 → 익절 or 손절 → 다음 종목 (물타기 없음, 빠른 회전).

## 개발 히스토리

### v1 (폐기)

- 13개 필터, ATR 기반 목표/손절, 45분 보유 → **실전 손실로 폐기**
- 교훈: 과도한 필터 + 긴 보유시간 = 스캘핑에 부적합

### v2 재설계 (2026-03)

**핵심 전환**: "종목선정보다 exit 실행 품질이 더 큰 문제" (GPT 분석)
- 구현 순서: exit 품질 → 진입 필터 → 종목 선정

### v2 1단계 (완료 - 2026-03-14)

- **bestBid 기준** TP/SL 판단 (last → bidPrice)
- 모든 매도 **MARKET 즉시 청산**
- TP: bestBid ≥ 목표가 → 익절
- SL: bestBid ≤ 손절가 → 손절
- 5분 타임아웃: 손실 중 → 즉시 청산, 수익 중 → 1분 연장 (최대 6분)
- **TradeLog 확장**: entryBoxPos, boxRangePct, spreadTicks, targetTicks, bestBidAtExit, timeToExitSec
- **쉐도우 모드** 구현 (실제 주문 없이 가상 매매)

### v2 2단계 (완료)

- boxRangePct ≥ max(0.35%, 2.5×spreadPct, 4×tickSize/price) 최소 변동성 조건
- uptick 강화: 마지막 봉 close ≥ 직전 봉 close + 1틱
- 보유 중 고속 체크 (5초 × 9회 rapid polling)

## 매매 파이프라인

```
[HTS 조건검색] → 상위 20 종목
    ↓
[코드필터] filterQuickScalpCandidate
  - targetTicks ≥ 3 (0.5%가 최소 3틱)
  - spreadTicks ≤ 2
  - spread/target ≤ 25%
    ↓
[박스하단 진입] checkBoxEntry
  - 최근 10분봉 고저 → 박스
  - 최소 변동성 체크 (boxRangePct ≥ minBoxRangePct)
  - 현재가 박스 하단 30% 이내
  - uptick 확인 (직전 봉 대비 +1틱 반등)
    ↓
[매수] LIMIT 주문 (bid+1틱 진입)
    ↓
[매도 판단] 5초마다 bestBid 체크
  - bestBid ≥ 목표가 (진입가×1.005) → 익절 MARKET
  - bestBid ≤ 손절가 (진입가×0.995) → 손절 MARKET
  - 5분 경과 → 타임아웃 청산 (수익 중이면 1분 연장)
  - 15:20 KST → 종가 단일가 청산
```

## 장 시간대별 동작

| 시간 (KST) | 동작 |
|------------|------|
| 09:00~09:04 | 보유 종목 매도 판단만 (오버나이트 포함) |
| 09:05~11:29 | 신규 매수 + 매도 |
| 11:30~13:00 | 점심시간 매수 스킵, 매도만 |
| 13:00~15:14 | 신규 매수 + 매도 |
| 15:15~15:19 | 매수 중단, 보유 매도만 |
| 15:20~ | 종가 단일가 청산 (잔여 active 전부 MARKET) |

## HTS 조건검색 설정

| 조건 | 값 |
|------|-----|
| 시장 | 거래소 종합 + 코스닥 |
| 거래대금 | 상위 100 (일간) |
| 등락률 | -3.00% ~ +8.00% |
| 현재가 | 6,000 ~ 150,000원 |
| 제외 | SPAC, ETN, ETF |

## 쉐도우 모드 (다음 목표)

### 목표
- `shadowMode=true` — 실제 주문 없이 가상 매매 데이터 수집
- **100건+ 수집 후 분석**

### 수집 데이터
- `scalpShadowLogs`: 가상 매매 기록 (type: ENTRY/EXIT/CANCEL)
  - **ENTRY**: 진입가, 수량, 배정금, 목표가, 손절가, 박스위치/범위, 스프레드/타깃틱, 호가정보
  - **EXIT**: 청산가, exitReason, 수익률, 보유시간, bestBidAtExit, boxPos 등
  - **CANCEL**: 장마감 미체결 취소
- `scalpScanLogs`: 매 트리거 필터 통계 (조건검색 수, 코드필터 탈락, 박스진입 탈락, 진입신호 수)

### 분석 체크포인트
1. **신호 빈도**: 하루 몇 건 진입? (너무 적으면 조건 완화, 많으면 슬롯 부족)
2. **승률**: target vs stop_loss vs timeout 비율 (break-even ~72.8%)
3. **평균 수익률/보유시간**: 수익 vs 손실 비대칭
4. **시간대 분포**: 오전/오후 성과 차이
5. **필터 병목**: codeFilter vs boxEntry 어디서 가장 많이 탈락?
6. **장마감 청산 빈도**: market_close_auction 발생 빈도
7. **스프레드/틱 분포**: spreadTicks, targetTicks 평균

### 실전 전환 조건 (쉐도우 분석 후)
- SL 비대칭 검토 (0.5% → 0.35~0.4%)
- 슬롯 확장 (1→2)
- 쿨다운 ON (손절 후 재진입 방지)
- 수수료 티어 확인 (BanKIS 기준 ROUND_TRIP_COST_PCT ≈ 0.23%)

### 3단계 (쉐도우 이후 구현 예정)
- 쿨다운 세분화: 손절 후 20-60분, 익절 후 5-10분
- 후보 거래대금 정렬 → 상위 N개만 평가
- 일일 매매 횟수 제한
- (보류) Marketable limit (bestBid-1틱), Cloud Run 상시 프로세스

## 관련 소스 파일

| 파일 | 역할 |
|---|---|
| `runners/momentumScalp.ts` | 매수/매도 트리거, 쉐도우 모드, 스캔 로그 |
| `lib/momentumScalpCalculator.ts` | 코드필터, 박스진입, TP/SL 계산 (순수 함수) |
| `lib/slotAllocator.ts` | 슬롯 배분, 상태 CRUD |
| `lib/kisApi.ts` | 조건검색, 호가 조회, 주문 |
