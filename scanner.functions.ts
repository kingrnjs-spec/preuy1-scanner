import { createServerFn } from "@tanstack/react-start";
import { evaluate, type Bar } from "./strategy";

// 데이터소스: KRX OPEN API (승인 서비스)
//  - 유가증권 일별매매정보: sto/stk_bydd_trd
//  - 코스닥 일별매매정보:   sto/ksq_bydd_trd
// 인증키는 서버에서만 KRX_API_KEY 를 읽어 헤더 AUTH_KEY 로 전송한다.
// 거래일 판정: 응답 OutBlock_1 이 비어 있으면 해당 일자는 데이터 없음(휴장/미제공).
// 전략 수식/조건/임계값/제외규칙은 변경하지 않는다.

const KRX_BASE = "https://data-dbg.krx.co.kr/svc/apis/sto/";
const KRX_STK = "stk_bydd_trd";
const KRX_KSQ = "ksq_bydd_trd";
const WORKERS = 8; // 원본 loadHistory workers
const HISTORY_DAYS = 155; // 원본 loadHistory 과거 거래일 수(dates.slice(-155))

export type Row = {
  code: string;
  name: string;
  market: "KOSPI" | "KOSDAQ";
  date: string;
  close: number;
  reason: string;
  finalLine: number;
};

export type ScanResult = {
  targetDate: string;
  mode: string;
  refDate: string;
  archiveLatest: string;
  archiveDates: number;
  universe: number;
  excluded: number;
  computed: number;
  skippedShort: number;
  skippedStale: number;
  liveCount: number;
  rows: Row[];
};

type KrxRow = Record<string, string>;

async function fetchKrx(service: string, basDd: string): Promise<KrxRow[]> {
  const key = process.env["KRX_API_KEY"];
  if (!key) throw new Error("실행중지 — KRX_API_KEY 미설정");
  const url = `${KRX_BASE}${service}?basDd=${basDd}`;
  const opts = { cache: "no-store" as const, headers: { AUTH_KEY: key } };
  let res = await fetch(url, opts);
  if (!res.ok) {
    throw new Error(`실행중지 — KRX 데이터 호출 실패: ${service} ${basDd} (HTTP ${res.status})`);
  }
  let text = await res.text();
  if (text.length === 0) {
    res = await fetch(url, opts);
    if (!res.ok) {
      throw new Error(`실행중지 — KRX 데이터 호출 실패: ${service} ${basDd} (HTTP ${res.status})`);
    }
    text = await res.text();
  }
  let json: { OutBlock_1?: KrxRow[] };
  try {
    json = JSON.parse(text) as { OutBlock_1?: KrxRow[] };
  } catch (parseErr) {
    throw new Error(`실행중지 — KRX 응답 JSON 파싱 실패: ${service} ${basDd} (len=${text.length})`);
  }
  const rows = json.OutBlock_1;
  if (!Array.isArray(rows)) throw new Error(`실행중지 — KRX 응답 형식 확인 실패: ${service} ${basDd}`);
  return rows;
}

function num(v: unknown): number {
  if (v == null) return NaN;
  const s = String(v).replace(/,/g, "").trim();
  if (s === "") return NaN;
  const x = Number(s);
  return Number.isFinite(x) ? x : NaN;
}

function code6(v: unknown): string {
  let s = String(v ?? "")
    .trim()
    .toUpperCase()
    .replace(/^A/, "")
    .replace(/[^0-9]/g, "");
  if (s.length > 6) s = s.slice(-6);
  return s.padStart(6, "0");
}

function badName(name: string): boolean {
  const s = (name || "").trim();
  const u = s.toUpperCase().replace(/\s/g, "");
  return (
    s.includes("스팩") ||
    u.includes("SPAC") ||
    u.includes("ETF") ||
    u.includes("ETN") ||
    s.endsWith("우") ||
    s.includes("우B") ||
    s.includes("우C")
  );
}

async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        await fn(items[i]!);
      }
    }),
  );
}

type Store = Map<string, { name: string; market: "KOSPI" | "KOSDAQ"; bars: Map<string, Bar> }>;

