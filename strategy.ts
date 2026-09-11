// 선취매1 — Final 전용.
//
// 원본 근거:
//   MASTER_100PCT_RULE_AUDIT_20260903.md — Final Buy = Lowest(L,20)*1.10 상향돌파
//   MASTER_A_종가베팅_A급B급_FAST_v0.3 (1).py
//     line[i] = min(low[i-19..i]) * 1.10
//     sig[i]  = close[i-1] <= line[i-1] AND close[i] > line[i]
//
// 오늘 sig 가 false 면 후보 제외.

export const FINAL_PERIOD = 20;
export const FINAL_MULTIPLIER = 1.10;

export type Bar = { date: string; o: number; h: number; l: number; c: number; v: number };

export type Signal = {
  date: string;
  close: number;
  finalLine: number;
  reason: string; // "Final 상향돌파"
};

/** Final 상향돌파가 아니면 null. */
export function evaluate(rows: Bar[]): Signal | null {
  const p = FINAL_PERIOD;
  const n = rows.length;
  const q = n - 1;
  if (q <= p - 1) return null;

  const C = rows.map((x) => x.c);
  const L = rows.map((x) => x.l);

  const finalLine: (number | null)[] = Array(n).fill(null);
  for (let i = p - 1; i < n; i++) {
    finalLine[i] = Math.min(...L.slice(i - p + 1, i + 1)) * FINAL_MULTIPLIER;
  }

  const prevLine = finalLine[q - 1];
  const currLine = finalLine[q];
  if (prevLine == null || currLine == null) return null;

  const sig = (C[q - 1] as number) <= prevLine && (C[q] as number) > currLine;
  if (!sig) return null;

  return {
    date: rows[q]!.date,
    close: C[q] as number,
    finalLine: currLine,
    reason: "Final 상향돌파",
  };
}
