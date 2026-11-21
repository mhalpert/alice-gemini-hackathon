import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CERT_DIR = path.resolve(import.meta.dirname, '..', 'data', 'certs');
const LAN_PORT = 3443;

export function hasOpenSsl() {
  const probe = spawnSync('openssl', ['version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return !probe.error && probe.status === 0;
}

export function getLanIpv4Addresses() {
  const ifaces = os.networkInterfaces();
  const ips = new Set();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal && entry.address) {
        ips.add(entry.address);
      }
    }
  }
  return [...ips];
}

export function buildSanEntries() {
  const dnsNames = new Set(['localhost']);
  const ipAddrs = new Set(['127.0.0.1', '::1']);

  const hostname = os.hostname().trim();
  if (hostname) {
    if (net.isIP(hostname) !== 0) {
      ipAddrs.add(hostname);
    } else if (!/[\s,]/.test(hostname)) {
      dnsNames.add(hostname);
    }
  }

  const lanIps = getLanIpv4Addresses();
  for (const ip of lanIps) {
    ipAddrs.add(ip);
  }

  const sanEntries = [
    ...[...dnsNames].map((name) => `DNS:${name}`),
    ...[...ipAddrs].map((ip) => `IP:${ip}`),
  ];

  return { sanEntries, lanIps, hostname };
}

export function makeCert(dir = DEFAULT_CERT_DIR) {
  const targetDir = path.resolve(dir);
  fs.mkdirSync(targetDir, { recursive: true });

  const certPath = path.join(targetDir, 'alice.crt');
  const keyPath = path.join(targetDir, 'alice.key');
  const { sanEntries, lanIps, hostname } = buildSanEntries();
  const sanValue = sanEntries.join(',');

  // Pre-create key with mode 0600 so it is never world-readable.
  fs.writeFileSync(keyPath, '', { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);

  const args = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '7',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-subj',
    '/CN=Alice Local Dev',
    '-addext',
    `subjectAltName=${sanValue}`,
  ];

  const result = spawnSync('openssl', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    fs.rmSync(keyPath, { force: true });
    if (result.error.code === 'ENOENT') {
      const err = new Error('openssl was not found on PATH');
      err.code = 'ENOENT';
      throw err;
    }
    throw result.error;
  }

  if (result.status !== 0) {
    fs.rmSync(keyPath, { force: true });
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`openssl exited with code ${result.status}${detail ? `: ${detail}` : ''}`);
  }

  fs.chmodSync(keyPath, 0o600);

  return {
    certPath,
    keyPath,
    sanEntries,
    lanIps,
    hostname,
  };
}

if (import.meta.main) {
  try {
    const { certPath, keyPath, lanIps, hostname } = makeCert(DEFAULT_CERT_DIR);

    console.log('Generated self-signed TLS certificate (valid 7 days):');
    console.log(`  cert: ${certPath}`);
    console.log(`  key:  ${keyPath} (mode 0600)`);
    console.log('');

    if (lanIps.length > 0) {
      console.log('Open Alice from another device on the same network:');
      for (const ip of lanIps) {
        console.log(`  https://${ip}:${LAN_PORT}`);
      }
    } else {
      console.log('No non-internal IPv4 LAN address detected. Local URLs:');
      console.log(`  https://localhost:${LAN_PORT}`);
      if (hostname && hostname !== 'localhost') {
        console.log(`  https://${hostname}:${LAN_PORT}`);
      }
    }

    console.log('');
    console.log(
      'Note: Your browser will show a self-signed certificate warning the first time — click through once (e.g. Advanced -> Proceed) to enable camera & microphone.',
    );
    console.log(
      'Reminder: Set ALICE_PASSCODE in .env.local before starting the LAN server (npm run start:lan) so /api/token is not open to the network.',
    );
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.error('Error: openssl is not installed or not on your PATH.');
      console.error('Install it and try again:');
      console.error('  macOS (Homebrew): brew install openssl');
      console.error('  Debian / Ubuntu:  sudo apt-get install -y openssl');
      console.error('  Fedora / RHEL:    sudo dnf install -y openssl');
      console.error('  Windows (winget): winget install ShiningLight.OpenSSL.Light');
      process.exit(1);
    }
    console.error(`Error generating certificate: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
