// Reads uv.lock and poetry.lock into one list of locked packages:
//   { name, normalized, version, source: { kind, url }, hashes, line }
// where kind is registry, git, url, path, editable or project (the project itself).
// Both files are TOML; src/toml.js reads them. Nothing in them is fetched or run.

import { basename } from 'node:path';
import { parseToml, tableLine } from './toml.js';
import { normalizeName } from './names.js';
import { LIMITS } from './requirements.js';

export const LOCK_KINDS = ['uv', 'poetry'];
export const PYPI_INDEX = 'https://pypi.org/simple';

const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : null);

// Which lock format a file holds: by its name first, then by what is in it.
export function lockKind(path, data) {
  const name = basename(String(path)).toLowerCase();
  if (name === 'uv.lock') return 'uv';
  if (name === 'poetry.lock') return 'poetry';
  if (isTable(data.metadata) && (Object.hasOwn(data.metadata, 'lock-version') || Object.hasOwn(data.metadata, 'content-hash'))) return 'poetry';
  if (typeof data.version === 'number' && Array.isArray(data.package)) return 'uv';
  return null;
}

function hashesFrom(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const f of list) if (isTable(f) && typeof f.hash === 'string') out.push(f.hash);
  return out;
}

function packageList(data, label) {
  if (data.package === undefined) return [];
  if (!Array.isArray(data.package) || data.package.some((p) => !isTable(p))) throw new Error(`${label}: "package" must be an array of tables ([[package]])`);
  return data.package;
}

function checkCount(list, label, limits) {
  if (list.length > limits.maxRequirements) {
    throw new Error(`${label}: ${list.length.toLocaleString('en-US')} locked packages is over the limit of ${limits.maxRequirements.toLocaleString('en-US')}`);
  }
}

// uv.lock: [[package]] tables with name, version, source = { registry | git | url | path | directory | editable | virtual },
// and the hashes of sdist and wheels.
function fromUv(data, label, limits) {
  const list = packageList(data, label);
  checkCount(list, label, limits);
  return list.map((p, i) => {
    const name = text(p.name);
    if (!name) throw new Error(`${label}: package ${i + 1} has no name`);
    const s = isTable(p.source) ? p.source : {};
    let source;
    if (text(s.registry)) source = { kind: 'registry', url: s.registry };
    else if (text(s.git)) source = { kind: 'git', url: `git+${s.git}` };
    else if (text(s.url)) source = { kind: 'url', url: s.url };
    else if (text(s.editable)) source = { kind: s.editable === '.' ? 'project' : 'editable', url: s.editable };
    else if (text(s.virtual)) source = { kind: s.virtual === '.' ? 'project' : 'path', url: s.virtual };
    else if (text(s.path) || text(s.directory)) source = { kind: 'path', url: s.path ?? s.directory };
    else source = { kind: 'unknown', url: null };
    const hashes = [...hashesFrom(isTable(p.sdist) ? [p.sdist] : []), ...hashesFrom(p.wheels)];
    return { name, normalized: normalizeName(name), version: text(p.version), source, hashes, line: tableLine(p) ?? 1 };
  });
}

// poetry.lock: [[package]] tables with name, version, files = [{ file, hash }] and an optional [package.source]
// (type legacy = another index, git, url, file, directory). No source means PyPI.
// Older files keep the hashes in [metadata.files], by name.
function fromPoetry(data, label, limits) {
  const list = packageList(data, label);
  checkCount(list, label, limits);
  const legacyFiles = isTable(data.metadata) && isTable(data.metadata.files) ? data.metadata.files : {};
  return list.map((p, i) => {
    const name = text(p.name);
    if (!name) throw new Error(`${label}: package ${i + 1} has no name`);
    const s = isTable(p.source) ? p.source : null;
    let source = { kind: 'registry', url: PYPI_INDEX };
    if (s) {
      const type = text(s.type);
      const url = text(s.url);
      if (type === 'legacy' || type === null) source = { kind: 'registry', url: url ?? PYPI_INDEX };
      else if (type === 'git') source = { kind: 'git', url: `git+${url ?? ''}${text(s.resolved_reference) ? `@${s.resolved_reference}` : text(s.reference) ? `@${s.reference}` : ''}` };
      else if (type === 'url') source = { kind: 'url', url };
      else if (type === 'file' || type === 'directory') source = { kind: p.develop === true ? 'editable' : 'path', url };
      else source = { kind: 'unknown', url };
    }
    let hashes = hashesFrom(p.files);
    if (!hashes.length) {
      const key = Object.keys(legacyFiles).find((k) => normalizeName(k) === normalizeName(name));
      if (key) hashes = hashesFrom(legacyFiles[key]);
    }
    return { name, normalized: normalizeName(name), version: text(p.version), source, hashes, line: tableLine(p) ?? 1 };
  });
}

// A lock file's text as { kind, packages }.
export function parseLockFile(source, path, limits = LIMITS) {
  const data = parseToml(source, path);
  const kind = lockKind(path, data);
  if (kind === null) throw new Error(`${path}: not a uv.lock or poetry.lock file (name it uv.lock or poetry.lock, or check its contents)`);
  const packages = kind === 'uv' ? fromUv(data, path, limits) : fromPoetry(data, path, limits);
  return { kind, packages };
}
