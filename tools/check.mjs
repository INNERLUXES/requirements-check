// Repository checks that run in CI next to the tests.
//   1. every JavaScript file parses
//   2. every module in src is exported from src/index.js and named in a test
//   3. nothing that looks like a credential is committed
//   4. source files stay free of leftovers (debugger, focused tests, conflict markers)

import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const SKIP = new Set(['node_modules', '.git', 'coverage', 'dist']);
const problems = [];

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = await walk(root);
const rel = (f) => relative(root, f).split(sep).join('/');
const code = files.filter((f) => /\.(js|mjs)$/.test(f));

for (const file of code) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) problems.push(`${rel(file)}: does not parse\n${result.stderr.trim().split('\n').slice(0, 4).join('\n')}`);
}

const index = await readFile(join(root, 'src', 'index.js'), 'utf8');
const tests = (await Promise.all(files.filter((f) => rel(f).startsWith('test/')).map((f) => readFile(f, 'utf8')))).join('\n');
for (const file of code.filter((f) => rel(f).startsWith('src/') && rel(f) !== 'src/index.js')) {
  const path = `./${rel(file).slice('src/'.length)}`;
  if (!index.includes(`'${path}'`)) problems.push(`${rel(file)}: not exported from src/index.js`);
  const source = await readFile(file, 'utf8');
  const names = [...source.matchAll(/^export (?:async )?(?:function\*?|class|const) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
  const used = names.filter((n) => new RegExp(`\\b${n}\\b`).test(tests));
  if (names.length && used.length === 0) problems.push(`${rel(file)}: none of its exports appears in a test`);
}

const SECRET = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /(?:api[_-]?key|client[_-]?secret|password)\s*[:=]\s*['"][^'"\s]{12,}['"]/i
];
const LEFTOVER = [/^\s*debugger;?\s*$/m, /\b(?:test|describe|it)\.only\(/, /^(?:<<<<<<<|>>>>>>>) /m];

for (const file of files) {
  if (/\.(png|jpg|jpeg|webp|ico|woff2?)$/.test(file)) continue;
  const text = await readFile(file, 'utf8');
  if (rel(file) !== 'tools/check.mjs') {
    for (const pattern of SECRET) if (pattern.test(text)) problems.push(`${rel(file)}: looks like a credential`);
    if (/\.(js|mjs)$/.test(file)) for (const pattern of LEFTOVER) if (pattern.test(text)) problems.push(`${rel(file)}: leftover (${pattern.source})`);
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`checked ${files.length} files, ${code.length} scripts: no problems`);
