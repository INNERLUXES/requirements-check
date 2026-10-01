# Secure defaults

The default run is the safe run. Nothing below needs a flag, and none of it can be switched off.

## How the tool behaves by default

- **No network.** The tool reads the files it is given and sends nothing anywhere. It does not ask an index about a package, does not resolve host names, does not follow a URL from a requirements file, does not download a file named with `-r https://...`, does not clone a git dependency, and does not check for updates. An address given where a file is expected is refused. It can run in a locked-down build job with no outbound access at all, before anything has been installed.
- **No pip, no Python, no commands.** The tool never runs pip, uv, Poetry, Python, git, a shell, a build backend or a `setup.py`. It reads requirements files as text and lock files as data. No name, version, path, marker or URL from the input is ever put on a command line.
- **No dependencies.** Node 22 or newer and nothing else, so a check of the supply chain does not add a supply chain of its own. There is no `node_modules` to install before it runs.
- **Pins are required.** Without a config, every requirement in a file that is not named like a development file must carry an exact `==` or `===` pin, or the run fails. A file only counts as a development file by its name, and the list of names is short and documented.
- **No direct references by default.** Without a config, every git, archive URL, local path and editable requirement is an error, and so is every requirements file included by URL. Accepting one is a line in a reviewed file, and it is a prefix that must end with `/` for URLs, so a look-alike host cannot match it.
- **Encryption is required.** Every `http://`, `ftp://`, `git://` and `svn://` index, find-links location, download or include is an error, whatever the config says. `--trusted-host` is always reported.
- **Hash-checking mode is honoured.** When a file asks for hashes, through `--require-hashes` or any `--hash`, every requirement without one is an error, so the run fails in the pipeline at the same line where pip would fail, with a message that says which line to fix.
- **Extra indexes are always visible.** Every `--extra-index-url` is reported, and every lock file that mixes indexes, with a plain explanation of dependency confusion. There is no setting that hides an extra index except an explicit, counted ignore rule.
- **Credentials never reach a report.** A user name and password (or token) in a URL are replaced by `***` before any text is shown, in all five formats and in error messages, so a report can be pasted into a pull request, a job summary or a code scanning alert without leaking the token a developer put into an index URL. The config file refuses URLs with credentials, so a token cannot be copied there either.
- **Reads stay inside the project.** An include is resolved relative to the file that names it and must lie in the folder of the file named on the command line, or below it, as written and after symbolic links are followed. `-r ../../secrets.txt` or an absolute path elsewhere stops the run before the file is opened.
- **Bounded input.** A file over 50 MB stops the run before it is read, and so do more than 100,000 requirement lines or locked packages, more than 50 nested includes, a cycle of includes, and values nested more than 64 deep in a lock file.
- **Strict parsing.** A requirement line pip could not read, a malformed `--hash`, a version that is not PEP 440 inside a specifier, or a lock file outside the TOML subset stops the run with the file and line, instead of a report that skipped the part it did not understand. Duplicate keys and tables in a lock file are refused, so two readers cannot see two different packages.
- **Clean output.** Text from the input has control characters, line separators and direction controls removed and its length capped before it reaches a report, so a hostile name or marker cannot rewrite the terminal or reorder what a reviewer reads. Markdown cells escape pipes, backslashes and line breaks. CSV cells are quoted as RFC 4180 says, and a cell that a spreadsheet would read as a formula gets a leading `'`. No report renders a name as a link.
- **Strict configuration.** The config file is checked before any input is read. An unknown key (a typo such as `"privatePackage"` or `"allowDirects"`), a list that is not a list of strings, or an ignore rule for a check that does not exist stops the run with exit code 2 and the reason, instead of a run that passes because the rule it meant to set was ignored.
- **Ignore rules are visible.** Every finding left out by an ignore rule is counted, and the report says how many, so an ignore list cannot grow without anyone seeing it.
- **Unknown forms are not guessed.** An option the tool does not know is listed in a note. A version that is not PEP 440 is compared only by exact text, and otherwise named in a note; it is never counted as a match.
- **Fails closed.** A missing option, a missing file or include, a file that cannot be read, a file over a limit or an input the tool cannot parse stops the run with exit code 2 and the reason, instead of a clean report about part of the input.
- **The gate is on.** Without any option, an error makes the run exit with `1`: an unpinned requirement, a direct reference, an http index or download, a missing hash in hash-checking mode, a duplicate or conflicting pin, or a lock file out of step. A pipeline that adds the tool is protected from the first run; there is no report-only mode to forget to turn off.
- **Writes nothing to disk.** The report goes to the screen. Redirect it to a file, the job summary or a SARIF upload only when you need to keep it.

## Running it in a pipeline safely

