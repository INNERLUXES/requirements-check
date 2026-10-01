# Contributing

Every change goes through a pull request and is reviewed before it is merged. The pipeline runs the tests on Linux, Windows and macOS, the repository checks, CodeQL, and a secure development check of the repository itself.

Commit messages in this repository follow Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `ci:`, with `!` for a breaking change.

## Changing a check

1. Describe the change in docs/method.md first: what the check reports, its severity, and why it matters for the supply chain of a Python web application, with the part of pip's documentation, the Python packaging standards (PEP 440, PEP 503, PEP 508) or NIST SP 800-218 it follows. Where the tool makes its own choice (what counts as a development file, when hash-checking mode is on, the private package rule), say so and say why.
2. Add a test with the requirements or lock file written inline, small enough that the result can be worked out by hand. Use made-up package names and hosts.
3. Text from the input goes through `safeText` before it reaches a finding or a note, so credentials in URLs are masked and control characters removed.
4. A finding id, once released, keeps its meaning: pipelines and code scanning read it from the JSON, CSV and SARIF reports.

## Changing the parsers

1. For the requirements parser, add a test for every form you add, written the way pip's documentation shows it, and one that pip would refuse.
2. For the version rules, add versions just inside and just outside each specifier, and a prerelease, a post release and a local version.
3. For the TOML reader, add the form to the subset only when a lock file uses it, with a test, and keep refusing everything else with the line. A form that cannot be read with certainty is refused; it is never guessed.
4. Keep every pattern anchored and free of nested repetition, and keep the length and depth limits.

## Rules for the code

- No runtime dependencies. Node 22 or newer and nothing else.
- The tool reads the files it is given, and the files they include inside the starting folder, and writes only to the screen. It opens no network connection, runs no program (no pip, no Python, no git, no build backend), and never follows a URL from an input.
- Source files stay ASCII; write any other character in a pattern as a `\u` escape.
- Never commit a real project's requirements or lock file, even as a fixture. Write small made-up files with names that start with `example-`, and never put a real token into a URL, even an expired one.

## Before you open the pull request

```
npm test
npm run check
npm run example
```
