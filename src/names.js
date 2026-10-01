// Package names and versions as Python packaging defines them.
//   PEP 503: a name is compared in lower case, with every run of "-", "_" and "." read as one "-".
//   PEP 508: what a valid project name looks like.
//   PEP 440: the version scheme and the version specifiers (==, ===, !=, ~=, <, <=, >, >=).
// Only the parts a requirements check needs are here; anything that cannot be read is reported, not guessed.

const MAX_VERSION = 128;
const MAX_SPECIFIERS = 64;

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

// PEP 503 normalisation: "Example_Web.Framework" and "example-web-framework" are the same project.
export function normalizeName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

// A valid project name under PEP 508 (ASCII letters and digits, with ".", "-" and "_" inside).
export function isValidName(name) {
  return typeof name === 'string' && name.length <= 200 && NAME.test(name);
}

const VERSION = new RegExp([
  '^v?',
  '(?:(\\d{1,15})!)?',
  '(\\d{1,15}(?:\\.\\d{1,15}){0,15})',
  '(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\\d{1,15})?)?',
  '(?:-(\\d{1,15})|[-_.]?(post|rev|r)[-_.]?(\\d{1,15})?)?',
  '(?:[-_.]?(dev)[-_.]?(\\d{1,15})?)?',
  '(?:\\+([a-z0-9]{1,40}(?:[-_.][a-z0-9]{1,40}){0,15}))?$'
].join(''), 'i');

const PRE_LABEL = { a: 'a', alpha: 'a', b: 'b', beta: 'b', c: 'rc', rc: 'rc', pre: 'rc', preview: 'rc' };
const PRE_RANK = { a: 0, b: 1, rc: 2 };

// A PEP 440 version as { epoch, release, pre, post, dev, local }, or null when it is not one.
// pre is [label, number] with the label normalised to a, b or rc; post and dev are numbers or null.
export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > MAX_VERSION) return null;
  const m = VERSION.exec(value.trim());
  if (!m) return null;
  let post = null;
  if (m[5] !== undefined) post = Number(m[5]);
  else if (m[6] !== undefined) post = Number(m[7] ?? 0);
  return {
    epoch: Number(m[1] ?? 0),
    release: m[2].split('.').map(Number),
    pre: m[3] ? [PRE_LABEL[m[3].toLowerCase()], Number(m[4] ?? 0)] : null,
    post,
    dev: m[8] ? Number(m[9] ?? 0) : null,
    local: m[10] ? m[10].toLowerCase().split(/[-_.]/) : null
  };
}

