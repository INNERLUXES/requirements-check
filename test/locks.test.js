import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseLockFile, lockKind, LOCK_KINDS, PYPI_INDEX, LIMITS } from '../src/index.js';
import { H } from './helpers.js';

const root = join(fileURLToPath(import.meta.url), '..', '..');

const UV = `version = 1
requires-python = ">=3.12"

[[package]]
name = "example-app"
version = "0.1.0"
source = { editable = "." }

[[package]]
name = "Example_Web"
version = "3.0.3"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.example.org/w.tar.gz", hash = "${H('a')}", size = 100 }
wheels = [
    { url = "https://files.example.org/w.whl", hash = "${H('b')}", size = 90 },
]

[[package]]
name = "example-pdf"
version = "1.3.0"
source = { git = "https://git.example.org/pdf.git?rev=v1.3.0#0123abcd" }

[[package]]
name = "example-tool"
version = "0.4.1"
source = { url = "http://files.example.org/example_tool-0.4.1.tar.gz" }
sdist = { hash = "md5:${'c'.repeat(32)}" }

[[package]]
name = "example-lib"
version = "0.2.0"
source = { directory = "libs/example-lib" }

[[package]]
name = "example-sub"
version = "0.3.0"
source = { editable = "packages/sub" }
`;

const POETRY = `[[package]]
name = "example-web"
version = "3.0.3"
description = ""
optional = false
python-versions = ">=3.8"
files = [
    {file = "example_web-3.0.3-py3-none-any.whl", hash = "${H('a')}"},
]

[[package]]
name = "example-private"
version = "1.0.0"
files = []

[package.source]
type = "legacy"
url = "https://pypi.example.internal/simple"
reference = "internal"

[[package]]
name = "example-pdf"
version = "1.3.0"
files = []

[package.source]
type = "git"
url = "https://git.example.org/pdf.git"
reference = "main"
resolved_reference = "0123abcd"

[[package]]
name = "example-local"
version = "0.1.0"
develop = true

[package.source]
type = "directory"
url = "../example-local"

[[package]]
name = "example-old"
version = "2.0.0"

[metadata]
lock-version = "1.1"
content-hash = "abc"

[metadata.files]
example_old = [
    {file = "example_old-2.0.0.tar.gz", hash = "${H('d')}"},
]
`;

test('uv.lock: name, version, every source kind, sdist and wheel hashes, and the line of each package', () => {
  const lock = parseLockFile(UV, 'uv.lock');
  assert.equal(lock.kind, 'uv');
  assert.deepEqual(lock.packages.map((p) => [p.name, p.normalized, p.source.kind, p.line]), [
    ['example-app', 'example-app', 'project', 4],
    ['Example_Web', 'example-web', 'registry', 9],
    ['example-pdf', 'example-pdf', 'git', 18],
    ['example-tool', 'example-tool', 'url', 23],
    ['example-lib', 'example-lib', 'path', 29],
    ['example-sub', 'example-sub', 'editable', 34]
  ]);
  assert.deepEqual(lock.packages[1].hashes, [H('a'), H('b')]);
  assert.equal(lock.packages[2].source.url, 'git+https://git.example.org/pdf.git?rev=v1.3.0#0123abcd');
  assert.deepEqual(lock.packages[3].hashes, [`md5:${'c'.repeat(32)}`]);
  assert.equal(lock.packages[1].source.url, PYPI_INDEX);
});

test('poetry.lock: PyPI by default, another index, git with the resolved commit, local folders and old [metadata.files]', () => {
  const lock = parseLockFile(POETRY, 'poetry.lock');
  assert.equal(lock.kind, 'poetry');
  assert.deepEqual(lock.packages.map((p) => [p.name, p.source.kind, p.source.url]), [
    ['example-web', 'registry', PYPI_INDEX],
    ['example-private', 'registry', 'https://pypi.example.internal/simple'],
    ['example-pdf', 'git', 'git+https://git.example.org/pdf.git@0123abcd'],
    ['example-local', 'editable', '../example-local'],
    ['example-old', 'registry', PYPI_INDEX]
  ]);
  assert.deepEqual(lock.packages.map((p) => p.hashes.length), [1, 0, 0, 0, 1]);
  assert.deepEqual(lock.packages[4].hashes, [H('d')]);
});

test('lockKind goes by the file name, then by the contents; anything else is refused', () => {
  assert.deepEqual(LOCK_KINDS, ['uv', 'poetry']);
  assert.equal(lockKind('dir/uv.lock', {}), 'uv');
  assert.equal(lockKind('POETRY.LOCK', {}), 'poetry');
  assert.equal(lockKind('other.lock', { metadata: { 'content-hash': 'x' } }), 'poetry');
  assert.equal(lockKind('other.lock', { version: 1, package: [] }), 'uv');
  assert.equal(lockKind('other.lock', { version: '1' }), null);
  assert.throws(() => parseLockFile('a = 1\n', 'Pipfile.lock'), /Pipfile\.lock: not a uv\.lock or poetry\.lock file/);
  assert.throws(() => parseLockFile('package = 1\n', 'uv.lock'), /"package" must be an array of tables/);
  assert.throws(() => parseLockFile('[[package]]\nversion = "1"\n', 'uv.lock'), /package 1 has no name/);
  assert.throws(() => parseLockFile('version = 1\nwhen = 0000-00-00\n', 'uv.lock'), /uv\.lock: line 2: dates and times/);
});

test('a lock file with more packages than the limit stops the run', () => {
  const text = Array.from({ length: 12 }, (_, i) => `[[package]]\nname = "example-p${i}"\nversion = "1.0"\n`).join('\n');
  assert.throws(() => parseLockFile(text, 'uv.lock', { ...LIMITS, maxRequirements: 10 }), /12 locked packages is over the limit of 10/);
  assert.equal(parseLockFile(text, 'uv.lock').packages.length, 12);
});

test('the example lock files: seven uv packages including the project, six Poetry packages, all hashed', async () => {
  const uv = parseLockFile(await readFile(join(root, 'examples', 'uv.lock'), 'utf8'), 'examples/uv.lock');
  assert.equal(uv.packages.length, 7);
  assert.deepEqual(uv.packages.filter((p) => p.source.kind === 'project').map((p) => p.name), ['example-orders-service']);
  assert.ok(uv.packages.filter((p) => p.source.kind === 'registry').every((p) => p.hashes.length === 2));
  const poetry = parseLockFile(await readFile(join(root, 'examples', 'poetry.lock'), 'utf8'), 'examples/poetry.lock');
  assert.equal(poetry.packages.length, 6);
  assert.equal(poetry.packages.find((p) => p.name === 'example-web-framework').version, '3.0.2');
});
