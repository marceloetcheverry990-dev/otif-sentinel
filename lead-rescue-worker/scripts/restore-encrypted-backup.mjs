import { spawnSync } from 'node:child_process';
import { createHash, createDecipheriv, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('LB2BBK01');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`${basename(command)} failed: ${detail}`);
  }

  return result.stdout?.trim() || '';
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function unprotectKeyWithDpapi(keyPath) {
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$protected=[IO.File]::ReadAllBytes($env:BACKUP_KEY_PATH);',
    '$raw=[System.Security.Cryptography.ProtectedData]::Unprotect(',
    '$protected,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[Console]::Out.Write([Convert]::ToBase64String($raw));',
  ].join('');

  const encoded = run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, BACKUP_KEY_PATH: keyPath } },
  );
  return Buffer.from(encoded, 'base64');
}

async function decryptDump(sourcePath, destinationPath, key) {
  const info = await stat(sourcePath);
  if (info.size <= MAGIC.length + IV_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted backup is truncated');
  }

  const file = await open(sourcePath, 'r');
  try {
    const header = Buffer.alloc(MAGIC.length + IV_LENGTH);
    const tag = Buffer.alloc(TAG_LENGTH);
    await file.read(header, 0, header.length, 0);
    await file.read(tag, 0, tag.length, info.size - TAG_LENGTH);

    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Encrypted backup header is invalid');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      header.subarray(MAGIC.length),
    );
    decipher.setAuthTag(tag);

    await pipeline(
      createReadStream(sourcePath, {
        start: header.length,
        end: info.size - TAG_LENGTH - 1,
      }),
      decipher,
      createWriteStream(destinationPath, { flags: 'wx' }),
    );
  } finally {
    await file.close();
  }
}

function parseConnection(connectionString) {
  const connection = new URL(connectionString);
  const database = decodeURIComponent(connection.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_RESTORE_URL must include a database name');

  return {
    host: connection.hostname,
    port: connection.port || '5432',
    username: decodeURIComponent(connection.username),
    password: decodeURIComponent(connection.password),
    database,
    sslmode: connection.searchParams.get('sslmode') || 'require',
  };
}

async function main() {
  const encryptedArgument = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!encryptedArgument) {
    throw new Error(
      'Usage: node scripts/restore-encrypted-backup.mjs <backup.dump.enc> [--apply]',
    );
  }

  const apply = process.argv.includes('--apply');
  const encryptedPath = resolve(encryptedArgument);
  const metadataPath = `${encryptedPath}.json`;
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const keyPath = resolve(metadata.protectedKeyFile);

  const expectedHash = metadata.sha256;
  const actualHash = await hashFile(encryptedPath);
  if (!expectedHash || actualHash !== expectedHash) {
    throw new Error('Encrypted backup SHA-256 does not match its metadata');
  }

  const pgBinDirectory = resolve(
    process.env.PG_BIN_DIRECTORY || join(homedir(), 'Tools', 'PostgreSQL17', 'bin'),
  );
  const pgRestore = join(pgBinDirectory, 'pg_restore.exe');
  const temporaryDump = join(tmpdir(), `laboratorio-b2b-restore-${randomUUID()}.dump`);
  const key = unprotectKeyWithDpapi(keyPath);

  try {
    await decryptDump(encryptedPath, temporaryDump, key);
    const inventory = run(pgRestore, ['--list', temporaryDump], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const inventoryEntries = inventory
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith(';')).length;

    if (!apply) {
      console.log(`Backup verified. Restore inventory entries: ${inventoryEntries}`);
      console.log('No database changes were made. Add --apply for an explicit restore.');
      return;
    }

    if (!process.env.DATABASE_RESTORE_URL) {
      throw new Error('DATABASE_RESTORE_URL is required with --apply');
    }
    const target = parseConnection(process.env.DATABASE_RESTORE_URL);
    if (process.env.RESTORE_CONFIRM_DATABASE !== target.database) {
      throw new Error(
        'RESTORE_CONFIRM_DATABASE must exactly match the target database name',
      );
    }

    run(
      pgRestore,
      [
        '--host', target.host,
        '--port', target.port,
        '--username', target.username,
        '--dbname', target.database,
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        temporaryDump,
      ],
      {
        env: {
          ...process.env,
          PGPASSWORD: target.password,
          PGSSLMODE: target.sslmode,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    console.log(`Restore completed into database "${target.database}".`);
  } finally {
    key.fill(0);
    await rm(temporaryDump, { force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