// The normalised text of a parsed version, such as "1.0rc1.post2.dev3+local.1".
export function formatVersion(v) {
  let s = `${v.epoch ? `${v.epoch}!` : ''}${v.release.join('.')}`;
  if (v.pre) s += `${v.pre[0]}${v.pre[1]}`;
  if (v.post !== null) s += `.post${v.post}`;
  if (v.dev !== null) s += `.dev${v.dev}`;
  if (v.local) s += `+${v.local.join('.')}`;
  return s;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRelease(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = cmp(a[i] ?? 0, b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// Sort keys from PEP 440: a dev release of a final version comes before its prereleases, and a version without a
// prerelease comes after them; no post release comes first; no dev release comes last.
function preKey(v) {
  if (v.pre) return [PRE_RANK[v.pre[0]], v.pre[1]];
  if (v.dev !== null && v.post === null) return [-1, 0];
  return [3, 0];
}

function compareLocal(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    const d = an && bn ? cmp(Number(a[i]), Number(b[i])) : an ? 1 : bn ? -1 : cmp(a[i], b[i]);
    if (d) return d;
  }
  return 0;
}

// -1, 0 or 1, in PEP 440 order. With { local: false } the local labels are left out, as specifiers do.
export function compareVersions(a, b, { local = true } = {}) {
  const pa = preKey(a);
  const pb = preKey(b);
  return cmp(a.epoch, b.epoch)
    || compareRelease(a.release, b.release)
    || cmp(pa[0], pb[0]) || cmp(pa[1], pb[1])
    || cmp(a.post ?? -1, b.post ?? -1)
    || cmp(a.dev ?? Infinity, b.dev ?? Infinity)
    || (local ? compareLocal(a.local, b.local) : 0);
}

const CLAUSE = /^(===|==|!=|~=|<=|>=|<|>)\s*(\S+)$/;

// A specifier set ("==1.4.2", ">=1.0, <2", "(~=3.1)") as { ok, specs, reason }.
// Each spec is { op, version, wildcard }; "===" keeps its text as it is.
export function parseSpecifiers(text) {
  let s = String(text ?? '').trim();
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1).trim();
  if (s === '') return { ok: true, specs: [] };
  const parts = s.split(',');
  if (parts.length > MAX_SPECIFIERS) return { ok: false, specs: [], reason: `more than ${MAX_SPECIFIERS} version clauses` };
  const specs = [];
  for (const raw of parts) {
    const m = CLAUSE.exec(raw.trim());
    if (!m) return { ok: false, specs: [], reason: `"${raw.trim()}" is not a version clause` };
    const [, op, value] = m;
    if (op === '===') {
      specs.push({ op, version: value, wildcard: false });
      continue;
    }
    const wildcard = value.endsWith('.*');
    if (wildcard && op !== '==' && op !== '!=') return { ok: false, specs: [], reason: `"${raw.trim()}": only == and != take a .* wildcard` };
    const version = wildcard ? value.slice(0, -2) : value;
    const parsed = parseVersion(version);
    if (!parsed) return { ok: false, specs: [], reason: `"${version}" is not a PEP 440 version` };
    if (wildcard && parsed.local) return { ok: false, specs: [], reason: `"${raw.trim()}": a wildcard cannot follow a local version` };
    if (op === '~=' && parsed.release.length < 2) return { ok: false, specs: [], reason: `"${raw.trim()}": ~= needs at least two release numbers` };
    specs.push({ op, version, wildcard });
  }
  return { ok: true, specs };
}

// The exact pin of a specifier list: the version of its "==" clause without a wildcard, or of its "===" clause.
export function exactPin(specs) {
  const pin = specs.find((s) => s.op === '===' || (s.op === '==' && !s.wildcard));
  return pin ? pin.version : null;
}

// The specifiers as one canonical text, for comparing two requirements.
export function specifierText(specs) {
  return specs.map((s) => {
    if (s.op === '===') return `===${s.version}`;
    const v = parseVersion(s.version);
    if (v && !s.wildcard) {
      // "1.0" and "1" are the same version; trailing zeros are dropped (not for a wildcard prefix).
      const release = [...v.release];
      while (release.length > 1 && release[release.length - 1] === 0) release.pop();
      return `${s.op}${formatVersion({ ...v, release })}`;
    }
    return `${s.op}${v ? formatVersion(v) : s.version}${s.wildcard ? '.*' : ''}`;
  }).sort().join(',');
}

function prefixMatch(candidate, prefix) {
  if (candidate.epoch !== prefix.epoch) return false;
  // "==1.4.*" matches every version whose release starts with 1.4 (zeros padded), whatever follows.
  const parts = prefix.release;
  for (let i = 0; i < parts.length; i += 1) if ((candidate.release[i] ?? 0) !== parts[i]) return false;
  if (prefix.pre || prefix.post !== null || prefix.dev !== null) {
    return compareVersions({ ...candidate, local: null }, prefix, { local: false }) === 0
      || formatVersion({ ...candidate, local: null }).startsWith(formatVersion(prefix));
  }
  return true;
}

function one(candidate, spec, text) {
  if (spec.op === '===') return text.trim().toLowerCase() === spec.version.toLowerCase();
  const target = parseVersion(spec.version);
  if (spec.op === '==' || spec.op === '!=') {
    let eq;
    if (spec.wildcard) eq = prefixMatch(candidate, target);
    else if (target.local) eq = compareVersions(candidate, target) === 0;
    else eq = compareVersions(candidate, target, { local: false }) === 0;
    return spec.op === '==' ? eq : !eq;
  }
  const d = compareVersions(candidate, target, { local: false });
  const sameRelease = candidate.epoch === target.epoch && compareRelease(candidate.release, target.release) === 0;
  switch (spec.op) {
    case '>=': return d >= 0;
    case '<=': return d <= 0;
    // ">1.7" does not match a post release of 1.7, and "<1.7" does not match a prerelease of 1.7 (PEP 440).
    case '>': return d > 0 && !(sameRelease && candidate.post !== null && target.post === null && !target.pre && target.dev === null);
    case '<': return d < 0 && !(sameRelease && (candidate.pre || candidate.dev !== null) && !target.pre && target.dev === null && target.post === null);
    case '~=': {
      const prefix = { ...target, release: target.release.slice(0, -1), pre: null, post: null, dev: null, local: null };
      return d >= 0 && prefixMatch(candidate, prefix);
    }
    default: return false;
  }
}

// Whether a version satisfies a specifier list (all clauses must hold).
// Returns { ok, match, reason }: ok is false when the version cannot be read, and then match is null.
// The rule that leaves prereleases out unless asked for is not applied: a pinned or locked version was chosen.
export function satisfies(version, specs) {
  const list = Array.isArray(specs) ? specs : parseSpecifiers(specs).specs;
  if (list.every((s) => s.op === '===')) {
    return { ok: true, match: list.every((s) => one(null, s, String(version))) };
  }
  const candidate = parseVersion(String(version));
  if (!candidate) return { ok: false, match: null, reason: `"${version}" is not a PEP 440 version` };
  return { ok: true, match: list.every((s) => one(candidate, s, String(version))) };
}
