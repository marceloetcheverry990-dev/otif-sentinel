// Supabase en memoria para el bench del optimizador: filtros básicos de
// PostgREST (eq/neq/is/not/in/order/limit) sobre filas fijas, y registro de
// cada escritura (update/upsert/insert) para poder medir qué se persistió.

function parseInList(raw) {
  return String(raw).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
}

export function createSupabaseMemoria(tables) {
  const writes = [];

  function from(table) {
    const st = { filters: [], order: null, limit: null, op: 'select', payload: null, head: false };
    const b = {
      select(_cols, opts) { if (opts && opts.head) st.head = true; return b; },
      eq(c, v) { st.filters.push((r) => String(r[c]) === String(v)); return b; },
      neq(c, v) { st.filters.push((r) => String(r[c]) !== String(v)); return b; },
      is(c, v) { st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      not(c, op, v) {
        if (op === 'is') st.filters.push((r) => r[c] != null);
        else if (op === 'in') { const set = parseInList(v); st.filters.push((r) => !set.includes(String(r[c]))); }
        return b;
      },
      in(c, arr) { st.filters.push((r) => arr.map(String).includes(String(r[c]))); return b; },
      or() { return b; },
      gte() { return b; },
      lte() { return b; },
      ilike() { return b; },
      order(c, opts = {}) { st.order = { c, asc: opts.ascending !== false }; return b; },
      limit(n) { st.limit = n; return b; },
      update(p) { st.op = 'update'; st.payload = p; return b; },
      upsert(p) { st.op = 'upsert'; st.payload = p; return b; },
      insert(p) { st.op = 'insert'; st.payload = p; return b; },
      maybeSingle() { st.single = true; return b; },
      single() { st.single = true; return b; },
      then(resolve, reject) {
        if (st.op !== 'select') {
          writes.push({ table, op: st.op, payload: st.payload, match: (r) => st.filters.every((f) => f(r)) });
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        let rows = (tables[table] || []).filter((r) => st.filters.every((f) => f(r)));
        if (st.order) {
          const { c, asc } = st.order;
          rows = [...rows].sort((a, z) => ((Number(a[c]) || 0) - (Number(z[c]) || 0)) * (asc ? 1 : -1));
        }
        if (st.limit != null) rows = rows.slice(0, st.limit);
        const res = st.head
          ? { data: null, count: rows.length, error: null }
          : { data: st.single ? (rows[0] || null) : rows, error: null };
        return Promise.resolve(res).then(resolve, reject);
      },
    };
    return b;
  }

  return { client: { from, rpc: async () => ({ data: null, error: null }) }, writes };
}
