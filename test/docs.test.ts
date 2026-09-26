import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, test } from 'node:test';

const LEGAL =
  'KE Credits is software, not a payment processor, money transmitter, bank or stored-value issuer. It holds no funds. It records closed-loop, non-cash credits for an operator\'s own services. Operators are responsible for tax, consumer-protection, unclaimed-property, prepaid-access and PCI compliance.';

const REQUIRED = [
  'README.md',
  'NOTICE',
  'docs/GUIDE.md',
  'docs/SECURITY-MODEL.md',
  'examples/nextjs-route.ts',
  'examples/express.ts',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  '.github/workflows/ci.yml',
];

const JS_CALLEES = new Set([
  'Array',
  'BigInt',
  'Boolean',
  'Buffer',
  'Date',
  'Error',
  'Function',
  'Headers',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'RegExp',
  'Request',
  'Response',
  'Set',
  'String',
  'Symbol',
  'TextDecoder',
  'TextEncoder',
  'URL',
  'Uint8Array',
  'async',
  'await',
  'catch',
  'clearInterval',
  'clearTimeout',
  'console',
  'constructor',
  'decodeURIComponent',
  'encodeURIComponent',
  'fetch',
  'if',
  'isFinite',
  'isNaN',
  'json',
  'listen',
  'parseFloat',
  'parseInt',
  'post',
  'process',
  'raw',
  'require',
  'setInterval',
  'setTimeout',
  'status',
  'text',
  'then',
  'throw',
  'typeof',
  'use',
]);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function specApiNames(spec: string): Set<string> {
  const names = new Set<string>();
  const start = spec.indexOf('## Public API');
  assert.ok(start >= 0, 'docs/API.md is missing the Public API section');
  const api = spec.slice(start);
  const patterns = [
    /export const (\w+)/g,
    /export async function (\w+)/g,
    /export function (\w+)/g,
    /export type (\w+)/g,
    /export class (\w+)/g,
    /export interface (\w+)/g,
  ];
  for (const re of patterns) {
    for (const m of api.matchAll(re)) names.add(m[1]);
  }
  for (const m of api.matchAll(/^\s{2}(\w+)\s*\(/gm)) names.add(m[1]);
  for (const m of spec.matchAll(/export interface (\w+)/g)) names.add(m[1]);
  for (const name of [
    'InsufficientCredits',
    'AccountSuspended',
    'IdempotencyConflict',
    'Sql',
    'Db',
    'KE_CREDITS_ALLOW_LIVE',
  ]) {
    if (spec.includes(name)) names.add(name);
  }
  return names;
}

function importsFromKeCredits(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(
    /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]ke-credits['"]/g,
  )) {
    for (const part of m[1].split(',')) {
      const ident = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      if (ident) names.push(ident);
    }
  }
  return names;
}

function callNames(source: string): string[] {
  const names: string[] = [];
  const fences = [...source.matchAll(/```(?:ts|typescript|js|javascript)?\n([\s\S]*?)```/gi)].map(
    (m) => m[1],
  );
  const bodies = fences.length ? fences : [source];
  for (const body of bodies) {
    for (const m of body.matchAll(/\bnew\s+([A-Z][A-Za-z0-9]*)\s*\(/g)) names.push(m[1]);
    for (const m of body.matchAll(/\b(?:ledger|holds)\.(\w+)\s*\(/gi)) names.push(m[1]);
    for (const m of body.matchAll(/(?:^|[^\w.])([A-Za-z_][A-Za-z0-9]*)\s*\(/gm)) {
      const n = m[1];
      if (!JS_CALLEES.has(n)) names.push(n);
    }
  }
  return names;
}

describe('docs', () => {
  test('required files exist', () => {
    for (const file of REQUIRED) {
      assert.ok(existsSync(file), `missing ${file}`);
      assert.ok(statSync(file).size > 0, `empty ${file}`);
    }
  });

  test('NOTICE contains the legal line', () => {
    const notice = read('NOTICE');
    assert.ok(notice.includes(LEGAL), 'NOTICE is missing the legal line from docs/API.md');
  });

  test('README mentions only API names listed in docs/API.md', () => {
    const spec = read('docs/API.md');
    const readme = read('README.md');
    const allowed = specApiNames(spec);
    const imported = importsFromKeCredits(readme);
    assert.ok(imported.length > 0, 'README quickstart should import from ke-credits');
    const extras = imported.filter((n) => !allowed.has(n) && !spec.includes(n));
    assert.equal(extras.length, 0, `README imports names missing from API.md: ${extras.join(', ')}`);

    const called = callNames(readme);
    const unknown = [...new Set(called)].filter((n) => {
      if (JS_CALLEES.has(n)) return false;
      if (allowed.has(n)) return false;
      if (spec.includes(n)) return false;
      if (n === n.toLowerCase() && n.length < 4) return false;
      return /^[A-Z]/.test(n) || /[A-Z]/.test(n.slice(1));
    });
    assert.equal(
      unknown.length,
      0,
      `README mentions API names missing from API.md: ${unknown.join(', ')}`,
    );
  });

  test('README includes the legal notice', () => {
    assert.ok(read('README.md').includes(LEGAL));
  });

  test('examples import only API.md names', () => {
    const spec = read('docs/API.md');
    const allowed = specApiNames(spec);
    for (const file of ['examples/nextjs-route.ts', 'examples/express.ts']) {
      const src = read(file);
      const imported = importsFromKeCredits(src);
      assert.ok(imported.length > 0, `${file} should import from ke-credits`);
      const extras = imported.filter((n) => !allowed.has(n) && !spec.includes(n));
      assert.equal(extras.length, 0, `${file} imports names missing from API.md: ${extras.join(', ')}`);
    }
  });

  test('GUIDE points at the examples', () => {
    const guide = read('docs/GUIDE.md');
    assert.ok(guide.includes('examples/nextjs-route.ts'));
    assert.ok(guide.includes('examples/express.ts'));
  });

  test('CI runs on Node 20, 22, and 24', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const version of ['20', '22', '24']) {
      assert.match(ci, new RegExp(`\\b${version}\\b`), `ci.yml missing Node ${version}`);
    }
  });

  test('examples verify the Stripe signature on the raw body', () => {
    const next = read('examples/nextjs-route.ts');
    const express = read('examples/express.ts');

    assert.match(next, /async function POST\(\s*req:\s*Request\s*\)/, 'Next.js handler must be POST(req: Request)');
    assert.equal(
      /function POST\(\s*req:\s*Request\s*,/.test(next),
      false,
      'Next.js POST must not take db as a second argument (App Router passes route context there)',
    );
    assert.match(next, /req\.text\(\)/, 'Next.js example must read the raw body with req.text()');
    assert.match(next, /verifyStripeSignature/);
    assert.match(next, /handleStripeEvent/);
    assert.match(next, /status:\s*400/, 'Next.js example should reject a bad signature with 400');

    assert.match(express, /express\.raw\(\s*\{\s*type:\s*['"]application\/json['"]\s*\}\s*\)/);
    assert.match(express, /Buffer\.isBuffer/);
    assert.match(express, /verifyStripeSignature/);
    assert.match(express, /handleStripeEvent/);
    assert.match(express, /status\(400\)/, 'Express example should reject a bad signature with 400');
  });
});
