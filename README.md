# requirements-check

Checks the dependency files of a Python web application (pip requirements files, constraints files, pip-compile output, `uv.lock` and `poetry.lock`) for supply-chain and reproducibility risks before the application is built or deployed. It reads which packages are pinned, where each one comes from, whether its hashes are there and strong, which indexes pip will ask, and whether the requirements and the lock file still agree, and fails the pipeline when something needs a person to look at it.

A Python web application, whether it runs on Django, Flask or FastAPI, depends on dozens of packages that run inside the same process as its own code: with the same database password, the same secret key and the same access to customer data. Which of those packages reach production is decided by a few small text files. A requirement without an exact pin installs whatever version is newest on the day of the build. A line that installs from a git branch or an archive URL bypasses the package index and its hashes. An index reached over plain `http://`, or a second index added with `--extra-index-url`, lets someone else decide which file pip downloads. Two files that pin the same package differently, or a lock file that no longer matches the requirements, mean the build is not what was reviewed. Each of these is one short line in a pull request, and easy to miss. This tool reads those lines and says, in plain words, which of those things the change brings in.

- Every finding has an id, a severity (error, warning, info), the package, the file and line, and a plain message with what to do.
- It reads requirements files the way pip does: line continuations, comments, options lines, extras, version specifiers, environment markers, `--hash` options, and `-r` / `-c` includes followed relative to the file that names them.
- It reads `uv.lock` and `poetry.lock` through a small TOML reader that refuses anything it does not understand, and lists every locked package with its version, source and hashes.
- With `--requirements` and `--lock` it checks that every top-level requirement is locked, at a version its specifier allows.
- Reports as text, Markdown, JSON, CSV and SARIF, so findings can show up in GitHub code scanning.
- It reads files only. It never runs pip or Python, installs nothing, fetches nothing and opens no network connection.
- Plain JavaScript, no dependencies; the same files always give the same report.

```
npm test
```

```
ℹ tests 66
ℹ pass 66
ℹ fail 0
```

## Quick start

Requires Node 22 or newer. There is nothing to install.

```
git clone https://github.com/INNERLUXES/requirements-check.git
cd requirements-check
node bin/requirements-check.js examples/requirements.txt
```

Or without a clone, in the folder of your application:

```
npx --yes github:INNERLUXES/requirements-check requirements.txt
```

`examples/` holds the dependency files of a made-up orders service. All package names start with `example-` and do not refer to real packages; the hashes, hosts and tokens are made up too.

`examples/requirements.txt` is what `pip-compile --generate-hashes` writes: every package pinned with `==` and two sha256 hashes. The run passes with one info line, for the package that is installed on Windows only.

```
requirements-check: requirements examples/requirements.txt
files: 1 requirements, 0 constraints, 0 lock
packages: 6 (6 pinned, 6 with hashes, 0 direct references); indexes: default
findings: 0 error, 0 warning, 1 info

Package                Version  Source  Hashes    File
example-db-driver      2.9.9    index   2 sha256  examples/requirements.txt:6
example-json-schema    4.17.3   index   2 sha256  examples/requirements.txt:10
example-orders-models  1.4.0    index   2 sha256  examples/requirements.txt:14
example-tz-data        1.2.0    index   2 sha256  examples/requirements.txt:18
example-web-framework  3.0.3    index   2 sha256  examples/requirements.txt:22
example-wsgi-server    22.0.0   index   2 sha256  examples/requirements.txt:26

INFO      marker-note             examples/requirements.txt:18  example-tz-data is installed only where sys_platform == "win32"

GATE: PASS (--fail-on error)
```

`examples/requirements-risky.txt` has the problems the tool looks for: an index over http, an extra index with a deploy token in its URL, a trusted host, a requirement without a pin, a git dependency, an archive downloaded over http with an MD5 hash, an editable local folder, a package pinned twice across an included file, and a pin that a constraints file rules out.

```
node bin/requirements-check.js examples/requirements-risky.txt
```

