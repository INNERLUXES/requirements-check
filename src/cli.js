// Command line: requirements-check [files...] [--requirements <file>] [--lock <file>] [--config <file>] [options]

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readBounded, readRequirements, LIMITS } from './requirements.js';
import { parseLockFile } from './locks.js';
import { checkInputs, parseConfig, isDevFile, FINDINGS, DEFAULTS } from './check.js';
import { toText, toMarkdown, toJson, toCsv } from './report.js';
import { toSarif } from './sarif.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const FORMATS = { text: toText, markdown: toMarkdown, json: toJson, csv: toCsv, sarif: (r) => toSarif(r, VERSION) };
const THRESHOLDS = ['error', 'warning'];

export const USAGE = `Usage: requirements-check [files...] [--requirements <file>] [--lock <file>] [options]

Checks the dependency files of a Python web application (pip requirements files, uv.lock, poetry.lock)
for supply-chain and reproducibility risks. It reads files only; it never runs pip or Python and opens
no connection.

Options:
  files                   requirements files, uv.lock or poetry.lock files to check
  --requirements <file>   a requirements file, compared with --lock (lock-mismatch)
  --lock <file>           a uv.lock or poetry.lock file, compared with --requirements
  --config <file>         allowed direct references, private packages, development file names,
                          ignore rules (JSON)
  --format <name>         text, markdown, json, csv or sarif (default: text)
  --fail-on <level>       exit with 1 when a finding is at this level or above: error or warning
                          (default: error)
  --want-hashes           report requirements without hashes as warnings, also outside hash-checking mode
  --dev-pattern <glob>    a file name pattern for development requirements files, where unpinned
                          requirements are warnings (may be repeated; adds to the defaults)
  --limit <n>             show at most n findings and packages (default: ${DEFAULTS.limit}); the total is always shown
  --help                  show this text
  --version               show the version

Checks: ${FINDINGS.map((f) => f.id).join(', ')}

Exit codes: 0 no finding at the --fail-on level, 1 such a finding, 2 usage or input error.
`;

function count(value, option, max) {
  if (!/^\d{1,7}$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${option} takes a whole number from 1 to ${max.toLocaleString('en-US')}, not ${value}`);
  return Number(value);
}

export function parseArgs(argv) {
  const o = { files: [], requirements: null, lock: null, config: null, format: 'text', failOn: 'error', wantHashes: false, devPatterns: [], limit: DEFAULTS.limit, help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version' || a === '-v') o.version = true;
    else if (a === '--requirements') o.requirements = next();
    else if (a === '--lock') o.lock = next();
    else if (a === '--config') o.config = next();
    else if (a === '--format') o.format = next();
    else if (a === '--fail-on') o.failOn = next();
    else if (a === '--want-hashes') o.wantHashes = true;
    else if (a === '--dev-pattern') {
      const p = next();
      if (p.length > 200 || /[/\\]/.test(p)) throw new Error('--dev-pattern takes a file name pattern such as "requirements-ci*.txt", without folders');
      o.devPatterns.push(p);
    } else if (a === '--limit') o.limit = count(next(), '--limit', 1_000_000);
    else if (a === '-') throw new Error('reading from standard input is not supported; give a file');
    else if (a.startsWith('-')) throw new Error(`unknown argument ${a}`);
    else o.files.push(a);
  }
  if (!o.help && !o.version) {
    if (!o.files.length && o.requirements === null && o.lock === null) throw new Error('give at least one file: a requirements file, uv.lock or poetry.lock');
    if (!Object.hasOwn(FORMATS, o.format)) throw new Error(`unknown format ${o.format} (text, markdown, json, csv or sarif)`);
    if (!THRESHOLDS.includes(o.failOn)) throw new Error(`--fail-on takes error or warning, not ${o.failOn}`);
    for (const p of [...o.files, o.requirements, o.lock, o.config]) {
      if (p !== null && /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) throw new Error('give local files; the tool never fetches a URL');
    }
  }
  return o;
}

// A positional file is a lock file when it is named uv.lock or poetry.lock or ends in .lock.
function isLockName(path) {
  return /\.lock$/i.test(basename(path));
}

// Reads the inputs and checks them. Throws on an input error.
async function run(o, limits) {
  const config = o.config === null ? parseConfig(null) : parseConfig(parseJsonConfig(await readBounded(o.config, limits), o.config));
  const patterns = [...config.devPatterns, ...o.devPatterns];
  const isDev = (name) => isDevFile(name, patterns);
  const trees = [];
  const locks = [];
  const readTree = (path) => readRequirements(path, { limits, isDev, display: path });
  const readLock = async (path) => ({ file: path, ...parseLockFile(await readBounded(path, limits), path, limits) });
  let pairReq = null;
  let pairLock = null;
  if (o.requirements !== null) {
    pairReq = await readTree(o.requirements);
    trees.push(pairReq);
  }
  if (o.lock !== null) {
    pairLock = await readLock(o.lock);
    locks.push(pairLock);
  }
  for (const f of o.files) {
    if (isLockName(f)) locks.push(await readLock(f));
    else trees.push(await readTree(f));
  }
  const notes = [];
  if ((o.requirements === null) !== (o.lock === null)) notes.push(`lock-mismatch needs both --requirements and --lock; only ${o.lock === null ? '--requirements' : '--lock'} was given`);
  return checkInputs({ requirements: trees, locks, pair: pairReq && pairLock ? { requirements: pairReq, lock: pairLock } : null }, {
    config, wantHashes: o.wantHashes, limit: o.limit, failOn: o.failOn, notes,
    sources: { requirements: trees.map((t) => t.file), locks: locks.map((l) => l.file), config: o.config }
  });
}

function parseJsonConfig(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: not valid JSON (${error.message})`);
  }
}

// Exit code: 0 no finding at the --fail-on level, 1 such a finding, 2 usage or input error.
export async function main(argv, io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }, limits = LIMITS) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (error) {
    io.err(`requirements-check: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    io.out(USAGE);
    return 0;
  }
  if (o.version) {
    io.out(`${VERSION}\n`);
    return 0;
  }
  let report;
  try {
    report = await run(o, limits);
  } catch (error) {
    const message = error.code === 'ENOENT' ? `${error.path}: no such file` : error.message;
    io.err(`requirements-check: ${message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')}\n`);
    return 2;
  }
  io.out(FORMATS[o.format](report));
  return report.gate.pass ? 0 : 1;
}
