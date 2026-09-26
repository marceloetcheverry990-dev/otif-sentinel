/**
 * Dentro de una TX de Postgres, un error deja la transacción abortada: todo lo
 * que sigue falla y el COMMIT final hace ROLLBACK en silencio. Un paso opcional
 * (o con fallback de columna) que puede fallar va en su propio SAVEPOINT para
 * que su error no se lleve el resto de la TX.
 */
export async function withSavepoint(client, name, fn) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const out = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return out;
  } catch (err) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch (_) { /* ignore */ }
    throw err;
  }
}
