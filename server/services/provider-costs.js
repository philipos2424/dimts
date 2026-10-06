import * as database from '../db/pool.js';

const TELNYX_TYPES = ['call-control', 'sip-trunking', 'recording', 'verify'];

async function telnyxRecords(type, range, fetchImpl) {
  const records = [];
  for (let page = 1; page <= 200; page++) {
    const url = `https://api.telnyx.com/v2/detail_records?filter[record_type]=${type}&filter[date_range]=${range}&page[size]=50&page[number]=${page}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Telnyx detail records ${type}: HTTP ${res.status}`);
    const body = await res.json();
    records.push(...(body.data ?? []));
    if (page >= (body.meta?.total_pages ?? 1)) break;
  }
  return records;
}

/** Group detail records into one row per UTC day, record type and destination country. */
export function aggregateTelnyx(type, records) {
  const rows = new Map();
  for (const record of records) {
    const at = record.started_at ?? record.created_at;
    if (!at) continue;
    const day = new Date(at).toISOString().slice(0, 10);
    const country = String(record.country_code ?? '');
    // Verify records carry a rate per message, not a cost.
    const cost = record.cost != null ? Number(record.cost) : Number(record.rate ?? 0) * Number(record.count ?? 1);
    const key = `${day}|${country}`;
    const row = rows.get(key) ?? { day, provider: 'telnyx', record_type: type, country_code: country, records: 0, billed_sec: 0, cost_micros: 0 };
    row.records++;
    row.billed_sec += Number(record.billed_sec ?? 0);
    row.cost_micros += Math.round((Number.isFinite(cost) ? cost : 0) * 1e6);
    rows.set(key, row);
  }
  return [...rows.values()];
}

/**
 * Copy what Telnyx actually billed into provider_costs. Re-reads the last few
 * days because records arrive late, and writes only whole days: the oldest
 * day in the window and today may be partial, so they are skipped.
 */
export async function syncProviderCosts({ db = database, fetchImpl = fetch, now = new Date(), days = 4 } = {}) {
  if (process.env.CARRIER !== 'telnyx' || !process.env.TELNYX_API_KEY) return { skipped: 'telnyx_not_configured' };
  const today = now.toISOString().slice(0, 10);
  const oldest = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  let written = 0;
  for (const type of TELNYX_TYPES) {
    const rows = aggregateTelnyx(type, await telnyxRecords(type, `last_${days}_days`, fetchImpl))
      .filter(row => row.day > oldest && row.day < today);
    await db.withTransaction(async tx => {
      for (const day of new Set(rows.map(row => row.day))) {
        await tx.query(`DELETE FROM provider_costs WHERE day=$1 AND provider='telnyx' AND record_type=$2`, [day, type]);
      }
      for (const row of rows) {
        await tx.query(`INSERT INTO provider_costs(day,provider,record_type,country_code,records,billed_sec,cost_micros)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [row.day, row.provider, row.record_type, row.country_code, row.records, row.billed_sec, row.cost_micros]);
        written++;
      }
    });
  }
  return { written };
}
