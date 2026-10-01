# Changes

## 1.0.1

- Fix: an include given as an absolute path (`-r /some/where/file.txt`) is now resolved as absolute and refused when it lies outside the folder of the starting file. Before, on Linux and macOS it was joined to the folder of the including file instead.

## 1.0.0

First release.

- Checks the dependency files of a Python web application for supply-chain and reproducibility risks before it is built or deployed. Reads files only; never runs pip or Python and never fetches anything.
- Reads pip requirements files, constraints files and pip-compile output as pip does: line continuations, comments, options lines, extras, PEP 440 specifiers, environment markers, `--hash` options, and `-r` / `-c` includes followed relative to the file that names them, refusing paths outside the starting folder and reporting cycles.
- Reads `uv.lock` and `poetry.lock` through a small TOML reader that refuses anything outside the subset these files use, and lists every locked package with its version, source and hashes.
- Ten checks: `non-index-source`, `insecure-url`, `unpinned`, `missing-hash`, `duplicate-requirement`, `conflicting-constraint`, `lock-mismatch`, `extra-index`, `weak-hash` and `marker-note`.
- Package names compared in their PEP 503 form, and versions compared by PEP 440 for `==` (with wildcards), `!=`, `~=`, `<`, `<=`, `>`, `>=` and `===`.
- Config file in JSON: `allowDirect`, `privatePackages`, `devPatterns` and `ignore` rules by check and package. Unknown keys and checks stop the run.
- Reports as text, Markdown, JSON, CSV and SARIF 2.1.0, with a table of the packages and the findings with file and line (`--limit`, with the total always shown); `--fail-on` for a pipeline gate.
- Safe input: user names and tokens in URLs are masked in every format, files over 50 MB, more than 100,000 requirement lines or locked packages and more than 50 nested includes stop the run, and control characters are removed from every text shown.
- Release packages come with a CycloneDX SBOM, SHA-256 checksums and a build provenance attestation.
