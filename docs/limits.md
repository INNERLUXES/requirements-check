# Limits

## What a dependency file check cannot see

- **Known vulnerabilities.** The tool does not look up advisories. A package pinned to an exact version from the right index, with a sha256 hash, can still have a published vulnerability that lets an attacker into the application. Pair the check with `pip-audit`, GitHub's dependency alerts or another dependency scanner, which compare the pinned and locked versions with an advisory database. This tool answers where the code comes from and whether the installer can verify it; a scanner answers whether that code is known to be unsafe.
- **What a build backend does.** When pip or uv installs a source distribution, it runs the package's build backend, and for older packages its `setup.py`, on the build machine. The tool cannot see what that code does, or whether a wheel will be found instead of a source distribution. Prefer wheels (`--only-binary :all:` where the build allows it) and review packages that ship only source distributions.
- **What is inside a package.** A pinned, hashed package from the right index is exactly the file its author published, and that is all the hash proves. A hijacked maintainer account, a malicious new release that the team then pins, or a typo-squatted name with a valid hash all pass every check here. Review new dependencies and version changes in the pull request, and keep a scanner in the pipeline.
- **Whether an index is trustworthy.** The tool reports indexes that use http, extra indexes and trusted hosts; it cannot check that a private index is configured safely, that it does not proxy unknown names to the public index, or who can upload to it. Those are settings of the index itself.
- **Environment markers.** Markers are listed, not evaluated. The tool does not know which Python version or system the application runs on, so it checks every requirement whatever its marker says, and `lock-mismatch` does not report a requirement with a marker that is missing from the lock file.
- **Dependencies of dependencies in a requirements file.** A requirements file lists what it lists. If it was not written by pip-compile or a similar tool, the packages its requirements pull in are not in it, and the tool cannot check them. Lock the full tree (pip-compile, `uv lock`, `poetry lock`) and check the result.
- **The index's own state.** The tool never asks an index anything. It cannot see that a release was yanked, that a project changed owners, or that a newer version exists.

## Formats

- **The TOML subset.** Lock files are read with a small TOML reader that covers what `uv.lock` and `poetry.lock` use. Dates and times, hexadecimal, octal and binary numbers, `inf` and `nan`, and inline tables over several lines are refused with a clear error, not guessed. A lock file written by a future version of uv or Poetry with new TOML forms may be refused until the reader learns them.
- **pyproject.toml is not resolved.** Dependencies declared in `pyproject.toml` (`[project] dependencies`, `[tool.poetry.dependencies]`, dependency groups), `setup.cfg`, `setup.py` or `Pipfile` are not read. Check the lock file or the compiled requirements file that comes from them; `lock-mismatch` compares a requirements file with a lock file, not `pyproject.toml` with a lock file.
- **Other lock files.** `Pipfile.lock`, `pdm.lock` and Conda environment files are not supported.
- **Environment variables.** pip expands `${VARIABLE}` in requirements files; the tool reads the text as written. A URL built from a variable is checked as it appears, and its user part is masked like any other.
- **pip options.** Options that do not affect where packages come from or how they are pinned (`--pre`, `--prefer-binary`, `--only-binary`, `--no-binary`, `--use-feature`) are read and not checked. Unknown options are listed in a note. Per-requirement options other than `--hash` are not checked.

## Versions

The version rules follow PEP 440 for the operators listed in docs/method.md. The rule that leaves prereleases out of a specifier unless one is named is not applied when a pinned or locked version is compared, and the arbitrary equality operator `===` compares text. A version that is not PEP 440 is not compared with ordered operators; a note says so.

## Size

- A requirements file, lock file or config file over 50 MB stops the run before it is read.
- More than 100,000 requirement lines across a file and its includes, or more than 100,000 packages in a lock file, stop the run with exit code 2, rather than checking part of the input: a finding in the part left out would be missed.
- More than 50 nested `-r` / `-c` includes stop the run, and so does a cycle of includes.
- Values nested more than 64 deep in a lock file stop the run.
- At most `--limit` findings and packages (default 200) are shown; the counts, the gate and the total cover all of them.
- Text shown in a report is cut to a fixed length: 300 characters for a name, a version, a source or a path, 1,200 for a message.

Every limit is reported, as an error or a note, so a cut is never silent.