```
requirements-check: requirements examples/requirements-risky.txt
files: 2 requirements, 1 constraints, 0 lock
packages: 10 (5 pinned, 1 with hashes, 3 direct references); indexes: http://pypi.example.internal/simple, https://***@pypi.example.org/simple
findings: 9 error, 3 warning, 1 info

Package                Version  Source                                                                                         Hashes  File
example-cache-client   4.0.2    http://pypi.example.internal/simple                                                            -       examples/requirements-shared.txt:2
example-json-tools     -        http://pypi.example.internal/simple                                                            -       examples/requirements-shared.txt:3
example-web-framework  3.0.3    http://pypi.example.internal/simple                                                            -       examples/requirements-risky.txt:9
example-orders-auth    >=1.2    http://pypi.example.internal/simple                                                            -       examples/requirements-risky.txt:10
example-pdf-render     -        git+https://github.com/example-org/example-pdf-render.git@v1.3.0                               -       examples/requirements-risky.txt:11
example-image-tool     -        http://files.example.com/example-image-tool-0.4.1.tar.gz#md5=ae4b417d74627d71d2620c2d109ae7ab  1 md5   examples/requirements-risky.txt:12
example-legacy-crypto  -        ./vendor/example-legacy-crypto                                                                 -       examples/requirements-risky.txt:13
example-cache-client   4.1.0    http://pypi.example.internal/simple                                                            -       examples/requirements-risky.txt:14
example-task-queue     5.3.6    http://pypi.example.internal/simple                                                            -       examples/requirements-risky.txt:15
example-date-utils     2.8.2    http://pypi.example.internal/simple                                                            -       examples/requirements-risky.txt:16

ERROR     non-index-source        examples/requirements-risky.txt:11  example-pdf-render comes from a version control repository (git+https://github.com/example-org/example-pdf-render.git@v1.3.0), not from a package index: a branch or tag can be moved, and there is no index hash. Publish it to your index and pin it, or add the prefix to "allowDirect" in the config when it is trusted

ERROR     non-index-source        examples/requirements-risky.txt:12  example-image-tool comes from an archive URL (http://files.example.com/example-image-tool-0.4.1.tar.gz#md5=ae4b417d74627d71d2620c2d109ae7ab), not from a package index: the server can send a different file tomorrow. Publish it to your index and pin it, or add the prefix to "allowDirect" in the config when it is trusted

ERROR     non-index-source        examples/requirements-risky.txt:13  example-legacy-crypto is installed in editable mode from ./vendor/example-legacy-crypto: pip runs the build of whatever that folder holds when it installs it. Publish it to your index and pin it, or add the prefix to "allowDirect" in the config when it is trusted

ERROR     insecure-url            examples/requirements-risky.txt:3  the index http://pypi.example.internal/simple uses an unencrypted connection; anyone on the network path can change every package from it. Use https

ERROR     insecure-url            examples/requirements-risky.txt:12  example-image-tool is fetched over an unencrypted connection (http://files.example.com/example-image-tool-0.4.1.tar.gz#md5=ae4b417d74627d71d2620c2d109ae7ab); anyone on the network path can change what is installed. Use https

ERROR     unpinned                examples/requirements-risky.txt:10  example-orders-auth has no exact pin (">=1.2"): pip installs the newest version that matches on the day of the build, so two builds of the same commit can differ. Pin it with ==

ERROR     unpinned                examples/requirements-shared.txt:3  example-json-tools has no exact pin (any version): pip installs the newest version that matches on the day of the build, so two builds of the same commit can differ. Pin it with ==

ERROR     duplicate-requirement   examples/requirements-risky.txt:14  example-cache-client is listed again with "==4.1.0", after "==4.0.2" at examples/requirements-shared.txt:2; pip refuses the pair or installs one of them, depending on its version. Keep one line

ERROR     conflicting-constraint  examples/requirements-risky.txt:16  example-date-utils: the pin ==2.8.2 is outside the constraint "<2.8" (examples/constraints.txt:2); pip cannot satisfy both and the install fails. Change one of them

WARNING   insecure-url            examples/requirements-risky.txt:5  --trusted-host pypi.example.internal tells pip to accept that host without a valid certificate (or over http). Give the host a valid certificate and remove the option

WARNING   extra-index             examples/requirements-risky.txt:4  --extra-index-url https://***@pypi.example.org/simple adds a second index: pip looks in every index and takes the highest version it finds, so anyone who publishes a private package name on the public index can replace it (dependency confusion). Prefer one index that serves both, or pin and hash every package

WARNING   weak-hash               examples/requirements-risky.txt:12  example-image-tool has a hash made with MD5, which can be forged (pip refuses such hashes in --hash); use sha256

INFO      marker-note             examples/requirements-risky.txt:15  example-task-queue is installed only where python_version < "3.13"

GATE: FAIL - 9 errors
```

