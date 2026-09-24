// Cliente pg falso para tests, con la semántica de TX de Postgres que importa:
// tras un error, toda query falla con 25P02 hasta ROLLBACK TO SAVEPOINT.
// Si al final `state.aborted` sigue en true, el COMMIT real habría hecho ROLLBACK.
//
// rules: [[RegExp | (sql) => boolean, result | (sql, params) => result]]
// Primera regla que calza gana. Un handler que lanza deja la TX abortada.
import { vi } from 'vitest';

export function createFakePgTx(rules = []) {
  const state = { aborted: false, calls: [] };

  const query = vi.fn(async (sql, params = []) => {
    const s = String(sql).trim();
    state.calls.push({ sql: s, params });
    if (/^ROLLBACK TO SAVEPOINT/i.test(s)) {
      state.aborted = false;
      return { rowCount: 0, rows: [] };
    }
    if (state.aborted) {
      const err = new Error('current transaction is aborted, commands ignored until end of transaction block');
      err.code = '25P02';
      throw err;
    }
    if (/^(SAVEPOINT|RELEASE SAVEPOINT)/i.test(s)) return { rowCount: 0, rows: [] };

    for (const [match, result] of rules) {
      const hit = typeof match === 'function' ? match(s) : match.test(s);
      if (!hit) continue;
      if (typeof result !== 'function') return result;
      try {
        return await result(s, params);
      } catch (err) {
        state.aborted = true;
        throw err;
      }
    }
    return { rowCount: 0, rows: [] };
  });

  return {
    client: { query },
    state,
    /** Llamadas cuyo SQL calza con `re` (sin SAVEPOINT/RELEASE). */
    callsMatching(re) {
      return state.calls.filter((c) => re.test(c.sql));
    },
  };
}

export function pgError(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}
