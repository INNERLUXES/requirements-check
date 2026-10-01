# Threat model

## What the tool touches

- It reads the files given on the command line, with `--requirements`, `--lock` and `--config`, and the files that requirements files include with `-r` and `-c`, as long as they lie in the folder of the file named on the command line or below it. Nothing inside them is run, installed, fetched or followed as a link; URLs are read as text.
- It writes only to the screen (standard output and standard error).
- It opens no network connection and runs no program: not pip, not Python, not git, not a build backend.

## What the input may hold

A requirements file is written by hand or by pip-compile, and a lock file by uv or Poetry, and a pull request from anyone can change either. Both are short, easy to edit and easy to skim past in a review. The tool treats every input as possibly hostile. A requirements file can name packages from git repositories, file servers or local folders, point pip at an http index or a second index, carry index URLs with tokens in them, include other files by relative path (including `../../` paths that leave the project), include itself in a loop, or hold markers and names with control characters or text meant for a spreadsheet or a Markdown table. A lock file can hold TOML forms meant to confuse a reader, keys named to reach an object's prototype, or very deep nesting. A config file can try to switch checks off quietly.

## What could go wrong, and what stops it

| Risk | Control |
| --- | --- |
| A pull request adds a package from a git branch, an archive URL or a local folder, and it is built and installed without anyone noticing | `non-index-source` is an error; only prefixes listed in `allowDirect` are accepted, and the config that lists them sits in the repository where changes are reviewed |
| A requirement loses its pin, so the next build installs a release nobody reviewed | `unpinned` is an error in files meant for deployment |
| An index, a find-links location or a download uses plain http and is changed on the way | `insecure-url` is an error for `http://`, `ftp://`, `git://`, `svn://` and the VCS `+http` forms; `--trusted-host` is a warning |
| A second index serves a package with the name of a private one and a higher version (dependency confusion) | `extra-index` reports every extra index; private packages named in the config must carry a hash next to an extra index, and must not be locked from the public index |
| A requirement loses its hash in hash-checking mode, or a weak hash lets a changed file pass | `missing-hash` is an error in hash-checking mode, `weak-hash` a warning for MD5 and SHA-1 |
| Two files pin the same package differently, or a constraint rules out a pin, so what is built depends on pip's version or fails on the build server | `duplicate-requirement` and `conflicting-constraint` are errors, with both locations |
| The lock file no longer matches the requirements, so what is installed is not what was reviewed | `lock-mismatch` is an error with `--requirements` and `--lock` |
| A token inside an index URL (`https://user:token@host/simple`) is copied into a report, a job summary, a CSV file or a code scanning alert | User and password parts of every URL are replaced by `***` in every format, before any text reaches a report, and in error messages; the plain git user of `git+ssh://git@host` is kept. The config refuses URLs with credentials |
| An include such as `-r ../../../home/user/.netrc` or an absolute path makes the tool read a file outside the project and show its lines | Every include is resolved relative to the file that names it and must lie in the folder of the starting file or below it, both as written and after symbolic links are followed; anything else stops the run before the file is opened |
| An include by URL makes the tool a fetcher | Includes by URL are recorded and reported as `non-index-source`; the tool has no code that opens a connection. Addresses given on the command line are refused |
| Files that include each other loop forever, or a long chain of includes exhausts the stack | Every chain of includes is tracked; a cycle stops the run with the chain of files, and more than 50 nested includes stop it too. A file reached twice by different paths is read once |
| A name, a marker or a URL rewrites the terminal through escape sequences, or reorders text with direction characters | Control characters (C0 and C1), line and paragraph separators and Unicode direction controls are replaced by a space before any text reaches a report, and the length is capped |
| A marker or URL breaks the Markdown table in the job summary, or injects Markdown that hides a finding | Pipes, backslashes and line breaks are escaped in every table cell |
| A CSV report runs a formula when opened in a spreadsheet | Cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading `'`; every cell is quoted as RFC 4180 says |
| A lock file holds TOML that a loose reader would read differently from uv or Poetry, so a package is hidden or changed | The TOML reader accepts a strict subset, refuses duplicate keys and tables and anything outside the subset with the line, and never guesses |
| A lock file uses a key named `__proto__` or `constructor` to change how objects behave | Keys are stored as plain data without going through a prototype setter; tests check that no prototype changes |
| A huge file, very many lines or packages, or deeply nested values exhaust memory or time | Files over 50 MB stop the run before they are read; more than 100,000 requirement lines or locked packages stop it; values nested more than 64 deep stop it; every pattern is anchored and free of nested repetition |
| A config file with a typo (`"privatePackage"`, an ignore rule for a check that does not exist) quietly switches a check off | Unknown keys and unknown checks stop the run with exit code 2; every finding left out by an ignore rule is counted in a note |
| A requirement line pip would refuse is skipped, and the file passes | A line that cannot be read as a requirement or an option stops the run with its file and line |

## Out of scope

Known vulnerabilities in the pinned and locked versions, what a build backend or `setup.py` does, whether an index is trustworthy, dependencies declared only in `pyproject.toml`, and who may change the config file. docs/limits.md lists what a check of dependency files cannot see.
