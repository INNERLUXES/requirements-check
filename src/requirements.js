// Reads pip requirements files (requirements.txt, constraints files and pip-compile output) the way pip reads
// them: lines joined at a trailing backslash, comments removed, options lines, requirements with extras,
// version specifiers, environment markers and --hash options, and -r / -c includes followed relative to the
// file that names them. Nothing is installed, run or fetched; an include that names a URL is recorded, not read.
// The format: https://pip.pypa.io/en/stable/reference/requirements-file-format/

import { readFile, stat, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute, basename, sep } from 'node:path';
import { normalizeName, isValidName, parseSpecifiers, exactPin } from './names.js';

export const LIMITS = {
  maxFileBytes: 50 * 1024 * 1024,
  maxRequirements: 100_000,
  maxIncludeDepth: 50
};

function mb(bytes) {
  return `${bytes / 1024 / 1024} MB`;
}

// Reads a file as UTF-8 text within the size limit. A byte order mark is dropped.
export async function readBounded(path, limits = LIMITS) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path}: not a file`);
  if (info.size > limits.maxFileBytes) throw new Error(`${path}: ${info.size} bytes is over the ${mb(limits.maxFileBytes)} limit`);
  return (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
}

const COMMENT = /(^|\s+)#.*$/;

// The logical lines of a requirements file: a line that ends with a backslash is joined with the next one,
// then comments ("#" at the start or after white space) are removed. Each line keeps the number of its first
// physical line. Empty lines are left out.
export function logicalLines(text) {
  const physical = String(text).split(/\r\n|\n|\r/);
  const out = [];
  let buffer = '';
  let start = 0;
  for (let i = 0; i < physical.length; i += 1) {
    const row = physical[i];
    if (buffer === '') start = i + 1;
    if (row.endsWith('\\') && !COMMENT.test(row)) {
      buffer += row.slice(0, -1);
      if (i < physical.length - 1) continue;
    } else buffer += row;
    const line = buffer.replace(COMMENT, '').trim();
    if (line) out.push({ text: line, line: start });
    buffer = '';
  }
  return out;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// What kind of direct reference a URL or path is: vcs (git+, hg+, svn+, bzr+), url (http, https, ftp) or path.
export function referenceKind(ref) {
  if (/^(?:git|hg|svn|bzr)\+/i.test(ref) || /^(?:git|svn):\/\//i.test(ref)) return 'vcs';
  if (/^(?:https?|ftp):\/\//i.test(ref)) return 'url';
  return 'path';
}

// A URL that travels without encryption: http, ftp, git://, svn:// and the plain-http VCS forms.
export function isInsecureUrl(url) {
  return /^(?:http:|ftp:|git:\/\/|svn:\/\/|(?:git|hg|svn|bzr)\+http:)/i.test(String(url).trim());
}

function looksLikeReference(text) {
  if (/^[a-z]:[\\/]/i.test(text)) return true;
  if (SCHEME.test(text) && (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^file:/i.test(text))) return true;
  return /^[.~/\\]/.test(text) || /[/\\]/.test(text) || /\.(?:whl|zip|tar\.gz|tgz|tar\.bz2)$/i.test(text);
}

const HASH_ALGOS = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];

function fragmentHashes(url) {
  const out = [];
  const hash = url.indexOf('#');
  if (hash === -1) return out;
  for (const part of url.slice(hash + 1).split('&')) {
    const m = /^([a-z0-9]+)=([0-9a-f]+)$/i.exec(part);
    if (m && HASH_ALGOS.includes(m[1].toLowerCase())) out.push(`${m[1].toLowerCase()}:${m[2].toLowerCase()}`);
  }
  return out;
}

function nameFromReference(ref) {
  const egg = /[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(ref);
  if (egg) return egg[1];
  const file = /([^/\\#?]+)\.(?:whl|zip|tar\.gz|tgz|tar\.bz2)(?:[#?]|$)/i.exec(ref);
  if (file) {
    const part = file[1].split('-')[0];
    if (isValidName(part)) return part;
  }
  // A local folder ("./vendor/example-lib") is named after its last part when that is a valid name.
  if (referenceKind(ref) === 'path') {
    const last = ref.replace(/^file:(?:\/\/)?/i, '').split(/[/\\]/).filter(Boolean).pop();
    if (last && last !== '.' && last !== '..' && isValidName(last)) return last;
  }
  return null;
}

// One requirement, without its options: "name[extras] specifiers ; marker", "name @ url ; marker",
// or a URL or path on its own. Returns { ok, ... } or { ok: false, reason }.
export function parseRequirement(text) {
  let body = String(text).trim();
  let marker = null;
  const direct = looksLikeReference(body.split(/\s/)[0]) || /^[^\s@[]+(?:\[[^\]]*\])?\s*@\s/.test(body) || /^[^\s@[]+(?:\[[^\]]*\])?\s*@\S*:/.test(body);
  // A URL may hold ";", so a marker after a URL needs white space before the ";" (as pip reads it).
  const split = direct ? /\s;/.exec(body) : /;/.exec(body);
  if (split) {
    marker = body.slice(split.index + split[0].length).trim();
    body = body.slice(0, split.index).trim();
    if (!marker) return { ok: false, reason: 'an empty environment marker after ";"' };
  }
  const at = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*@\s*(\S+)$/.exec(body);
  if (at) {
    if (!isValidName(at[1])) return { ok: false, reason: `"${at[1]}" is not a valid project name` };
    return requirementOf(at[1], at[2], [], '', marker, at[3]);
  }
  if (looksLikeReference(body.split(/\s/)[0])) {
    if (/\s/.test(body)) return { ok: false, reason: 'text after a URL or path' };
    const extras = /^(.*?)\[([^\]]*)\]$/.exec(body);
    const ref = extras && !SCHEME.test(body) ? extras[1] : body;
    return requirementOf(nameFromReference(ref), extras && !SCHEME.test(body) ? extras[2] : null, [], '', marker, ref);
  }
  const m = /^([^\s[(<>=!~;]+)\s*(?:\[([^\]]*)\])?\s*(.*)$/.exec(body);
  if (!m || !isValidName(m[1])) return { ok: false, reason: `"${(m ? m[1] : body).slice(0, 80)}" is not a valid project name` };
  const parsed = parseSpecifiers(m[3]);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return requirementOf(m[1], m[2], parsed.specs, m[3].trim().replace(/^\((.*)\)$/, '$1').trim(), marker, null);
}

function requirementOf(name, extras, specs, specifier, marker, url) {
  const list = extras === undefined || extras === null ? [] : extras.split(',').map((e) => e.trim()).filter(Boolean);
  for (const e of list) if (!isValidName(e)) return { ok: false, reason: `"${e}" is not a valid extra` };
  return {
    ok: true,
    name,
    normalized: name === null ? null : normalizeName(name),
    extras: list,
    specs,
    specifier,
    pin: url === null ? exactPin(specs) : null,
    marker,
    url,
    refKind: url === null ? null : referenceKind(url),
    urlHashes: url === null ? [] : fragmentHashes(url)
  };
}

// Options that take a value, by every spelling pip accepts. The rest of the line is the value of -e.
const VALUE_OPTIONS = {
  '-r': 'requirement', '--requirement': 'requirement',
  '-c': 'constraint', '--constraint': 'constraint',
  '-e': 'editable', '--editable': 'editable',
  '-i': 'index-url', '--index-url': 'index-url',
  '--extra-index-url': 'extra-index-url',
  '-f': 'find-links', '--find-links': 'find-links',
  '--trusted-host': 'trusted-host',
  '--only-binary': 'only-binary', '--no-binary': 'no-binary',
  '--use-feature': 'use-feature'
};
const FLAG_OPTIONS = { '--require-hashes': 'require-hashes', '--no-index': 'no-index', '--pre': 'pre', '--prefer-binary': 'prefer-binary' };
const REQUIREMENT_OPTIONS = ['--hash', '--config-settings', '--global-option'];

function optionLine(text, line, label) {
  const m = /^(-[a-zA-Z]|--[a-z][a-z-]*)(?:(=|\s+)(.*)|(.*))$/s.exec(text);
  const flag = m ? m[1] : text.split(/\s/)[0];
  if (Object.hasOwn(FLAG_OPTIONS, flag) && m && !(m[3] ?? m[4] ?? '').trim()) return { type: 'option', name: FLAG_OPTIONS[flag], value: null, line };
  if (m && Object.hasOwn(VALUE_OPTIONS, flag)) {
    // "-rfile" is the short form with the value attached.
    const value = (m[3] ?? (flag.length === 2 ? m[4] : '')).trim();
    if (!value) throw new Error(`${label}:${line}: ${flag} needs a value`);
    const name = VALUE_OPTIONS[flag];
    if (name === 'requirement' || name === 'constraint') return { type: 'include', kind: name, target: value, line };
    if (name === 'editable') return { type: 'editable', text: value, line };
    if (/\s/.test(value)) throw new Error(`${label}:${line}: ${flag} takes one value, not "${value.slice(0, 80)}"`);
    return { type: 'option', name, value, line };
  }
  return { type: 'unknown-option', text: flag, line };
}

// Splits "name==1.0 --hash=sha256:ab --hash sha256:cd" into the requirement and its options, as pip does:
// the options start at the first word that starts with "-".
function requirementLine(text, line, label, editable = false) {
  const words = text.split(/\s+/);
  const first = words.findIndex((w, i) => i > 0 && w.startsWith('-'));
  const reqText = first === -1 ? text : words.slice(0, first).join(' ');
  const hashes = [];
  const unknown = [];
  if (first !== -1) {
    const opts = words.slice(first);
    for (let i = 0; i < opts.length; i += 1) {
      const w = opts[i];
      const eq = w.indexOf('=');
      const flag = eq === -1 ? w : w.slice(0, eq);
      let value = eq === -1 ? null : w.slice(eq + 1);
      if (!REQUIREMENT_OPTIONS.includes(flag)) {
        unknown.push(flag);
        continue;
      }
      if (value === null) {
        value = opts[i + 1] ?? '';
        i += 1;
      }
      if (flag === '--hash') {
        const h = /^([a-z0-9]+):([0-9a-f]+)$/i.exec(value);
        if (!h || !HASH_ALGOS.includes(h[1].toLowerCase())) throw new Error(`${label}:${line}: "--hash ${value.slice(0, 80)}" is not algorithm:hex-digest`);
        hashes.push(`${h[1].toLowerCase()}:${h[2].toLowerCase()}`);
      }
    }
  }
  const req = parseRequirement(reqText);
  if (!req.ok) throw new Error(`${label}:${line}: cannot read the requirement "${reqText.slice(0, 120)}": ${req.reason}`);
  if (editable && req.url === null) {
    // "-e name" is not valid; "-e ." or "-e path" is a path, which parseRequirement reads as a name when it has no "/".
    req.url = reqText;
    req.refKind = referenceKind(reqText);
    req.name = nameFromReference(reqText);
    req.normalized = req.name === null ? null : normalizeName(req.name);
    req.pin = null;
  }
  return { type: 'requirement', req: { ...req, hashes: [...req.urlHashes, ...hashes], hashOptions: hashes.length, editable }, unknown, line };
}

// One requirements file's text, without following its includes: a list of entries
// (requirement, include, option, unknown-option), each with its line.
export function parseRequirementsText(text, label = 'requirements file') {
  const entries = [];
  for (const { text: t, line } of logicalLines(text)) {
    if (t.startsWith('-')) {
      const o = optionLine(t, line, label);
      if (o.type === 'editable') entries.push(requirementLine(o.text, line, label, true));
      else entries.push(o);
    } else entries.push(requirementLine(t, line, label));
  }
  return entries;
}

function toPosix(p) {
  return p.split('\\').join('/');
}

// Reads a requirements file and every file it includes with -r and -c.
//   path       the file named on the command line
//   options    limits, isDev (a function of the file name), display (the name to show)
// Returns { file, files, requirements, constraints, options, remoteIncludes, requireHashes, notes }.
// An include outside the folder of the starting file, a cycle of includes, too deep a chain of includes,
// a file over the size limit or too many lines stops the run with an error.
export async function readRequirements(path, { limits = LIMITS, isDev = () => false, display = path } = {}) {
  const rootDir = await realpath(dirname(resolve(path)));
  const tree = { file: display, files: [], requirements: [], constraints: [], options: [], remoteIncludes: [], requireHashes: false, notes: [] };
  const seen = new Set();
  let lines = 0;
  const lexicalRoot = dirname(resolve(path));
  const outside = (from, to) => {
    const rel = relative(from, to);
    return rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel);
  };
  const refuse = (shown) => new Error(`${shown}: refusing to read a file outside ${toPosix(dirname(display))}, the folder of ${display}`);

  async function walk(file, shown, kind, chain) {
    // The path as written, and the real path after links, must both stay inside the starting folder.
    if (outside(lexicalRoot, resolve(file))) throw refuse(shown);
    const real = await realpath(file);
    const rel = relative(rootDir, real);
    if (outside(rootDir, real)) throw refuse(shown);
    if (chain.includes(real)) {
      const names = [...chain.slice(chain.indexOf(real)).map((r) => toPosix(relative(rootDir, r)) || r), toPosix(rel)];
      throw new Error(`${display}: the includes form a cycle (${names.join(' -> ')})`);
    }
    if (chain.length > limits.maxIncludeDepth) throw new Error(`${shown}: more than ${limits.maxIncludeDepth} nested -r / -c includes`);
    if (seen.has(real)) return;
    seen.add(real);
    const text = await readBounded(file, limits);
    const entries = parseRequirementsText(text, shown);
    lines += entries.length;
    if (lines > limits.maxRequirements) throw new Error(`${display}: more than ${limits.maxRequirements.toLocaleString('en-US')} requirement lines, which is over the limit`);
    const dev = isDev(basename(shown));
    tree.files.push({ file: shown, kind: kind === 'constraint' ? 'constraints' : 'requirements', dev, depth: chain.length });
    for (const e of entries) {
      if (e.type === 'requirement') {
        const r = { ...e.req, file: shown, line: e.line, dev, constraint: kind === 'constraint' };
        (kind === 'constraint' ? tree.constraints : tree.requirements).push(r);
        for (const u of e.unknown) tree.notes.push(`${shown}:${e.line}: the option ${u} is not read by this tool`);
      } else if (e.type === 'option') {
        if (e.name === 'require-hashes') tree.requireHashes = true;
        tree.options.push({ name: e.name, value: e.value, file: shown, line: e.line });
      } else if (e.type === 'unknown-option') {
        tree.notes.push(`${shown}:${e.line}: the option ${e.text} is not read by this tool`);
      } else if (e.type === 'include') {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(e.target)) {
          tree.remoteIncludes.push({ kind: e.kind, url: e.target, file: shown, line: e.line });
          continue;
        }
        const target = join(dirname(file), e.target);
        const nextShown = toPosix(join(dirname(shown), e.target));
        try {
          await walk(target, nextShown, kind === 'constraint' ? 'constraint' : e.kind, [...chain, real]);
        } catch (error) {
          if (error.code === 'ENOENT') throw new Error(`${shown}:${e.line}: the included file ${nextShown} does not exist`);
          throw error;
        }
      }
    }
  }

  await walk(path, display, 'requirement', []);
  return tree;
}