The exit code is `1`. The token in the extra index URL is shown as `***`, in every format. `examples/requirements-check.json` is the config a team might write after reviewing these findings: it names the private packages (`example-orders-*`), accepts git dependencies from its own organisation, and leaves out the marker note it already knows about. With it, the git dependency is no longer reported, `example-orders-auth` becomes an `extra-index` error (a private package that any index could serve), and the run still fails.

`examples/uv.lock` and `examples/poetry.lock` lock the same service. The uv lock file matches `requirements.txt`; the Poetry one comes from an older branch and is one version behind:

```
node bin/requirements-check.js --requirements examples/requirements.txt --lock examples/poetry.lock
```

```
requirements-check: requirements examples/requirements.txt, lock examples/poetry.lock
files: 1 requirements, 0 constraints, 1 lock
packages: 12 (12 pinned, 12 with hashes, 0 direct references); indexes: default
findings: 1 error, 0 warning, 1 info

Package                Version  Source                   Hashes    File
example-db-driver      2.9.9    index                    2 sha256  examples/requirements.txt:6
example-json-schema    4.17.3   index                    2 sha256  examples/requirements.txt:10
example-orders-models  1.4.0    index                    2 sha256  examples/requirements.txt:14
example-tz-data        1.2.0    index                    2 sha256  examples/requirements.txt:18
example-web-framework  3.0.3    index                    2 sha256  examples/requirements.txt:22
example-wsgi-server    22.0.0   index                    2 sha256  examples/requirements.txt:26
example-db-driver      2.9.9    https://pypi.org/simple  2 sha256  examples/poetry.lock:4
example-json-schema    4.17.3   https://pypi.org/simple  2 sha256  examples/poetry.lock:15
example-orders-models  1.4.0    https://pypi.org/simple  2 sha256  examples/poetry.lock:26
example-tz-data        1.2.0    https://pypi.org/simple  2 sha256  examples/poetry.lock:40
example-web-framework  3.0.2    https://pypi.org/simple  2 sha256  examples/poetry.lock:51
example-wsgi-server    22.0.0   https://pypi.org/simple  2 sha256  examples/poetry.lock:68

ERROR     lock-mismatch           examples/requirements.txt:22  example-web-framework is locked at 3.0.2 in examples/poetry.lock, outside "==3.0.3" in examples/requirements.txt; lock the requirements again

INFO      marker-note             examples/requirements.txt:18  example-tz-data is installed only where sys_platform == "win32"

GATE: FAIL - 1 error
```

## Usage

```
requirements-check [files...] [--requirements <file>] [--lock <file>] [options]
```

```
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
--limit <n>             show at most n findings and packages (default: 200); the total is always shown
--help                  show the usage
--version               show the version
```

A file given without an option is read as a lock file when its name ends in `.lock`, and as a requirements file otherwise. Files named with `-r` and `-c` inside a requirements file are read too; they must sit in the folder of the file named on the command line or below it.

## Checks

| Id | Severity | What it reports |
| --- | --- | --- |
| `non-index-source` | error | A requirement or locked package from a direct reference: git or another version control system, an archive URL, a local path, an editable install (`-e`), or a requirements file included by URL |
| `insecure-url` | error / warning | An index, extra index, find-links location or direct reference over `http://` (or `git://`, `ftp://`) is an error; `--trusted-host` is a warning |
| `unpinned` | error / warning | A requirement without an exact `==` or `===` pin; an error in files meant for deployment, a warning in development files (`requirements-dev*.txt`, `test-requirements*.txt`, `*.in` and others) |
| `missing-hash` | error / warning | A requirement or locked package without a hash while hash checking is in effect (`--require-hashes`, or any `--hash` in the file); a warning with `--want-hashes` |
| `duplicate-requirement` | error | The same package (by its PEP 503 name) listed twice with different pins, across the file and the files it includes |
| `conflicting-constraint` | error | A requirement whose pin falls outside a `-c` constraint, or a constraint pin outside the requirement's specifier |
| `lock-mismatch` | error | With `--requirements` and `--lock`: a top-level requirement missing from the lock file, or locked at a version outside its specifier |
| `extra-index` | warning / error | `--extra-index-url`, or a lock file with packages from several indexes, is a warning; a private package (by `privatePackages`) with no hash next to an extra index, or locked from the public index, is an error |
| `weak-hash` | warning | A hash made with MD5 or SHA-1 |
| `marker-note` | info | A requirement limited by an environment marker, so it is installed only on some systems or Python versions |