1. Run the check before `pip install`, `uv sync` or `poetry install`, in the same job, on the files of the commit being built. A requirements file that brings in a git dependency, an http index or a second index is then stopped before anything from it is downloaded, built or imported on the build machine.
2. Run the check with read access to the repository and nothing else: no index credentials, no deploy keys, no cloud credentials. It needs none. Give the later install and deploy steps their secrets, not the check.
3. Use the tool from a pinned commit. `npx --yes github:INNERLUXES/requirements-check#<commit>` runs exactly the code that was reviewed, not whatever the default branch holds on the day.
4. Check every file the build installs from: the production requirements file, the files it includes (they are followed automatically), every service's own requirements file in a monorepo, and the lock file.
5. Pass the requirements file and the lock file together with `--requirements` and `--lock` when the build uses both, so a lock file that has fallen behind is caught.
6. Keep the config file in the repository, next to the files it applies to, and protect it with CODEOWNERS. A pull request that adds a prefix to `allowDirect`, removes a private package name or adds an ignore rule is a decision to trust new code on the build machine, and should be reviewed by someone who can make it.
7. Keep the default `--fail-on error`. Add `--fail-on warning` once the files are clean, so that a new extra index, a trusted host or a weak hash stops a merge too.
8. Add `--want-hashes` once the files have hashes, so that a new requirement added without one is reported even before `--require-hashes` is set.
9. Write the SARIF report and upload it to code scanning, or the Markdown report to the job summary, so the reviewer sees the findings next to the change, and keep the exit code as the gate.
10. Run the check on every pull request, not only before a release. The pull request that adds a dependency is the cheapest place to ask where it comes from and whether it is pinned.
11. Keep `pip-audit` or a dependency scanner in the same pipeline. This tool says where packages come from and how they are pinned; a scanner says whether they have known vulnerabilities. Neither replaces the other.

## Writing a config the tool can check well

1. Start without a config. Run the tool on the current files, read every finding, and fix what can be fixed (pin, add hashes, move git dependencies to your index, switch indexes to https) before you allow anything.
2. Name your private packages in `privatePackages`, with a pattern if they share a prefix (`example-orders-*`). Then a private package that could be served by a second index, or that a lock file took from the public index, is an error rather than a quiet substitution.
3. Keep `allowDirect` empty if you can. If a git dependency is needed, publish it to your private index instead; if that is not possible, add only the organisation or host your team controls, end the prefix with `/`, and pin the reference to a full commit hash.
4. Keep vendored packages in one folder and allow that folder only (`./vendor/`), so a new local path elsewhere is still reported.
5. Use `devPatterns` only for files that never reach production. A pattern that matches the production file turns every missing pin there into a warning.
6. Use `ignore` for findings you have decided to live with, with a `reason` the next reader can understand, and narrow each rule to a check and a package. A rule with only a check turns that check off for every file.
7. Review the config like code. Every line in it is a decision to trust something, and each line should name who decided and why, in the commit message or the pull request.
8. Remove lines that are no longer needed. An allowed prefix for a dependency that is gone, or an ignore rule for a package that was replaced, widens what the next change can bring in without a finding.

## Keeping the dependency files of a Python web application healthy

The tool tells you what is wrong with the files; these are the usual ways to keep them right, in the order they tend to pay off.

1. **Lock the full tree.** Keep the direct requirements in `requirements.in` or `pyproject.toml`, and install from a file that lists every package with an exact version: the output of `pip-compile --generate-hashes`, `uv lock` or `poetry lock`. Commit it, and change it only by running the tool that writes it.
2. **Install with hashes.** Install with `pip install --require-hashes -r requirements.txt`, `uv sync --frozen` or `poetry install --sync`, so the installer refuses a file whose hash does not match and never resolves versions on the build server.
3. **Install from one index.** Point pip at one index (`--index-url`, or `index-url` in `pip.conf`) that serves both your private packages and a mirror of the public ones, instead of adding `--extra-index-url`. If you must use two, give every package a hash, and name private packages so they cannot exist on the public index.
4. **Keep credentials out of the files.** Give index credentials to pip through a `.netrc` file, a keyring or environment variables read by `pip.conf`, never in the URL inside a committed file. If a token shows up in a requirements or lock file, rotate it.
5. **Use https everywhere.** No `http://` index, no `--trusted-host`. An index that only serves http should be fixed or put behind a proxy that serves https with a valid certificate.
6. **Prefer released packages over direct references.** A release on an index is immutable and hashed; a git reference is neither. Publish internal packages to the private index rather than installing them from a repository or a folder.
7. **Prefer wheels.** A wheel installs without running the package's build; a source distribution runs its build backend on the build machine. `--only-binary :all:` makes pip refuse source distributions where the application allows it.
8. **Keep one source of truth per package.** One pin per package across all included files, constraints that match the pins, and a lock file locked again after every change to the requirements.
9. **Separate development tools.** Keep test, lint and build tools in their own requirements file or dependency group, so they never reach the production image, and pin them too: they run in CI, often with more secrets than production.
10. **Review the diff of the lock file.** For a dependency change, read the summary this tool prints and the list of added and changed packages, not every line of the file.

## Sharing a report safely

1. A report shows package names, versions, sources, index URLs and file paths from the inputs. For an open-source project that is public anyway. For a private application it can show the names of internal packages, the host of the private index and the names of internal git repositories: share it with the people who can see the code.
2. Credentials in URLs are always masked. Anything else that was written into a URL (an internal path, a branch name, a query string) is shown as it is.
3. A SARIF upload makes the findings visible to everyone who can see the repository's code scanning alerts. Use the Markdown or text report when the audience should be smaller.
