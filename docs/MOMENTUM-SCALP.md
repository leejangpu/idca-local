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

### v2.1 (완료 — 2026-03-15)

- **쉐도우 pending_buy fill 시뮬레이션**: conservative fill 모델 (bestAsk <= entryPrice, 5초 후 확정)
- **보유시간 단축**: 5분 → 3분 (수익 중 +1분 연장, 최대 4분)
- **no-progress exit**: 120초 경과 + MFE < 0.15% → 조기 청산
- **targetTicks > 6 제외** (고가 저변동주 승률 4.2%)
- **boxRangeTicks >= 2×targetTicks** 조건 추가
- **종목당 일일 진입 2회 제한**
- **priceTrail 기록** (5초 간격 bid/current → EXIT 로그에 포함)
- **MFE 추적** (bestProfitPct — 보유 중 최대 수익률)
- **우선주 하드 제외**

### v2.2 (완료 — 2026-03-17) — Positive Selection 전환

**핵심 전환**: "실패 거래를 더 막는 것보다, 성공 거래의 공통점을 찾아 positive selection"

**배경 분석 (3/16~17 쉐도우 145건)**:
- MFE30>0 (진입 후 30초 내 bid가 1틱이라도 상승)인 거래: 15건
  - 승률 53%, target률 40%, 평균손익 +221원
- MFE30=0인 거래: 130건
  - 승률 22%, target률 11%, 평균손익 -300원
- → **30초 follow-through가 가장 강한 positive signal**

**구현 내용**:

| 기능 | 상태 | 상세 |
|------|------|------|
| **30초 MFE 게이트** | ON | 진입 후 30초 경과 시 1회 판정. mfe30Ticks<=0이면 `no_follow_through_30s`로 즉시 청산 |
| **Pending TTL 단축** | ON | 60초 → 15초 (config `pendingBuyTtlMs`로 조정 가능) |
| **로깅 강화** | ON | EXIT에 mfe30Ticks/mfe30Gate/positiveScore/scoreDetails/recentMomentumPct/bestProfitPct 기록 |
| **positiveScore** | 기록만 | 4점 만점 점수 계산 → state + 로그에 기록 (하드 게이트 OFF) |
| **score 하드 게이트** | OFF | `positiveScoreGateEnabled: false` — 데이터 확인 후 ON 예정 |

**positiveScore 항목 (4점 만점)**:
1. recent 3m momentum > 0 (최근 3분봉 상승 추세) +1
2. entryBoxPos 0.10~0.20 (박스 하단 sweet spot) +1
3. boxRangePct >= 2.0% (충분한 변동성) +1
4. targetTicks <= 5 (target 도달 확률 높은 종목) +1

**MFE30 게이트 안전장치**: `mfe30GateChecked` boolean으로 5초 주기 지터와 무관하게 정확히 1회만 평가

## 매매 파이프라인 (v2.2)

