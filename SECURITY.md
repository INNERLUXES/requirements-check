# Security

## Reporting a problem

Write to info@innerluxes.dev with the subject line "requirements-check security", or use private vulnerability reporting on this repository. Please do not open a public issue for a vulnerability.

Include a small made-up requirements file or lock file (and the config, if it matters) that shows the problem, what you expected and what happened. Use made-up package names and hosts, and no real tokens, internal index addresses or customer data.

## Scope

In scope:

- an input that makes the tool open a network connection, run a program (pip, Python, git, a build backend), or read a file it was not given or that lies outside the folder of the file it was given
- an input that makes the tool hang, take very long, or use unbounded memory or stack, such as a cycle or a long chain of includes, a deeply nested lock file or a crafted version string
- a token or password in an index URL, a direct reference or a lock file that appears unmasked in any report format or error message
- text from a package name, a marker, a URL or a path that breaks a Markdown table, injects a formula into a CSV report, or rewrites the terminal through control or direction characters
- a lock file that the TOML reader reads differently from uv or Poetry, so a package or a source is hidden or changed
- a config file with a mistake that is silently ignored, so a run passes with a check switched off
- a requirement or package reported as clean when the rule in docs/method.md says it should be reported, such as an unpinned requirement, a git or http source, an extra index or a missing hash in hash-checking mode

Out of scope: known vulnerabilities in packages, what a build backend or `setup.py` does, dependencies declared only in `pyproject.toml`, and lock files of other tools (docs/limits.md lists what a dependency file check cannot see).

Read [docs/threat-model.md](docs/threat-model.md) for the rest.
