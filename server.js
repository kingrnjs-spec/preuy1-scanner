const KRX_BASE = "https://data-dbg.krx.co.kr/svc/apis/sto/";
const KRX_STK = "stk_bydd_trd";
const KRX_KSQ = "ksq_bydd_trd";
const WORKERS = 8;
const HISTORY_DAYS = 155;
const FINAL_PERIOD = 20;
const FINAL_MULTIPLIER = 1.10;

function html(body) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MASTER 선취매1번 스캐너</title>
<style>
body{margin:0;background:#0b1020;color:#f4f7fb;font-family:system-ui,-apple-system,sans-serif}
main{max-width:980px;margin:auto;padding:20px}
button{width:100%;padding:18px;border:0;border-radius:14px;font-size:18px;font-weight:700;cursor:pointer}
.card{margin-top:14px;padding:16px;border:1px solid #2a334a;border-radius:14px;background:#12192b}
small,.muted{color:#aab4c8}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
th,td{padding:9px;border-top:1px solid #2a334a;text-align:left;white-space:nowrap}
pre{white-space:pre-wrap;word-break:break-word}
</style>
</head>
<body><main>${body}</main></body></html>`;
}

const page = html(`
<h2>MASTER 선취매1번 스캐너</h2>
<div class="muted">Final선 = Lowest(L,20) × 1.10</div>
<div class="muted">신호 = 전일 종가 ≤ 전일 Final선 AND 당일 종가 &gt; 당일 Final선</div>
<button id="run">선취매1번 종목 뽑기</button>
<div id="status" class="card">대기 중</div>
<div id="audit"></div>
<div id="result"></div>
<script>
const $ = id => document.getElementById(id);
$("run").onclick = async () => {
  $("run").disabled = true;
  $("status").textContent = "실행 중…";
  $("audit").innerHTML = "";
  $("result").innerHTML = "";
  try {
    const r = await fetch("/scan", { method:"POST" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "실행실패");
    $("status").textContent = j.rows.length ? "완료" : "정상 0건";
    $("audit").innerHTML = '<div class="card"><pre>'+JSON.stringify({
      targetDate:j.targetDate, archiveDates:j.archiveDates, universe:j.universe,
      excluded:j.excluded, computed:j.computed, skippedShort:j.skippedShort,
      skippedStale:j.skippedStale, candidates:j.rows.length
    },null,2)+'</pre></div>';
    if (j.rows.length) {
      let h='<div class="card" style="overflow:auto"><table><thead><tr><th>종목명</th><th>코드</th><th>시장</th><th>기준일</th><th>종가</th><th>Final선</th></tr></thead><tbody>';
      for (const x of j.rows) {
        h += '<tr><td>'+x.name+'</td><td>'+x.code+'</td><td>'+x.market+'</td><td>'+x.date+'</td><td>'+x.close+'</td><td>'+x.finalLine.toFixed(2)+'</td></tr>';
      }
      h += '</tbody></table></div>';
      $("result").innerHTML = h;
    }
  } catch(e) {
    $("status").textContent = "실행중지 — " + e.message;
  } finally {
    $("run").disabled = false;
  }
};
</script>`);

function num(v) {
  if (v == null) return NaN;
  const s = String(v).replace(/,/g, "").trim();
  if (s === "") return NaN;
  const x = Number(s);
  return Number.isFinite(x) ? x : NaN;
}
function code6(v) {
  let s = String(v ?? "").trim().toUpperCase().replace(/^A/, "").replace(/[^0-9]/g, "");
  if (s.length > 6) s = s.slice(-6);
  return s.padStart(6, "0");
}
function badName(name) {
  const s = (name || "").trim();
  const u = s.toUpperCase().replace(/\s/g, "");
  return s.includes("스팩") || u.includes("SPAC") || u.includes("ETF") || u.includes("ETN") ||
         s.endsWith("우") || s.includes("우B") || s.includes("우C");
}
function kstToday() {
  const d = new Date(Date.now() + 9*60*60*1000);
  return d.toISOString().slice(0,10).replace(/-/g,"");
}
function shiftDate(yyyymmdd, deltaDays) {
  const y=Number(yyyymmdd.slice(0,4)), m=Number(yyyymmdd.slice(4,6)), d=Number(yyyymmdd.slice(6,8));
  const t=Date.UTC(y,m-1,d)+deltaDays*86400000;
  return new Date(t).toISOString().slice(0,10).replace(/-/g,"");
}
async function pool(items, limit, fn) {
  let idx=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)}, async()=>{
    while(idx<items.length){ const i=idx++; await fn(items[i]); }
  }));
}
async function fetchKrx(service, basDd) {
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error("KRX_API_KEY 미설정");
  const res = await fetch(`${KRX_BASE}${service}?basDd=${basDd}`, {
    cache:"no-store", headers:{AUTH_KEY:key}
  });
  if (!res.ok) throw new Error(`KRX 호출 실패: ${service} ${basDd} HTTP ${res.status}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`KRX JSON 파싱 실패: ${service} ${basDd}`); }
  if (!Array.isArray(json.OutBlock_1)) throw new Error(`KRX 응답형식 실패: ${service} ${basDd}`);
  return json.OutBlock_1;
}
function parseRows(rows, store) {
  for (const r of rows) {
    const raw=String(r.MKT_NM??"").toUpperCase();
    const market=raw.includes("KOSPI")?"KOSPI":raw.includes("KOSDAQ")?"KOSDAQ":null;
    if(!market) continue;
    const code=code6(r.ISU_CD);
    const date=String(r.BAS_DD??"").trim();
    const o=num(r.TDD_OPNPRC), h=num(r.TDD_HGPRC), l=num(r.TDD_LWPRC), c=num(r.TDD_CLSPRC), v=num(r.ACC_TRDVOL);
    if(!date || ![o,h,l,c,v].every(Number.isFinite)) continue;
    let e=store.get(code);
    if(!e){e={name:String(r.ISU_NM??"").trim(),market,bars:new Map()};store.set(code,e);}
    e.bars.set(date,{date,o,h,l,c,v});
  }
}
function evaluate(rows) {
  const q=rows.length-1, p=FINAL_PERIOD;
  if(q<=p-1) return null;
  const lows=rows.map(x=>x.l), closes=rows.map(x=>x.c);
  const line=i=>Math.min(...lows.slice(i-p+1,i+1))*FINAL_MULTIPLIER;
  const prev=line(q-1), curr=line(q);
  if(closes[q-1] <= prev && closes[q] > curr)
    return {date:rows[q].date,close:closes[q],finalLine:curr};
  return null;
}
async function scan() {
  const store=new Map(), tradingDates=[];
  let cursor=kstToday();
  while(tradingDates.length<HISTORY_DAYS){
    const probe=[];
    for(let i=0;i<WORKERS;i++){probe.push(cursor);cursor=shiftDate(cursor,-1);}
    const found=new Map();
    await pool(probe,WORKERS,async d=>{
      const rows=await fetchKrx(KRX_STK,d);
      if(rows.length) found.set(d,rows);
    });
    for(const d of probe){
      const rows=found.get(d);
      if(!rows) continue;
      if(tradingDates.length>=HISTORY_DAYS) break;
      tradingDates.push(d); parseRows(rows,store);
    }
  }
  tradingDates.sort();
  await pool(tradingDates,WORKERS,async d=>{
    const rows=await fetchKrx(KRX_KSQ,d);
    if(rows.length===0) throw new Error(`코스닥 일별매매정보 0건: ${d}`);
    parseRows(rows,store);
  });
  if(tradingDates.length<150) throw new Error(`과거 거래일 ${tradingDates.length}개 — 150개 미달`);
  const targetDate=tradingDates[tradingDates.length-1];
  let excluded=0,computed=0,skippedShort=0,skippedStale=0;
  const rows=[];
  for(const [code,e] of store){
    const bars=[...e.bars.values()].sort((a,b)=>a.date.localeCompare(b.date));
    if(bars.length<150){skippedShort++;continue;}
    const last=bars[bars.length-1];
    if(last.date!==targetDate){skippedStale++;continue;}
    if(last.c<=1200 || last.v<=0 || badName(e.name)){excluded++;continue;}
    computed++;
    const s=evaluate(bars);
    if(s) rows.push({code,name:e.name,market:e.market,date:s.date,close:s.close,finalLine:s.finalLine});
  }
  rows.sort((a,b)=>a.name.localeCompare(b.name,"ko"));
  return {targetDate,archiveDates:tradingDates.length,universe:store.size,excluded,computed,skippedShort,skippedStale,rows};
}

export default async function handler(req,res){
  try{
    if(req.url==="/scan" && req.method==="POST"){
      const result=await scan();
      res.statusCode=200;
      res.setHeader("content-type","application/json; charset=utf-8");
      res.end(JSON.stringify(result));
      return;
    }
    res.statusCode=200;
    res.setHeader("content-type","text/html; charset=utf-8");
    res.end(page);
  }catch(e){
    res.statusCode=500;
    res.setHeader("content-type","application/json; charset=utf-8");
    res.end(JSON.stringify({error:e instanceof Error?e.message:String(e)}));
  }
}
