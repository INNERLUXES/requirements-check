// Checks the dependency files of a Python web application for supply-chain and reproducibility risks.
// docs/method.md gives the reason behind every check.

import { satisfies, specifierText, normalizeName } from './names.js';
import { isInsecureUrl } from './requirements.js';
import { PYPI_INDEX } from './locks.js';

export const SEVERITIES = ['error', 'warning', 'info'];
export const RANK = { error: 0, warning: 1, info: 2 };
export const DEFAULTS = {
  limit: 200,
  devPatterns: ['requirements-dev*', 'requirements_dev*', 'dev-requirements*', 'requirements-test*', 'requirements_test*', 'test-requirements*', '*-dev.txt', '*.in']
};
const WEAK_HASHES = ['md5', 'sha1'];
const weakNames = (list) => list.map((a) => (a === 'md5' ? 'MD5' : 'SHA-1')).join(' and ');

export const FINDINGS = [
  { id: 'non-index-source', severity: 'error', what: 'A package comes from a direct reference (git or another version control system, an archive URL, a local path, an editable install), not from a package index' },
  { id: 'insecure-url', severity: 'error / warning', what: 'An index, find-links location or direct reference uses plain http:// (error), or a host is marked as trusted, which turns off certificate checks for it (warning)' },
  { id: 'unpinned', severity: 'error / warning', what: 'A requirement has no exact == or === pin; an error in files meant for deployment, a warning in development files' },
  { id: 'missing-hash', severity: 'error / warning', what: 'A requirement or locked package has no hash while hash checking is in effect (error), or when --want-hashes asks for hashes (warning)' },
  { id: 'duplicate-requirement', severity: 'error', what: 'The same package is listed twice with different pins, across the file and the files it includes' },
  { id: 'conflicting-constraint', severity: 'error', what: 'A requirement and a -c constraint for the same package cannot both hold' },
  { id: 'lock-mismatch', severity: 'error', what: 'A top-level requirement is missing from the lock file, or locked at a version outside its specifier' },
  { id: 'extra-index', severity: 'warning / error', what: 'More than one index is in use, which allows dependency confusion; an error for a private package that is not tied to one file by a hash or comes from the public index' },
  { id: 'weak-hash', severity: 'warning', what: 'A hash uses md5 or sha1' },
  { id: 'marker-note', severity: 'info', what: 'A requirement is limited by an environment marker, so it is installed only on some systems or Python versions' }
];

const ORDER = Object.fromEntries(FINDINGS.map((f, i) => [f.id, i]));

export function isFindingId(id) {
  return Object.hasOwn(ORDER, id);
}

// User and password in a URL ("https://user:token@host/...") are replaced by ***, so a token in a
// requirements or lock file never reaches a report. The plain user name "git" of git+ssh addresses is kept.
export function maskCredentials(value) {
  return String(value).replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, (all, scheme, user) => (user === 'git' ? all : `${scheme}***@`));
}

