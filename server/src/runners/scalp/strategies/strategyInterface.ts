/**
 * Quick Scalp v3 — 전략 플러그인 인터페이스
 *
 * 모든 진입 전략은 이 인터페이스를 구현한다.
 * evaluate()는 순수 함수 — API 호출, 상태 변경 금지.
 * 엔진이 호가/분봉을 종목당 1회만 조회해서 CandidateContext에 전달.
 */

import { type CandidateContext, type EntrySignal, type StrategyId } from '../scalpTypes';

export interface ScalpStrategy {
  readonly id: StrategyId;
  readonly label: string;
  readonly version: string;   // e.g. "1.0" — 로그에 기록

  /** 시간대 필터. false면 엔진이 evaluate 호출을 skip. */
  isActiveAt(currentMinute: number): boolean;

  /** 단일 후보 평가. 순수 함수, 부작용 금지. */
  evaluate(ctx: CandidateContext): EntrySignal;
}
