import { spawnSync } from 'node:child_process';
import {
  appendFile,
  mkdir,
  open,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('LB2BBK01');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const backupDirectory = resolve(process.argv[2] || join(homedir(), 'Laboratorio-B2B-Backups'));
const pgBinDirectory = resolve(process.argv[3] || join(homedir(), 'Tools', 'PostgreSQL17', 'bin'));

const pgDump = join(pgBinDirectory, 'pg_dump.exe');
const pgRestore = join(pgBinDirectory, 'pg_restore.exe');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`${command} failed: ${detail}`);
  }

  return result.stdout?.trim() || '';
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function protectKeyWithDpapi(key, keyPath) {
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$raw=[Convert]::FromBase64String([Console]::In.ReadToEnd());',
    '$protected=[System.Security.Cryptography.ProtectedData]::Protect(',
    '$raw,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[IO.File]::WriteAllBytes($env:BACKUP_KEY_PATH,$protected);',
  ].join('');

  run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      input: key.toString('base64'),
      env: { ...process.env, BACKUP_KEY_PATH: keyPath },
    },
  );
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

async function encryptDump(sourcePath, destinationPath, key) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  await writeFile(destinationPath, Buffer.concat([MAGIC, iv]));
  await pipeline(
    createReadStream(sourcePath),
    cipher,
    createWriteStream(destinationPath, { flags: 'a' }),
  );
  await appendFile(destinationPath, cipher.getAuthTag());
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

    const iv = header.subarray(MAGIC.length);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    await pipeline(
      createReadStream(sourcePath, {
        start: header.length,
        end: info.size - TAG_LENGTH - 1,
      }),
      decipher,
      createWriteStream(destinationPath),
    );
  } finally {
    await file.close();
  }
}

async function main() {
  await mkdir(backupDirectory, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const encryptedPath = join(backupDirectory, `laboratorio-b2b-${timestamp}.dump.enc`);
  const metadataPath = `${encryptedPath}.json`;
  const temporaryDump = `${encryptedPath}.plain.tmp`;
  const verificationDump = `${encryptedPath}.verify.tmp`;

  const keyDirectory = join(
    process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
    'Laboratorio-B2B',
    'backup-keys',
  );
  await mkdir(keyDirectory, { recursive: true });
  const keyPath = join(keyDirectory, `laboratorio-b2b-${timestamp}.key.dpapi`);

  const connectionString =
    process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
  if (!connectionString) {
    throw new Error(
      'Set CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE before running the backup',
    );
  }
  const connection = new URL(connectionString);
  const username = decodeURIComponent(connection.username);
  const password = decodeURIComponent(connection.password);
  const database = decodeURIComponent(connection.pathname.replace(/^\//, ''));

  const pgEnvironment = {
    ...process.env,
    PGPASSWORD: password,
    PGSSLMODE: connection.searchParams.get('sslmode') || 'require',
  };

  const key = randomBytes(32);
  let completed = false;

  try {
    run(
      pgDump,
      [
        '--host', connection.hostname,
        '--port', connection.port || '5432',
        '--username', username,
        '--dbname', database,
        '--format', 'custom',
        '--no-owner',
        '--no-privileges',
        '--file', temporaryDump,
      ],
      { env: pgEnvironment, stdio: ['ignore', 'ignore', 'pipe'] },
    );

    run(pgRestore, ['--list', temporaryDump], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    await encryptDump(temporaryDump, encryptedPath, key);
    protectKeyWithDpapi(key, keyPath);

    const recoveredKey = unprotectKeyWithDpapi(keyPath);
    await decryptDump(encryptedPath, verificationDump, recoveredKey);
    run(pgRestore, ['--list', verificationDump], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const encryptedInfo = await stat(encryptedPath);
    const metadata = {
      createdAt: new Date().toISOString(),
      format: 'PostgreSQL custom dump encrypted with AES-256-GCM',
      keyProtection: 'Windows DPAPI CurrentUser',
      encryptedFile: encryptedPath,
      protectedKeyFile: keyPath,
      encryptedBytes: encryptedInfo.size,
      sha256: await hashFile(encryptedPath),
      pgDumpVersion: run(pgDump, ['--version']),
      restoreInventoryVerified: true,
    };

    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    completed = true;
    console.log(JSON.stringify(metadata, null, 2));
  } finally {
    key.fill(0);
    await rm(temporaryDump, { force: true });
    await rm(verificationDump, { force: true });
    if (!completed) {
      await rm(encryptedPath, { force: true });
      await rm(metadataPath, { force: true });
      await rm(keyPath, { force: true });
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