// Text from the input: credentials masked, control and direction characters removed and length capped.
export function safeText(value, max = 300) {
  const s = maskCredentials(String(value).replace(/[\u0000-\u001f\u007f-\u009f\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, ' '));
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

export function meetsThreshold(severity, failOn) {
  return RANK[severity] <= RANK[failOn];
}

function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

// A glob with * (any run of characters) and ? (one character), matched against the whole text, ignoring case.
export function globMatch(pattern, value) {
  let re = '';
  for (const c of String(pattern)) {
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i').test(String(value));
}

// A requirements file meant for development, by its file name: requirements-dev.txt, test-requirements.txt, *.in.
export function isDevFile(name, patterns = DEFAULTS.devPatterns) {
  return patterns.some((p) => globMatch(p, name));
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function stringList(value, key, what) {
  if (!Array.isArray(value) || value.some((n) => typeof n !== 'string' || n.trim() === '' || n.length > 500)) throw new Error(`config: "${key}" must be a list of ${what}`);
  return value.map((n) => n.trim());
}

// The config file, checked. Unknown keys stop the run, so a typo cannot switch a check off without notice.
export function parseConfig(config) {
  const out = { allowDirect: [], privatePackages: [], devPatterns: [...DEFAULTS.devPatterns], ignore: [] };
  if (config === null || config === undefined) return out;
  if (!isObject(config)) throw new Error('config: expected an object');
  const known = ['allowDirect', 'privatePackages', 'devPatterns', 'ignore'];
  for (const k of Object.keys(config)) if (!known.includes(k)) throw new Error(`config: unknown key "${safeText(k, 60)}" (expected ${known.join(', ')})`);
  if (config.allowDirect !== undefined) {
    out.allowDirect = stringList(config.allowDirect, 'allowDirect', 'URL or path prefixes');
    for (const p of out.allowDirect) {
      if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(p)) throw new Error(`config: "allowDirect" holds ${safeText(JSON.stringify(p), 80)}; leave credentials out of the config`);
      if (/^[a-z][a-z0-9+.-]*:\/\/[^/]+$/i.test(p)) throw new Error(`config: "allowDirect" holds ${safeText(JSON.stringify(p), 80)}; end a URL prefix with "/" so another host cannot match it`);
    }
  }
  if (config.privatePackages !== undefined) out.privatePackages = stringList(config.privatePackages, 'privatePackages', 'package names or patterns with *').map(normalizeName);
  if (config.devPatterns !== undefined) out.devPatterns = stringList(config.devPatterns, 'devPatterns', 'file name patterns with *');
  if (config.ignore !== undefined) {
    if (!Array.isArray(config.ignore)) throw new Error('config: "ignore" must be a list of { "check", "package" } objects');
    out.ignore = config.ignore.map((rule, i) => {
      if (!isObject(rule)) throw new Error(`config: ignore[${i}] must be an object`);
      for (const k of Object.keys(rule)) if (!['check', 'package', 'reason'].includes(k)) throw new Error(`config: unknown key "${safeText(k, 60)}" in ignore[${i}] (expected check, package, reason)`);
      if (rule.check === undefined && rule.package === undefined) throw new Error(`config: ignore[${i}] needs a "check", a "package" or both`);
      if (rule.check !== undefined && !isFindingId(rule.check)) throw new Error(`config: ignore[${i}] names the unknown check ${safeText(JSON.stringify(rule.check), 60)}`);
      if (rule.package !== undefined && (typeof rule.package !== 'string' || !rule.package.trim())) throw new Error(`config: ignore[${i}].package must be a package name`);
      return { check: rule.check ?? null, package: rule.package === undefined ? null : normalizeName(rule.package.trim()) };
    });
  }
  return out;
}

const algorithms = (hashes) => [...new Set(hashes.map((h) => h.split(':')[0].toLowerCase()))];
const stripCredentials = (url) => String(url).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/i, '$1');

function allowedDirect(url, cfg) {
  const plain = stripCredentials(url).toLowerCase();
  return cfg.allowDirect.some((p) => plain.startsWith(p.toLowerCase()));
}

function isPrivate(normalized, cfg) {
  return normalized !== null && cfg.privatePackages.some((p) => globMatch(p, normalized));
}

const KIND_TEXT = {
  vcs: 'a version control repository',
  git: 'a git repository',
  url: 'an archive URL',
  path: 'a local path'
};

// Checks parsed inputs.
//   inputs   { requirements: [trees from readRequirements], locks: [{ file, kind, packages }], pair: { requirements, lock } | null }
//   options  config (from parseConfig), wantHashes, limit, failOn, notes, sources
export function checkInputs(inputs, options = {}) {
  const o = { config: parseConfig(null), wantHashes: false, limit: DEFAULTS.limit, failOn: 'error', notes: [], sources: null, ...options };
  const cfg = o.config;
  const show = (t) => safeText(t, 300);
  const all = [];
  const notes = [...o.notes];
  const packages = [];
  const add = (id, severity, at, message) => all.push({
    id, severity,
    package: at.name ?? null,
    normalized: at.normalized ?? (at.name ? normalizeName(at.name) : null),
    version: at.version ?? null,
    file: at.file ?? null,
    line: at.line ?? 1,
    message: safeText(message, 1200)
  });
  const trees = inputs.requirements || [];
  const locks = inputs.locks || [];

  for (const tree of trees) {
    const reqs = tree.requirements;
    // pip turns hash-checking mode on for --require-hashes or any --hash option; a #sha256= URL fragment alone does not.
    const hashMode = tree.requireHashes || reqs.some((r) => r.hashOptions > 0);
    const why = tree.requireHashes ? '--require-hashes is set' : 'other requirements have hashes, which turns on pip\'s hash-checking mode';
    const extras = tree.options.filter((x) => x.name === 'extra-index-url');
    const index = tree.options.find((x) => x.name === 'index-url');

    for (const r of reqs) {
      const label = r.name === null ? show(r.url) : show(r.name);
      const at = { name: r.name, normalized: r.normalized, version: r.pin, file: r.file, line: r.line };
      packages.push({
        name: r.name === null ? null : show(r.name),
        version: r.pin === null ? (r.specifier ? show(r.specifier) : null) : show(r.pin),
        source: r.url === null ? (index ? show(index.value) : 'index') : show(r.url),
        hashes: r.hashes.length,
        algorithms: algorithms(r.hashes),
        file: show(r.file),
        line: r.line,
        kind: r.editable ? 'editable' : r.url === null ? 'requirement' : 'direct',
        pinned: r.pin !== null
      });

      if (r.url !== null) {
        if (!allowedDirect(r.url, cfg)) {
          const from = r.editable
            ? `is installed in editable mode from ${show(r.url)}: pip runs the build of whatever that ${r.refKind === 'path' ? 'folder' : 'location'} holds when it installs it`
            : `comes from ${KIND_TEXT[r.refKind]} (${show(r.url)}), not from a package index: ${r.refKind === 'vcs' ? 'a branch or tag can be moved, and there is no index hash' : r.refKind === 'url' ? 'the server can send a different file tomorrow' : 'a build on another machine gets whatever is at that path, or fails'}`;
          add('non-index-source', 'error', at, `${label} ${from}. Publish it to your index and pin it, or add the prefix to "allowDirect" in the config when it is trusted`);
        }
        if (isInsecureUrl(r.url)) add('insecure-url', 'error', at, `${label} is fetched over an unencrypted connection (${show(r.url)}); anyone on the network path can change what is installed. Use https`);
      } else if (r.pin === null) {
        const sev = r.dev ? 'warning' : 'error';
        add('unpinned', sev, at, `${label} has no exact pin (${r.specifier ? `"${show(r.specifier)}"` : 'any version'}): pip installs the newest version that matches on the day of the build, so two builds of the same commit can differ. Pin it with ==${r.dev ? ' (a warning here, since the file is for development)' : ''}`);
      }

      if (!r.hashes.length && !r.editable) {
        if (hashMode) add('missing-hash', 'error', at, `${label} has no --hash, but ${why}: pip refuses to install the file. Add the hashes of every file it may install (pip-compile --generate-hashes writes them)`);
        else if (o.wantHashes) add('missing-hash', 'warning', at, `${label} has no --hash, so pip cannot check that the file it downloads is the one that was reviewed. Add hashes and --require-hashes`);
      }
      const weak = algorithms(r.hashes).filter((a) => WEAK_HASHES.includes(a));
      if (weak.length) add('weak-hash', 'warning', at, `${label} has a hash made with ${weakNames(weak)}, which can be forged (pip refuses such hashes in --hash); use sha256`);
      if (extras.length && isPrivate(r.normalized, cfg) && !r.hashes.length && r.url === null) {
        add('extra-index', 'error', at, `${label} is a private package (see "privatePackages" in the config), but the file reads more than one index and does not tie it to one file by a hash: pip takes the highest version from any index, so a package of the same name on the public index wins. Add --hash, or install private packages from one index only`);
      }
      if (r.marker) add('marker-note', 'info', at, `${label} is installed only where ${show(r.marker)}`);
    }

    for (const x of tree.options) {
      const at = { file: x.file, line: x.line };
      const what = { 'index-url': 'the index', 'extra-index-url': 'an extra index', 'find-links': 'a find-links location' }[x.name];
      if (what && isInsecureUrl(x.value)) add('insecure-url', 'error', at, `${what} ${show(x.value)} uses an unencrypted connection; anyone on the network path can change every package from it. Use https`);
      if (x.name === 'trusted-host') add('insecure-url', 'warning', at, `--trusted-host ${show(x.value)} tells pip to accept that host without a valid certificate (or over http). Give the host a valid certificate and remove the option`);
      if (x.name === 'extra-index-url') {
        add('extra-index', 'warning', at, `--extra-index-url ${show(x.value)} adds a second index: pip looks in every index and takes the highest version it finds, so anyone who publishes a private package name on the public index can replace it (dependency confusion). Prefer one index that serves both, or pin and hash every package`);
      }
    }

    for (const inc of tree.remoteIncludes) {
      add('non-index-source', 'error', { file: inc.file, line: inc.line }, `-${inc.kind === 'constraint' ? 'c' : 'r'} ${show(inc.url)} includes a ${inc.kind === 'constraint' ? 'constraints' : 'requirements'} file from a URL, which pip downloads at install time and this tool does not read. Keep the file in the repository`);
      if (isInsecureUrl(inc.url)) add('insecure-url', 'error', { file: inc.file, line: inc.line }, `-${inc.kind === 'constraint' ? 'c' : 'r'} ${show(inc.url)} is fetched over an unencrypted connection. Use https, or better, keep the file in the repository`);
    }

    // The same package twice with different pins (requirements with different markers are for different systems).
    const byName = new Map();
    for (const r of reqs) {
      if (r.normalized === null) continue;
      const key = `${r.normalized}\u0000${(r.marker ?? '').replace(/\s+/g, '')}`;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(r);
    }
    for (const list of byName.values()) {
      const first = list[0];
      const firstKey = first.url ?? specifierText(first.specs);
      for (const r of list.slice(1)) {
        const key = r.url ?? specifierText(r.specs);
        if (key === firstKey) continue;
        const want = (x) => (x.url ? show(x.url) : x.specifier ? `"${show(x.specifier)}"` : 'any version');
        add('duplicate-requirement', 'error', { name: r.name, normalized: r.normalized, version: r.pin, file: r.file, line: r.line }, `${show(r.name)} is listed again with ${want(r)}, after ${want(first)} at ${show(first.file)}:${first.line}; pip refuses the pair or installs one of them, depending on its version. Keep one line`);
      }
    }

    // Requirements against -c constraints.
    for (const c of tree.constraints) {
      if (c.normalized === null || c.url !== null) continue;
      for (const r of reqs.filter((x) => x.normalized === c.normalized && x.url === null)) {
        let clash = null;
        if (r.pin !== null) {
          const s = satisfies(r.pin, c.specs);
          if (s.ok && !s.match) clash = `the pin ==${show(r.pin)} is outside the constraint "${show(c.specifier)}"`;
        } else if (c.pin !== null) {
          const s = satisfies(c.pin, r.specs);
          if (s.ok && !s.match) clash = `the constraint ==${show(c.pin)} is outside the requirement "${show(r.specifier)}"`;
        }
        if (clash) {
          add('conflicting-constraint', 'error', { name: r.name, normalized: r.normalized, version: r.pin, file: r.file, line: r.line }, `${show(r.name)}: ${clash} (${show(c.file)}:${c.line}); pip cannot satisfy both and the install fails. Change one of them`);
        }
      }
    }
  }

  for (const lock of locks) {
    const hashMode = lock.packages.some((p) => p.hashes.length > 0);
    const registries = new Set();
    for (const p of lock.packages) {
      if (p.source.kind === 'project') continue;
      const at = { name: p.name, normalized: p.normalized, version: p.version, file: lock.file, line: p.line };
      const label = `${show(p.name)}${p.version ? ` ${show(p.version)}` : ''}`;
      packages.push({
        name: show(p.name), version: p.version === null ? null : show(p.version), source: p.source.url === null ? p.source.kind : show(p.source.url),
        hashes: p.hashes.length, algorithms: algorithms(p.hashes), file: show(lock.file), line: p.line, kind: 'locked', pinned: p.version !== null
      });
      const url = p.source.url ?? '';
      if (['git', 'url', 'path', 'editable'].includes(p.source.kind) && !allowedDirect(url, cfg)) {
        const what = p.source.kind === 'editable' ? 'an editable local folder' : KIND_TEXT[p.source.kind];
        add('non-index-source', 'error', at, `${label} is locked from ${what} (${show(url)}), not from a package index. Publish it to your index, or add the prefix to "allowDirect" in the config when it is trusted`);
      }
      if (p.source.url && isInsecureUrl(p.source.url)) add('insecure-url', 'error', at, `${label} is fetched over an unencrypted connection (${show(p.source.url)}); anyone on the network path can change what is installed. Use https`);
      if (p.source.kind === 'registry') registries.add(stripCredentials(p.source.url).replace(/\/+$/, ''));
      if ((p.source.kind === 'registry' || p.source.kind === 'url') && !p.hashes.length) {
        if (hashMode) add('missing-hash', 'error', at, `${label} has no hash in the lock file while the other packages have them, so the installer cannot check its download. Lock it again`);
        else if (o.wantHashes) add('missing-hash', 'warning', at, `${label} has no hash in the lock file, so the installer cannot check its download`);
      }
      const weak = algorithms(p.hashes).filter((a) => WEAK_HASHES.includes(a));
      if (weak.length) add('weak-hash', 'warning', at, `${label} has a hash made with ${weakNames(weak)}, which can be forged; lock it again to record sha256 hashes`);
      if (p.source.kind === 'registry' && isPrivate(p.normalized, cfg) && stripCredentials(p.source.url).replace(/\/+$/, '') === PYPI_INDEX) {
        add('extra-index', 'error', at, `${label} is a private package (see "privatePackages" in the config), but the lock file records it from the public index ${PYPI_INDEX}: a package of that name was published there, possibly to replace yours. Check it before installing`);
      }
    }
    if (registries.size > 1) {
      add('extra-index', 'warning', { file: lock.file, line: 1 }, `${show(lock.file)} locks packages from ${registries.size} indexes (${[...registries].map(show).join(', ')}); check that each private package is locked from your own index, so a public package of the same name cannot replace it (dependency confusion)`);
    }
  }

  // The requirements against the lock file.
  if (inputs.pair) {
    const { requirements: tree, lock } = inputs.pair;
    const locked = new Map();
    for (const p of lock.packages) if (!locked.has(p.normalized)) locked.set(p.normalized, p);
    for (const r of tree.requirements) {
      if (r.normalized === null) continue;
      const p = locked.get(r.normalized);
      const at = { name: r.name, normalized: r.normalized, version: r.pin, file: r.file, line: r.line };
      if (!p) {
        if (!r.marker) add('lock-mismatch', 'error', at, `${show(r.name)} is required in ${show(r.file)} but not locked in ${show(lock.file)}; lock the requirements again, or the build installs something the lock file never saw`);
        continue;
      }
      if (r.url !== null || p.version === null) continue;
      const s = satisfies(p.version, r.specs);
      if (s.ok && !s.match) add('lock-mismatch', 'error', at, `${show(r.name)} is locked at ${show(p.version)} in ${show(lock.file)}, outside "${show(r.specifier)}" in ${show(r.file)}; lock the requirements again`);
      else if (!s.ok) notes.push(`${show(r.name)}: the locked version ${show(p.version)} is not a PEP 440 version and was not compared`);
    }
  } else if ((inputs.requirements || []).length && locks.length) {
    notes.push('lock-mismatch compares a requirements file with a lock file only when both are given with --requirements and --lock');
  }

  // Ignore rules from the config.
  const kept = [];
  let ignored = 0;
  for (const f of all) {
    const hit = cfg.ignore.some((r) => (r.check === null || r.check === f.id) && (r.package === null || (f.normalized !== null && globMatch(r.package, f.normalized))));
    if (hit) ignored += 1;
    else kept.push(f);
  }
  if (ignored) notes.push(`${plural(ignored, 'finding')} left out by "ignore" rules in the config`);

  const cmpText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  kept.sort((a, b) => RANK[a.severity] - RANK[b.severity] || ORDER[a.id] - ORDER[b.id] || cmpText(a.file ?? '', b.file ?? '') || a.line - b.line);
  const counts = { error: 0, warning: 0, info: 0 };
  const byCheck = Object.fromEntries(FINDINGS.map((f) => [f.id, 0]));
  for (const f of kept) {
    counts[f.severity] += 1;
    byCheck[f.id] += 1;
  }
  const failing = kept.filter((f) => meetsThreshold(f.severity, o.failOn));
  const errors = failing.filter((f) => f.severity === 'error').length;
  const warnings = failing.length - errors;
  const reason = [errors ? plural(errors, 'error') : '', warnings ? plural(warnings, 'warning') : ''].filter(Boolean).join(' and ');
  if (kept.length > o.limit) notes.push(`showing the first ${plural(o.limit, 'finding')} of ${kept.length.toLocaleString('en-US')}; raise --limit to see more`);
  if (packages.length > o.limit) notes.push(`showing the first ${o.limit.toLocaleString('en-US')} of ${packages.length.toLocaleString('en-US')} packages`);
  for (const tree of trees) for (const n of tree.notes) notes.push(n);

  const files = trees.flatMap((t) => t.files);
  return {
    tool: 'requirements-check',
    sources: o.sources ? Object.fromEntries(Object.entries(o.sources).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => safeText(x, 300)) : safeText(v, 300)])) : null,
    summary: {
      requirementFiles: files.filter((f) => f.kind === 'requirements').length,
      constraintFiles: files.filter((f) => f.kind === 'constraints').length,
      lockFiles: locks.length,
      packages: packages.length,
      pinned: packages.filter((p) => p.pinned).length,
      hashed: packages.filter((p) => p.hashes > 0).length,
      direct: packages.filter((p) => p.kind === 'direct' || p.kind === 'editable').length,
      indexes: [...new Set(trees.flatMap((t) => t.options.filter((x) => x.name === 'index-url' || x.name === 'extra-index-url').map((x) => safeText(x.value, 300))))]
    },
    files: files.map((f) => ({ ...f, file: safeText(f.file, 300) })),
    packages: packages.slice(0, o.limit),
    counts,
    byCheck,
    total: kept.length,
    ignored,
    limit: o.limit,
    findings: kept.slice(0, o.limit).map(({ normalized, ...f }) => ({
      ...f,
      package: f.package === null ? null : show(f.package),
      version: f.version === null ? null : show(f.version),
      file: f.file === null ? null : show(f.file)
    })),
    notes: notes.map((n) => safeText(n, 1200)),
    gate: { failOn: o.failOn, pass: failing.length === 0, reason: failing.length ? reason : '' }
  };
}

