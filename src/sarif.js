// A minimal SARIF 2.1.0 log, so GitHub code scanning (or any SARIF viewer) can show the findings.
// Each result points at the file and line where the requirement, option or locked package is written,
// with the package name as its logical location.

import { FINDINGS } from './check.js';

export const SARIF_VERSION = '2.1.0';
export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const INFO_URI = 'https://github.com/INNERLUXES/requirements-check';
const LEVEL = { error: 'error', warning: 'warning', info: 'note' };

// A path as a URI with forward slashes: relative paths stay relative (as code scanning expects, from the
// repository root), absolute ones become file:// URIs. Characters outside the URI set are percent-encoded.
export function sarifUri(path) {
  const p = String(path || 'requirements.txt').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  const drive = /^([A-Za-z]):\//.exec(p);
  const encode = (s) => s.split('/').map((part) => encodeURIComponent(part)).join('/');
  if (drive) return `file:///${drive[1]}:/${encode(p.slice(3))}`;
  if (p.startsWith('/')) return `file://${encode(p)}`;
  return encode(p);
}

function ruleLevel(severity) {
  return LEVEL[severity.split(' / ')[0]];
}

export function toSarif(r, version = '1.0.0') {
  const rules = FINDINGS.map((f) => ({
    id: f.id,
    name: f.id.replace(/(^|-)([a-z])/g, (all, dash, c) => c.toUpperCase()),
    shortDescription: { text: f.what },
    helpUri: `${INFO_URI}/blob/main/docs/method.md`,
    defaultConfiguration: { level: ruleLevel(f.severity) }
  }));
  const index = Object.fromEntries(rules.map((rule, i) => [rule.id, i]));
  const results = r.findings.map((f) => {
    const location = {
      physicalLocation: { artifactLocation: { uri: sarifUri(f.file) }, region: { startLine: Math.max(1, f.line || 1) } }
    };
    if (f.package) location.logicalLocations = [{ name: f.package, kind: 'module' }];
    return {
      ruleId: f.id,
      ruleIndex: index[f.id],
      level: LEVEL[f.severity],
      message: { text: f.message },
      locations: [location],
      partialFingerprints: { requirementsCheck: `${f.id}:${f.file ?? ''}:${f.package ?? f.line}` }
    };
  });
  const log = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [{
      tool: { driver: { name: 'requirements-check', version, informationUri: INFO_URI, rules } },
      results
    }]
  };
  return JSON.stringify(log, null, 2) + '\n';
}