```
[HTS 조건검색] → 상위 20 종목
    ↓
[코드필터] filterQuickScalpCandidate
  - targetTicks 3~6
  - spreadTicks ≤ 2
  - spread/target ≤ 25%
    ↓
[박스하단 진입] checkBoxEntry
  - 최근 10분봉 고저 → 박스
  - 최소 변동성 체크 (boxRangePct ≥ minBoxRangePct)
  - boxRangeTicks >= 2×targetTicks
  - 현재가 박스 하단 30% 이내
  - uptick 확인 (직전 봉 대비 +1틱 반등)
    ↓
[v2.2 positiveScore 계산] calculatePositiveScore (기록용, 하드 게이트 OFF 가능)
  - recent 3m momentum, boxPos sweet spot, boxRangePct, targetTicks
    ↓
[매수] LIMIT 주문 (bid+1틱 진입), pending_buy TTL=15초
    ↓
[v2.2 30초 MFE 게이트] — 진입 후 30초 경과 시 1회 판정
  - mfe30Ticks > 0 → 통과, 기존 TP/SL/timeout 루프 계속
  - mfe30Ticks <= 0 → 즉시 청산 (no_follow_through_30s)
    ↓
[매도 판단] 5초마다 bestBid 체크
  - bestBid ≥ 목표가 (진입가×1.005) → 익절 MARKET
  - bestBid ≤ 손절가 (진입가×0.995) → 손절 MARKET
  - 2분 + MFE < 0.15% → no-progress timeout
  - 3분 경과 → 타임아웃 청산 (수익 중이면 +1분 연장, 최대 4분)
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

## 다음 목표 (v2.2 배포 후)

### 내일 (2026-03-18) 쉐도우 결과 확인 사항

v2.2 핵심 변경 3가지가 제대로 작동하는지 아래 기준으로 확인:

**1. 30초 MFE 게이트 효과 검증**
- `exitReason = 'no_follow_through_30s'` 건수 → 전체 EXIT 대비 비율
- 게이트에 걸린 거래들의 평균 손실 vs 이전(3/16~17) timeout 평균 손실 비교
- 게이트 통과(`mfe30Gate = 'pass'`)한 거래들의 승률/target률 → **50%+ 기대**
- 만약 게이트 통과 거래도 대부분 손실이면 → 30초가 너무 짧거나 1틱 기준이 너무 낮은 것

**2. Pending TTL 15초 효과 검증**
- CANCEL 로그에서 `shadow_pending_ttl_expired` 건수 → 이전(60초) 대비 증가폭
- 체결(ENTRY) 건수가 급감하지 않았는지 확인
  - 체결건 fillElapsedSec 분포 확인 (대부분 5초 이내면 15초도 넉넉)
  - 만약 체결률 급감 → config에서 `pendingBuyTtlMs: 20000`으로 상향

**3. positiveScore 분포 확인**
- 진입된 거래들의 score 분포 (0~4)
- score별 mfe30Gate pass/fail 비율
- score별 최종 exitReason(target/stop_loss/timeout/no_follow_through_30s) 분포
- **score >= 3 거래만 남겼을 때 승률/손익이 유의미하게 좋으면 → 하드 게이트 ON 결정**

### 하드 게이트 ON 판단 기준 (score >= 3)

아래 **모두** 만족 시 config에서 `positiveScoreGateEnabled: true` 전환:
- score >= 3 그룹의 mfe30Gate pass 비율이 score < 3 대비 **1.5배 이상**
- score >= 3 그룹의 승률이 **35% 이상** (현재 전체 21%)
- 샘플 수가 **score >= 3이 최소 15건 이상**

### 추가 분석 후보

- TTL 10초 vs 15초 비교 → CANCEL 로그의 fillConservativeAtCancel로 "10초 시점에 fill 됐을 것" 역산 가능
- 시간대별 MFE30 게이트 pass률 → 오전/오후 차이 있으면 시간대 필터 검토
- target 도달 거래의 score 분포 → sweet spot 항목 추가/제거 검토

### 중기 로드맵

| 우선순위 | 작업 | 전제 조건 |
|----------|------|-----------|
| 1 | positiveScore 하드 게이트 ON | 1일+ 데이터 확인 후 |
| 2 | TTL 10초 전환 | 15초에서 체결률 문제 없으면 |
| 3 | 실전 모드 전환 | 쉐도우 승률 40%+ & RR 1.2+ |
| 4 | SL 비대칭 검토 (0.5% → 0.35~0.4%) | 실전 데이터 확보 후 |
| 5 | 슬롯 확장 (5 → 8~10) | 실전 안정 후 |

## 관련 소스 파일

| 파일 | 역할 |
|---|---|
| `runners/momentumScalp.ts` | 매수/매도 트리거, 쉐도우 모드, 스캔 로그 |
| `lib/momentumScalpCalculator.ts` | 코드필터, 박스진입, TP/SL 계산 (순수 함수) |
| `lib/slotAllocator.ts` | 슬롯 배분, 상태 CRUD |
| `lib/kisApi.ts` | 조건검색, 호가 조회, 주문 |
