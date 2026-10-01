// Shared test helpers: requirements and lock files written inline into a temporary folder that is removed
// after the test.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readRequirements, parseLockFile, checkInputs, parseConfig, isDevFile, LIMITS } from '../src/index.js';

export async function withFiles(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'requirements-check-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), content);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A made-up sha256 digest: 64 hex characters from one repeated character.
export const H = (c = 'a') => `sha256:${c.repeat(64)}`;

// Reads inline requirements files and returns the tree of the first one (or of `main`).
export async function tree(files, { main = Object.keys(files)[0], limits = LIMITS, devPatterns } = {}) {
  return withFiles(files, (dir) => readRequirements(join(dir, main), { limits, display: main, isDev: (n) => isDevFile(n, devPatterns) }));
}

// Checks inline requirements files and lock files in one step.
//   files     { name: text }; names ending in .lock are lock files, the rest requirements files
//   options   config, wantHashes, pair: [requirements name, lock name], devPatterns, limit, failOn
export async function check(files, { config = null, pair = null, devPatterns, ...options } = {}) {
  return withFiles(files, async (dir) => {
    const cfg = parseConfig(config);
    const patterns = devPatterns ?? cfg.devPatterns;
    const trees = [];
    const locks = [];
    const byName = {};
    for (const [name, text] of Object.entries(files)) {
      if (name.includes('/') && !name.endsWith('.lock')) continue; // included files are read through their parent
      if (name.endsWith('.lock')) {
        const lock = { file: name, ...parseLockFile(text, name) };
        locks.push(lock);
        byName[name] = lock;
      } else if (!options.only || options.only.includes(name)) {
        const t = await readRequirements(join(dir, name), { display: name, isDev: (n) => isDevFile(n, patterns) });
        trees.push(t);
        byName[name] = t;
      }
    }
    delete options.only;
    return checkInputs({ requirements: trees, locks, pair: pair ? { requirements: byName[pair[0]], lock: byName[pair[1]] } : null }, { config: cfg, ...options });
  });
}

export const ids = (report) => report.findings.map((f) => f.id);
export const find = (report, id) => report.findings.filter((f) => f.id === id);
