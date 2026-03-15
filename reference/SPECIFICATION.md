# 라오어의 무한매수법 (Infinite DCA) - 자동매매 시스템 스펙 문서

## 목차
1. [개요](#개요)
2. [핵심 개념](#핵심-개념)
3. [버전별 특징](#버전별-특징)
4. [V3.0 매매 규칙](#v30-매매-규칙)
5. [V2.2 매매 규칙](#v22-매매-규칙)
6. [주문 타입 정의](#주문-타입-정의)
7. [시스템 구현 요구사항](#시스템-구현-요구사항)

---

## 개요

### 전략 목적
- **대상 종목**: 레버리지 ETF (TQQQ, SOXL 등)
- **투자 방식**: 분할 매수를 통한 평단가 하락 + 목표가 익절
- **핵심 철학**: 차트/기업 분석 없이 수학적 규칙 기반 자동 매매

### 주요 특징
- ✅ 분할 매수로 리스크 분산
- ✅ 하락장에서 평단 하락 효과
- ✅ 변동성 활용한 수익 실현
- ⚠️ 레버리지 상품 특성상 급격한 하락에 취약

---

## 핵심 개념

### 1. 기본 용어

#### T (회차)
```
T = 매수누적액 / 1회매수액 (소수점 둘째자리 올림)
```
- 현재까지 몇 번째 매수인지를 나타내는 지표
- 예: 1회매수액이 1000달러이고, 지금까지 15,000달러 매수했다면 T=15

#### 별%(☆%) - LOC 매수/매도 기준점
```
별% = 평단가 기준 LOC 주문 가격의 퍼센트
```
- 매일 달라지는 매수/매도 기준 가격
- T값에 따라 동적으로 계산됨

#### 전반전 vs 후반전
- **전반전**: T < 20 (40분할 기준) 또는 T < 10 (20분할 기준)
- **후반전**: T ≥ 20 (40분할 기준) 또는 T ≥ 10 (20분할 기준)

### 2. 분할 방식
- **40분할**: 안정적, 초보자 권장 (V2.2, V3.0 모두 지원)
- **20분할**: 공격적, 고수익/고위험 (V3.0 전용)
- **30분할, 35분할**: 커스텀 가능

---

## 버전별 특징

### V3.0 (최신, 2024년 6월 발표)

#### 주요 변경사항
1. **반복리(Half Compounding) 도입**
   - 수익금을 40분할하여 1회매수금에 반영
   - 예: 200$ 수익 → 200/40 = 5$ → 1회매수금 1000 → 1005
   - 20분할 진행 시 수익금의 절반(20/40)만 사용 → 나머지 절반은 비상금으로 보관

2. **손실 시 매수금 유지**
   - 손실 발생 시에도 과거 수익 최대치 기준으로 1회매수금 유지
   - 자금 부족 시 보관된 비상금에서 충당

3. **쿼터매도로 용어 통일**
   - 기존 "쿼터손절" 대신 "쿼터매도"로 변경
   - 개념 단순화

#### 대상 종목 및 목표 수익률
| 종목 | 분할 | 목표 수익률 | 권장 대상 |
|------|------|------------|----------|
| TQQQ | 20분할 | +15% | 경험자 |
| TQQQ | 40분할 | +15% | 초보자 권장 |
| SOXL | 20분할 | +20% | 경험자 |
| SOXL | 40분할 | +20% | 초보자 권장 |

### V2.2 (안정 버전, 2023년)

#### 특징
- 40분할 기준
- TQQQ 목표 +10%
- SOXL 목표 +20%
- 전후반전 매수 방식이 명확히 구분됨

---

## V3.0 매매 규칙

### 공통 설정 (20분할 기준)

#### 별% 계산식
```
TQQQ: 별% = 15 - 1.5 × T
SOXL: 별% = 20 - 2.0 × T
```

#### 1회매수금 계산
```javascript
// 초기 설정
const 원금 = 20000; // 예: 2만불
let 1회매수금 = 원금 / 20; // 1000불

// 사이클 종료 후 수익 발생 시
const 사이클수익 = 계산된수익;
if (사이클수익 > 0) {
  1회매수금 += 사이클수익 / 40; // 수익의 절반을 40분할
}

// 손실 발생 시
// 1회매수금 변경 없음 (과거 최대 수익 기준 유지)
```

### 매수 규칙

#### 전반전 매수 (T < 10)
```javascript
const 별퍼센트 = (종목 === 'TQQQ') ? 15 - 1.5 * T : 20 - 2.0 * T;
const 평단가 = 현재평단가;

// 매수 주문 2개
주문1: {
  금액: 1회매수금 / 2,
  타입: 'LOC',
  가격: 평단가 * (1 + 별퍼센트/100)
}

주문2: {
  금액: 1회매수금 / 2,
  타입: 'LOC',
  가격: 평단가 * (1 + 0/100) // 0% = 평단가
}

// 추가 하방 매수 (급락 대비)
// 평단가보다 낮은 가격대에 여러 LOC 주문 배치
```

#### 후반전 매수 (T ≥ 10)
```javascript
const 별퍼센트 = (종목 === 'TQQQ') ? 15 - 1.5 * T : 20 - 2.0 * T;

주문1: {
  금액: 1회매수금,
  타입: 'LOC',
  가격: 평단가 * (1 + 별퍼센트/100)
}

// 추가 하방 매수 (급락 대비)
```

### 매도 규칙

**PDF 원문 기준 (mmb3.0.pdf 섹션 3, 4)**: V3.0의 매도는 크게 2가지 상황으로 구분됩니다.

#### 일반 매도: T≤19인 경우
```javascript
const 목표수익률 = (종목 === 'TQQQ') ? 15 : 20;

// PDF 명시: "T≤19인 경우, 전후반전 상관없이 공통으로 적용됩니다"
// 매일 아래 2개 매도 주문을 같이 걸어둠

주문1_쿼터매도: {
  수량: 누적수량 / 4,
  타입: 'LOC',
  가격: 평단가 * (1 + 별퍼센트/100),
  설명: '별%LOC 쿼터매도 - 수익 구간에서 1/4 수익 실현'
}

주문2_목표익절: {
  수량: 누적수량 * 3/4,
  타입: 'LIMIT',
  가격: 평단가 * (1 + 목표수익률/100),
  설명: '목표 수익률 달성 시 3/4 익절 (SOXL 20%, TQQQ 15%)'
}
```

**핵심 포인트**:
- ✓ T≤19일 때 **항상** 1/4 별%LOC 매도 주문을 걸어둠
- ✓ 동시에 3/4는 목표가 지정가 매도 주문
- ✓ 둘 중 먼저 체결되는 쪽이 실행됨

#### 쿼터모드기간: 19 < T < 20인 경우 (T값 기반 판단)

**⚠️ 중요: 상태 추적이 아닌 T값으로만 판단**

쿼터모드는 별도의 `quarter_mode_active` 상태 플래그나 매수 횟수를 추적하지 않습니다.
매일 T값을 확인하여 해당 시점의 조건에 따라 MOC 또는 LOC 매도를 결정합니다.

"5회 더 매수 가능"의 의미는 엄격한 카운트가 아니라,
"1/4를 매도했으니 약 5회분 자금이 확보되었다"는 의미입니다.
따라서 T값이 19 이하로 떨어지면 자연스럽게 일반 모드로 복귀합니다.

```javascript
// PDF 명시: "19< T <20 인 경우"
// 핵심: 상태 플래그 없이 T값만으로 판단

// 매도 주문 생성 로직 (매일 적용)
function generate_sell_orders(T값, 별퍼센트, 잔금, 1회매수금) {

  if (T값 > 19) {
    // 쿼터모드 (19 < T < 20): MOC 강제 매도
    return {
      주문1_쿼터매도MOC: {
        수량: 누적수량 / 4,
        타입: 'MOC', // Market On Close (무조건 시장가 매도)
        설명: '자금 확보를 위한 강제 매도'
      },
      주문2_목표익절: {
        수량: 누적수량 * 3/4,
        타입: 'LIMIT',
        가격: 평단가 * (1 + 목표수익률/100),
        설명: '목표가 도달 시 익절'
      }
    }
  }

  else if (잔금 < 1회매수금) {
    // 잔금 부족 시: MOC 매도로 자금 확보
    return {
      주문1_쿼터매도MOC: {
        수량: 누적수량 / 4,
        타입: 'MOC',
        설명: '잔금 부족으로 자금 확보'
      },
      주문2_목표익절: {
        수량: 누적수량 * 3/4,
        타입: 'LIMIT',
        가격: 평단가 * (1 + 목표수익률/100)
      }
    }
  }

  else {
    // 일반 매도: 별%LOC 쿼터매도
    return {
      주문1_쿼터매도LOC: {
        수량: 누적수량 / 4,
        타입: 'LOC',
        가격: 평단가 * (1 + 별퍼센트/100),
        설명: '별%지점 이상이면 매도'
      },
      주문2_목표익절: {
        수량: 누적수량 * 3/4,
        타입: 'LIMIT',
        가격: 평단가 * (1 + 목표수익률/100)
      }
    }
  }
}

// 중요: "쿼터매도하는 그 날은, 매수시도는 없습니다"
// MOC 매도 실행된 날은 매수 주문 제출하지 않음

// 1회매수금: MOC/LOC 매도 후에도 유지
```

**쿼터모드 핵심 흐름 정리 (T값 기반)**:

| 조건 | 매도 타입 | 설명 |
|------|----------|------|
| T > 19 | **MOC** | 쿼터모드 진입, 강제 매도로 자금 확보 |
| 잔금 < 1회매수금 | **MOC** | 잔금 부족 시 자금 확보 |
| 그 외 (T ≤ 19) | **LOC** | 일반 별%LOC 쿼터매도 |

**상태 기반(A안) vs T값 기반(B안) 비교**:

| 항목 | A안 (상태 기반) ❌ | B안 (T값 기반) ✅ |
|------|------------------|------------------|
| 상태 추적 | quarter_mode_active 플래그 필요 | 불필요 |
| 매수 카운트 | 5회 카운트 추적 | 불필요 |
| 판단 기준 | 상태 + 카운트 | T값, 잔금만 확인 |
| 복잡도 | 높음 | 낮음 |
| 버그 가능성 | LOC+MOC 동시 발생 가능 | 없음 |

**⚠️ A안의 버그 사례**:
상태 기반으로 구현 시, quarter_mode_active=True 상태에서 5회 매수 완료 후
"LOC 탈출 기회" + "5회 완료 MOC"가 동시에 생성되어
같은 날 LOC와 MOC가 모두 체결되는 버그 발생.

**✅ B안 채택 이유**:
- 단순함: 매일 T값과 잔금만 확인
- 명확함: 조건이 상호 배타적 (T>19 → MOC, 그 외 → LOC)
- 안전함: 중복 주문 발생 불가

### 주문 실행 시간 및 매수 진입 시점

#### 매일 주문 설정
- **시간**: 오후 5시 또는 6시 (한국시간) 프리마켓 시작 후
- **체결**: 미국 장 종가(Close)에 LOC 주문 체결
- **프로세스**:
  1. T값 및 별% 계산
  2. LOC 매수/매도 주문 설정
  3. 종가에 자동 체결 대기

#### 사이클 최초 진입 타이밍
- **V2.2**: 원금 준비 완료 시 즉시 시작 (선택적으로 RSI 고려 가능)
- **V3.0 (TQQQ)**: RSI 무시, 사이클 종료 다음날 LOC 매수로 즉시 시작
- **V3.0 (SOXL)**: 변동성이 크므로 신중한 진입 권장

#### LOC 매수 체결 조건
```
전반전 예시 (T=6, 평단 $100):
- 0% LOC ($100): 종가 ≥ $100 → $100에 매수
- 7% LOC ($107): 종가 ≥ $107 → $107에 매수

후반전 예시 (T=25, 평단 $100, 별%=-2.5%):
- -2.5% LOC ($97.5): 종가 ≥ $97.5 → $97.5에 매수
```

**LOC의 핵심**: 급등 시에도 설정 가격 이상에서만 매수되어 평단 보호

---

## V2.2 매매 규칙

### 공통 설정 (40분할 기준)

#### 별% 계산식
```
기본 공식: 별% = 10 - T/2 × (40/a)
- a: 전체 분할 수
- 40분할인 경우: 별% = 10 - T/2
```

#### T값 계산
```
T = 매수누적액 / 1회매수액 (소수점 둘째자리 올림)
```

### 매수 규칙

#### 전반전 매수 (T < 20)
```javascript
const 별퍼센트 = 10 - T/2;

주문1: {
  금액: 1회매수금 / 2,
  타입: 'LOC',
  가격: 평단가 * (1 + 0/100) // 0%LOC = 평단가
}

주문2: {
  금액: 1회매수금 / 2,
  타입: 'LOC',
  가격: 평단가 * (1 + 별퍼센트/100) - 0.01 // 매도와 겹치지 않도록
}
```

#### 후반전 매수 (T ≥ 20)
```javascript
const 별퍼센트 = 10 - T/2;

주문1: {
  금액: 1회매수금,
  타입: 'LOC',
  가격: 평단가 * (1 + 별퍼센트/100) - 0.01
}
```

### 매도 규칙

#### 일반 매도: T≤39인 경우 (전후반전 공통)

```javascript
const 별퍼센트 = 10 - T/2;
const 목표수익률 = (종목 === 'TQQQ') ? 10 : 20;

// 매일 아래 2개 매도 주문을 같이 걸어둠

주문1_쿼터매도: {
  수량: 누적수량 / 4,
  타입: 'LOC',
  가격: 평단가 * (1 + 별퍼센트/100),
  설명: '별%LOC 쿼터매도 - 수익 구간에서 1/4 수익 실현'
}

주문2_목표익절: {
  수량: 누적수량 * 3/4,
  타입: 'LIMIT',
  가격: 평단가 * (1 + 목표수익률/100),
  설명: 'TQQQ 10%, SOXL 20% 목표 익절'
}
```

### 쿼터손절 모드 (39 < T ≤ 40)

#### 초기 진입
```javascript
// 1/4 강제 매도
주문_MOC: {
  수량: 누적수량 / 4,
  타입: 'MOC'
}

// 매도 후 잔여 자금 + 수익금으로 10회 분할 매수금 계산
const 추가매수금 = (잔여자금 + 기존수익금) / 10;
// 단, 기존 1회매수금을 초과하지 않음
```

#### 1~10회 추가 매수
```javascript
매수주문: {
  금액: 추가매수금,
  타입: 'LOC',
  가격: 평단가 * (1 - 10/100) // -10%LOC
}

쿼터매도: {
  수량: 누적수량 / 4,
  타입: 'LOC',
  가격: 평단가 * (1 - 10/100)
}

지정가매도: {
  수량: 누적수량 * 3/4,
  타입: 'LIMIT',
  가격: 평단가 * (1 + 10/100)
}
```

#### 10회 완료 후
```javascript
// 1/4 강제 매도
주문_MOC: {
  수량: 누적수량 / 4,
  타입: 'MOC'
}

// MOC 매도가 -10% 밖에서 체결되면 → 쿼터손절 모드 반복
// MOC 매도가 -10% 안쪽에서 체결되면 → 후반전 모드로 복귀
```

---

## 주문 타입 정의

### LOC (Limit On Close)
- **설명**: 종가에 지정가 이하/이상으로 체결
- **매수**: 지정가 이상일 때만 체결
- **매도**: 지정가 이하일 때만 체결
- **장점**: 급등/급락 시 평단 보호

### MOC (Market On Close)
- **설명**: 종가에 무조건 체결
- **용도**: 쿼터매도 강제 실행

### LIMIT (지정가)
- **설명**: 지정가 도달 시 체결 (장중 실시간)
- **용도**: 목표 수익률 달성 시 익절

---

## 시스템 구현 요구사항

### 1. 핵심 데이터 관리

#### 사이클 상태
```typescript
interface CycleState {
  // 기본 정보
  ticker: 'TQQQ' | 'SOXL';
  version: 'V2.2' | 'V3.0';
  splitCount: 20 | 40; // 분할 수

  // 회차 정보
  T: number; // 현재 회차

  // 금액 정보
  원금: number;
  누적매수금: number;
  1회매수금: number;
  잔여자금: number;

  // 보유 정보
  누적수량: number;
  평단가: number;

  // 수익 정보
  과거수익최대치: number; // V3.0 전용
  보관수익금: number; // V3.0 전용

  // 모드 정보
  mode: 'first_half' | 'second_half' | 'quarter_mode';

  // 쿼터모드 상태 (V3.0)
  quarter_mode_active: boolean; // 쿼터모드 진행 중 여부
  quarter_buy_count: number; // 쿼터모드 중 매수 횟수 (0~5)
  quarter_moc_sold_today: boolean; // 오늘 MOC 매도 실행 여부

  // 주문 히스토리
  orderHistory: Order[];
}
```

#### 주문 객체
```typescript
interface Order {
  id: string;
  timestamp: Date;

  // 주문 정보
  side: 'BUY' | 'SELL';
  type: 'LOC' | 'MOC' | 'LIMIT';

  // 수량/가격
  quantity?: number; // 매도 시
  amount?: number; // 매수 시
  price: number;

  // 계산 정보
  T: number;
  별퍼센트: number;
  평단가: number;

  // 실행 결과
  status: 'pending' | 'filled' | 'cancelled';
  filledPrice?: number;
  filledQuantity?: number;
  filledAt?: Date;

  // 쿼터모드 관련 (V3.0)
  reason?: string; // 매도 사유 ('쿼터매도 (별%LOC)', '쿼터모드 MOC 매도', '목표 익절' 등)
  skip_buy_today?: boolean; // true면 이날 매수 주문 제출 안함
}
```

### 2. 매일 실행 프로세스

```typescript
async function dailyTradingProcess() {
  // 1. 현재 상태 로드
  const state = await loadCycleState();

  // 2. 일일 플래그 초기화
  state.quarter_moc_sold_today = false;

  // 3. T값 계산
  const T = Math.ceil((state.누적매수금 / state.1회매수금) * 100) / 100;

  // 4. 별% 계산
  const 별퍼센트 = calculateStarPercent(state.ticker, state.version, T, state.splitCount);

  // 5. 모드 결정
  const mode = determineMode(T, state.splitCount, state.version);

  // 6. 매도 주문 생성 (먼저 실행)
  const sellOrders = generateSellOrders(state, T, 별퍼센트, mode);

  // 7. 매수 주문 생성
  // PDF: "쿼터매도하는 그 날은, 매수시도는 없습니다"
  let buyOrders = [];
  const hasMOCSellToday = sellOrders.some(order =>
    order.type === 'MOC' && order.skip_buy_today === true
  );

  if (!hasMOCSellToday) {
    buyOrders = generateBuyOrders(state, T, 별퍼센트, mode);
  }

  // 8. 주문 제출
  await submitOrders([...sellOrders, ...buyOrders]);

  // 9. 쿼터모드 상태 업데이트
  if (state.version === 'V3.0' && T > 19 && T < 20) {
    // 쿼터모드 진입 or 진행
    if (hasMOCSellToday) {
      state.quarter_mode_active = true;
      state.quarter_buy_count = 0; // MOC 매도 시 카운터 리셋
      state.quarter_moc_sold_today = true;
    }
  } else {
    // 쿼터모드 종료
    state.quarter_mode_active = false;
    state.quarter_buy_count = 0;
  }

  // 10. 상태 저장
  await saveCycleState(state);
}
```

### 3. 별% 계산 로직

```typescript
function calculateStarPercent(
  ticker: 'TQQQ' | 'SOXL',
  version: 'V2.2' | 'V3.0',
  T: number,
  splitCount: number
): number {
  if (version === 'V3.0') {
    if (ticker === 'TQQQ') {
      return 15 - 1.5 * T;
    } else { // SOXL
      return 20 - 2.0 * T;
    }
  } else { // V2.2
    // 기본 공식: 10 - T/2 × (40/a)
    return 10 - (T / 2) * (40 / splitCount);
  }
}
```

### 4. 1회매수금 업데이트 (V3.0)

```typescript
function update1회매수금(state: CycleState, 사이클수익: number) {
  if (사이클수익 > 0) {
    // 수익의 50%를 1회매수금에 즉시 반영
    state.1회매수금 += 사이클수익 / 40;

    // 나머지 50%는 보관
    state.보관수익금 += 사이클수익 / 2;

    // 최대치 갱신
    if (사이클수익 > state.과거수익최대치) {
      state.과거수익최대치 = 사이클수익;
    }
  } else {
    // 손실 시: 1회매수금 유지
    // (과거 수익 최대치 기준으로 계산된 값 유지)

    // 자금 부족 시 보관수익금에서 충당
    if (state.잔여자금 < state.1회매수금) {
      const 부족금 = state.1회매수금 - state.잔여자금;
      if (state.보관수익금 >= 부족금) {
        state.보관수익금 -= 부족금;
        state.잔여자금 += 부족금;
      }
    }
  }
}
```

### 5. 매수 주문 생성

```typescript
function generateBuyOrders(
  state: CycleState,
  T: number,
  별퍼센트: number,
  mode: string
): Order[] {
  const orders: Order[] = [];
  const 평단가 = state.평단가;
  const 별가격 = 평단가 * (1 + 별퍼센트 / 100);

  if (state.version === 'V3.0') {
    if (mode === 'first_half') {
      // 전반전: 2개 주문
      orders.push({
        side: 'BUY',
        type: 'LOC',
        amount: state.1회매수금 / 2,
        price: 별가격,
        T, 별퍼센트, 평단가
      });

      orders.push({
        side: 'BUY',
        type: 'LOC',
        amount: state.1회매수금 / 2,
        price: 평단가, // 0%LOC
        T, 별퍼센트, 평단가
      });

    } else if (mode === 'second_half') {
      // 후반전: 1개 주문
      orders.push({
        side: 'BUY',
        type: 'LOC',
        amount: state.1회매수금,
        price: 별가격,
        T, 별퍼센트, 평단가
      });
    }

    // 급락 대비 추가 매수 (여러 LOC 주문)
    // ...

  } else { // V2.2
    if (mode === 'first_half') {
      orders.push({
        side: 'BUY',
        type: 'LOC',
        amount: state.1회매수금 / 2,
        price: 평단가,
        T, 별퍼센트, 평단가
      });

      orders.push({
        side: 'BUY',
        type: 'LOC',
        amount: state.1회매수금 / 2,
        price: 별가격 - 0.01, // 매도와 겹치지 않도록
        T, 별퍼센트, 평단가
      });

    } else {
      orders.push({
        side: 'BUY',
        type: 'LOC',
        amount: state.1회매수금,
        price: 별가격 - 0.01,
        T, 별퍼센트, 평단가
      });
    }
  }

  return orders;
}
```

### 6. 매도 주문 생성

```typescript
function generateSellOrders(
  state: CycleState,
  T: number,
  별퍼센트: number,
  mode: string
): Order[] {
  const orders: Order[] = [];
  const 평단가 = state.평단가;
  const 누적수량 = state.누적수량;
  const 별가격 = 평단가 * (1 + 별퍼센트 / 100);

  if (state.version === 'V3.0') {
    const 목표수익률 = state.ticker === 'TQQQ' ? 15 : 20;

    if (T <= 19) {
      // 일반 매도: T≤19
      // PDF: "T≤19인 경우, 전후반전 상관없이 공통으로 적용됩니다"

      // 1/4 별%LOC 쿼터매도
      orders.push({
        side: 'SELL',
        type: 'LOC',
        quantity: 누적수량 / 4,
        price: 별가격,
        T, 별퍼센트, 평단가,
        reason: '쿼터매도 (별%LOC)'
      });

      // 3/4 목표가 지정가 매도
      orders.push({
        side: 'SELL',
        type: 'LIMIT',
        quantity: 누적수량 * 3 / 4,
        price: 평단가 * (1 + 목표수익률 / 100),
        T, 별퍼센트, 평단가,
        reason: `목표 익절 (${목표수익률}%)`
      });

    } else if (T > 19 && T < 20) {
      // 쿼터모드: 19 < T < 20
      // PDF: "19< T <20 인 경우"

      // 쿼터모드 진입 여부 확인
      if (!state.quarter_mode_active) {
        // 첫 진입: 1/4 MOC 강제 매도
        orders.push({
          side: 'SELL',
          type: 'MOC',
          quantity: 누적수량 / 4,
          price: 0, // MOC는 시장가
          T, 별퍼센트, 평단가,
          reason: '쿼터모드 MOC 매도',
          skip_buy_today: true // 이날은 매수 없음
        });
      } else {
        // 쿼터모드 진행 중: 일반 별%LOC 매도
        orders.push({
          side: 'SELL',
          type: 'LOC',
          quantity: 누적수량 / 4,
          price: 별가격,
          T, 별퍼센트, 평단가,
          reason: '쿼터모드 LOC 매도'
        });

        // 5회 완료 or 잔금 소진 시 추가 MOC
        if (state.quarter_buy_count >= 5 || state.cash < state.buy_per_round) {
          orders.push({
            side: 'SELL',
            type: 'MOC',
            quantity: 누적수량 / 4,
            price: 0,
            T, 별퍼센트, 평단가,
            reason: '쿼터모드 추가 MOC',
            skip_buy_today: true
          });
        }
      }

      // 목표 익절 (쿼터모드 중에도)
      orders.push({
        side: 'SELL',
        type: 'LIMIT',
        quantity: 누적수량 * 3 / 4,
        price: 평단가 * (1 + 목표수익률 / 100),
        T, 별퍼센트, 평단가,
        reason: `목표 익절 (${목표수익률}%)`
      });
    }

  } else { // V2.2 매도 로직
    // ... (유사하지만 목표수익률 10% 고정)
  }

  return orders;
}
```

### 7. 모드 결정

```typescript
function determineMode(
  T: number,
  splitCount: number,
  version: string
): string {
  const 전후반경계 = splitCount / 2;

  if (version === 'V3.0') {
    if (T < 전후반경계) {
      return 'first_half';
    } else if (T < splitCount - 1) {
      return 'second_half';
    } else {
      return 'quarter_mode';
    }
  } else {
    // V2.2
    if (T < 20) {
      return 'first_half';
    } else if (T < 39) {
      return 'second_half';
    } else {
      return 'quarter_loss_cut';
    }
  }
}
```

### 8. 사이클 종료 및 재시작

```typescript
async function checkCycleCompletion(state: CycleState) {
  const 목표수익률 = state.ticker === 'TQQQ' ?
    (state.version === 'V3.0' ? 15 : 10) : 20;

  const 현재가격 = await getCurrentPrice(state.ticker);
  const 수익률 = ((현재가격 - state.평단가) / state.평단가) * 100;

  if (수익률 >= 목표수익률) {
    // 전량 매도 체결 확인
    if (state.누적수량 === 0) {
      // 사이클 완료
      const 사이클수익 = calculateProfit(state);

      if (state.version === 'V3.0') {
        update1회매수금(state, 사이클수익);
      }

      // 새 사이클 시작
      resetCycle(state);

      // 다음날 LOC 매수로 즉시 시작 (V3.0 TQQQ의 경우 RSI 무시)
    }
  }
}
```

---

## 구현 시 주의사항

### 1. 가격 계산 정밀도
- 소수점 처리에 주의 (특히 T값 계산 시 올림)
- 가격은 최소 0.01 단위

### 2. 주문 충돌 방지
- 매수와 매도가 같은 가격에 걸리지 않도록 매수점에서 -0.01달러 (V3.0: 매수점 조정)

### 3. 상태 동기화
- 주문 체결 후 즉시 상태 업데이트
- 평단가, 누적수량, T값 실시간 계산

### 4. 에러 처리
- API 실패 시 재시도 로직
- 자금 부족 시 알림
- 주문 체결 실패 시 로깅

### 5. 백테스팅
- 과거 데이터로 검증
- 엣지 케이스 테스트 (급등/급락, 횡보장 등)

### 6. 모니터링
- 일일 매매 리포트
- 수익률 추적
- 이상 거래 감지

---

## 참고 자료

### 웹 자료
- [나무위키 - 라오어의 미국주식 무한매수법](https://namu.wiki/w/라오어의%20미국주식%20무한매수법)
- [pebledot 블로그 - V2.2 vs V3.0](https://pebledot.blogspot.com/2024/09/v22-v30.html)

### 백테스팅 결과 (V3.0, SOXL 20분할 20% 기준)
- **3년 이동 누적 수익률**
  - 최소값: 약 52% (2017년 3월 시작 ~ 2020년 3월 코로나 최저점)
  - 최대값: 약 138% (2018년 말 시작 ~ 2021년 말 최고점)

### 위험 고지
- **레버리지 ETF 특성상 급격한 변동에 취약**
- **닷컴버블, 리먼사태 같은 대규모 하락장에서 큰 손실 가능**
- **규칙을 반드시 지켜야 함 (감정 배제)**
- **초보자는 40분할로 최소 6개월 이상 경험 후 20분할 고려**

---

## 버전 히스토리

- **V3.0** (2024.06): 20분할 지원, 반복리, 쿼터매도 개념 단순화
- **V2.2** (2023.05): 40분할 안정화, 별% LOC 매수/매도 통합
- **V2.1 이전**: 초기 버전들

---

## V3.0 매도 규칙 요약 (PDF 기준)

### 핵심 원칙

**V3.0의 매도는 2가지 상황으로 명확히 구분됩니다:**

1. **일반 매도 (T≤19)**: 항상 1/4 별%LOC 쿼터매도 + 3/4 목표가 지정가 매도
2. **쿼터모드 (19<T<20)**: 1/4 MOC 강제 매도 → 5회 추가 매수 → 반복

### 상세 비교표

| 구분 | T≤19 (일반) | 19<T<20 (쿼터모드) |
|------|-------------|-------------------|
| **1/4 매도** | 별%LOC (조건부) | MOC (무조건) |
| **3/4 매도** | 목표가 LIMIT | 목표가 LIMIT |
| **매수 진행** | 정상 진행 | MOC 매도 날은 중단 |
| **1회매수금** | 정상 유지 | MOC 후에도 유지 |
| **추가 매수** | - | 5회까지 가능 |
| **목적** | 수익 실현 | 자금 확보 |

### 쿼터모드 상세 흐름

```
1. 진입: T > 19
   ↓
2. 첫 MOC 매도: 1/4 무조건 매도
   → 이날 매수 없음
   ↓
3. 이후 5회: 일반 별%LOC 매수/매도
   - T값에 따라 별% 계산
   - 별%LOC에서 1/4 매도 가능
   ↓
4. LOC 매도 체결 시
   → 일반 모드 복귀
   ↓
5. 5회 완료 or 잔금 소진 시
   → 다시 1/4 MOC 매도 (2단계로 복귀)
```

### 구현 시 주의사항

1. **T≤19**: 반드시 1/4 별%LOC 쿼터매도 주문 걸기 (누락하면 안됨!)
2. **MOC 매도 날**: 매수 주문 제출 금지
3. **1회매수금**: MOC 매도 후에도 변경 없음
4. **쿼터모드 카운터**: 매수 횟수 추적 (0~5회)
5. **상태 관리**: `quarter_mode_active`, `quarter_buy_count`, `quarter_moc_sold_today` 필요

### PDF 출처

- **파일명**: mmb3.0.pdf
- **섹션**: 3. 매도하기, 4. 쿼터모드기간
- **발표일**: 2024년 6월 13일
- **저자**: 라오어

---

**문서 작성일**: 2026-01-16
**최종 수정일**: 2026-01-16 (PDF 기준 업데이트 완료)
**작성자**: Claude (Based on 라오어's methodology from mmb3.0.pdf)
