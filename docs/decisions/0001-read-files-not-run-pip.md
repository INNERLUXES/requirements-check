# 1. Read the files, do not run pip

## Context

The tool needs to know, for every package a Python web application installs, which version it gets, where it comes from and whether the installer can verify it. There are richer ways to get that: run `pip install --dry-run --report` or `pip download` and read their output, run `uv pip compile` or `poetry show`, ask each index for its metadata, or download the files and look inside. Each of them means running pip or another installer, with the project's `pip.conf`, its index credentials, and possibly the build backend and `setup.py` of every source distribution, or opening many network connections from the build job, every time the check runs. The answers would change from day to day as the indexes change, so the same commit could pass today and fail tomorrow. And the check would need network access and the project's secrets in the one place where it is most useful: before `pip install`, when nothing from the dependency files should have run yet.

## Decision

The tool reads the requirements files, the files they include, the lock files and the config file as text, and nothing else. It never runs pip, Python, git or any other program, never fetches a URL from an input, and never asks an index anything. Everything it reports is a fact written in those files: the requirement, its specifier, its marker and its hashes, the options lines, the source, version and hashes of each locked package. Versions are compared by a small PEP 440 implementation inside the tool, and lock files are read by a small TOML reader inside the tool that refuses what it does not understand.

## Consequences

The check runs in a second, anywhere Node runs, with no network access and no credentials, before anything is installed, and the same files always give the same report, so it can gate a pull request that changes a dependency file. No input can make it run code or reach out to a host. The cost is that it knows only what is written down: it does not see known vulnerabilities, what a build backend does, the dependencies a requirement pulls in when they are not listed, or anything an index learned after the files were written. The README and docs/limits.md say so, and recommend `pip-audit` or a dependency scanner as a separate step.