[docs/method.md](docs/method.md) gives each check, the version rules and why each one matters.

## Config file

```json
{
  "allowDirect": ["git+https://github.com/example-org/", "./libs/"],
  "privatePackages": ["example-orders-*"],
  "devPatterns": ["requirements-dev*.txt", "requirements-ci*.txt", "*.in"],
  "ignore": [
    { "check": "marker-note", "package": "example-task-queue", "reason": "the worker runs on one Python version" }
  ]
}
```

- `allowDirect`: prefixes of direct references that are accepted, such as the git organisation or the folder of vendored packages your team controls. A URL prefix must end with `/`, so `https://git.example.org` cannot also match `https://git.example.org.evil.example`. Credentials are not allowed in the config.
- `privatePackages`: names (with `*`) of packages that only your own index should serve. Next to an extra index, each of them must carry a hash; in a lock file, each of them must not come from the public index.
- `devPatterns`: file name patterns of development requirements files, where `unpinned` is a warning. It replaces the defaults; `--dev-pattern` adds to them.
- `ignore`: findings to leave out, by `check`, by `package` (a name or a pattern with `*`), or both. `reason` is for the reader and is not used. The report says how many findings were left out.

Every key is checked. An unknown key, or an ignore rule for a check that does not exist, stops the run with exit code 2, so a typo cannot quietly turn a check off.

## Formats

- `text`: for a terminal: the summary, the packages with their version, source, hashes and location, then the findings, errors first.
- `markdown`: the same for a pull request comment or the job summary. Pipes and line breaks from the input are escaped, so a marker or a URL cannot break a table.
- `json`: the whole report, with package, version, file and line for every finding, and every package read.
- `csv`: one row per finding and per package, quoted as RFC 4180 says. A cell that starts with `=`, `+`, `-` or `@` gets a leading `'`, so a spreadsheet does not run it as a formula.
- `sarif`: a SARIF 2.1.0 log. Each result points at the file and line where the requirement, option or locked package is written, with the package name as its logical location.

To see the findings in GitHub code scanning, write the SARIF log and upload it:

```yaml
permissions:
  contents: read
  security-events: write
steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
  - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
    with:
      node-version: 22
  - name: Check the dependency files
    run: npx --yes github:INNERLUXES/requirements-check --requirements requirements.txt --lock uv.lock --format sarif > requirements-check.sarif
  - uses: github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v4.38.2
    if: always()
    with:
      sarif_file: requirements-check.sarif
      category: requirements-check
```

The step fails the job on an error; `if: always()` still uploads the log so the findings appear on the pull request. Run it before `pip install`, so a requirements file that brings in a git dependency or an http index is stopped before anything from it is downloaded or built.

## Exit codes

`0` no finding at the `--fail-on` level, `1` at least one such finding (by default: an error), `2` a usage or input error (a missing option or file, a line pip could not read, an include outside the starting folder, a cycle of includes, a lock file outside the TOML subset, a config with an unknown key, a file over 50 MB, more than 100,000 requirement lines or locked packages, more than 50 nested includes).

## Limits

The tool reads where packages come from and how they are pinned; it does not know what is in them. It does not look up known vulnerabilities: pair it with `pip-audit` or a dependency scanner. It cannot see what a build backend or a `setup.py` does when a source distribution is built. It reads the subset of TOML that lock files use, and refuses the rest. It does not read the dependencies declared in `pyproject.toml`, `setup.cfg` or `Pipfile`. [docs/limits.md](docs/limits.md) lists these, with the size limits.

## Background

- How Python web applications are built and kept safe to deploy, with checks like this one in the pipeline: [Python web development](https://innerluxes.dev/web-development/python).

## License

MIT