function parseKrxRows(rows: KrxRow[], store: Store): void {
  for (const r of rows) {
    const raw = String(r["MKT_NM"] ?? "").toUpperCase();
    const mkt: "KOSPI" | "KOSDAQ" | null = raw.includes("KOSPI")
      ? "KOSPI"
      : raw.includes("KOSDAQ")
        ? "KOSDAQ"
        : null;
    if (!mkt) continue;
    const code = code6(r["ISU_CD"]);
    if (!/^[0-9]{6}$/.test(code)) continue;
    const date = String(r["BAS_DD"] ?? "").trim();
    if (!date) continue;
    const o = num(r["TDD_OPNPRC"]);
    const h = num(r["TDD_HGPRC"]);
    const l = num(r["TDD_LWPRC"]);
    const c = num(r["TDD_CLSPRC"]);
    const v = num(r["ACC_TRDVOL"]);
    if (![o, h, l, c, v].every((x) => Number.isFinite(x))) continue;
    const bar: Bar = { date, o, h, l, c, v };
    let e = store.get(code);
    if (!e) {
      e = { name: String(r["ISU_NM"] ?? "").trim(), market: mkt, bars: new Map() };
      store.set(code, e);
    }
    e.bars.set(bar.date, bar);
  }
}

function kstToday(): string {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function shiftDate(yyyymmdd: string, deltaDays: number): string {
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
}

export const runScan = createServerFn({ method: "POST" }).handler(async (): Promise<ScanResult> => {
  try {
    const store: Store = new Map();
    const tradingDates: string[] = [];
    let cursor = kstToday();

    while (tradingDates.length < HISTORY_DAYS) {
      const probe: string[] = [];
      for (let i = 0; i < WORKERS; i++) {
        probe.push(cursor);
        cursor = shiftDate(cursor, -1);
      }
      const found = new Map<string, KrxRow[]>();
      await pool(probe, WORKERS, async (d) => {
        const rows = await fetchKrx(KRX_STK, d);
        if (rows.length > 0) found.set(d, rows);
      });
      for (const d of probe) {
        const rows = found.get(d);
        if (!rows) continue;
        if (tradingDates.length >= HISTORY_DAYS) break;
        tradingDates.push(d);
        parseKrxRows(rows, store);
      }
    }

    tradingDates.sort();

    await pool(tradingDates, WORKERS, async (d) => {
      const rows = await fetchKrx(KRX_KSQ, d);
      if (rows.length === 0) {
        throw new Error(`실행중지 — 코스닥 일별매매정보 0건: ${d}`);
      }
      parseKrxRows(rows, store);
    });

    const dates = tradingDates;
    if (dates.length < 150) {
      throw new Error(
        `실행중지 — 과거 일봉 거래일이 ${dates.length}개로 원본 최소 요건(150개)에 미달합니다. 추정 보정 없이 중지합니다.`,
      );
    }
    const archiveLatest = dates[dates.length - 1] as string;
    const targetDate = archiveLatest;
    const refDate = archiveLatest;
    const mode = "확정 일봉";
    const liveCount = 0;

    let excluded = 0;
    let computed = 0;
    let skippedShort = 0;
    let skippedStale = 0;
    const rows: Row[] = [];

    for (const [code, e] of store) {
      const bars = Array.from(e.bars.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (bars.length < 150) {
        skippedShort++;
        continue;
      }
      const last = bars[bars.length - 1]!;
      if (last.date !== targetDate) {
        skippedStale++;
        continue;
      }
      if (last.c <= 1200 || last.v <= 0 || badName(e.name)) {
        excluded++;
        continue;
      }
      computed++;
      const sig = evaluate(bars);
      if (!sig) continue;
      rows.push({
        code,
        name: e.name,
        market: e.market,
        date: sig.date,
        close: sig.close,
        reason: sig.reason,
        finalLine: sig.finalLine,
      });
    }

    rows.sort((a, b) => a.name.localeCompare(b.name, "ko"));

    return {
      targetDate,
      mode,
      refDate,
      archiveLatest,
      archiveDates: dates.length,
      universe: store.size,
      excluded,
      computed,
      skippedShort,
      skippedStale,
      liveCount,
      rows,
    };
  } catch (error) {
    console.error(error);
    throw error;
  }
});
