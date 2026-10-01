## What changes

<!-- One or two sentences. -->

## Checks

- [ ] `npm test`, `npm run check` and `npm run example` pass
- [ ] A change to a check, the requirements parser, the version rules or the TOML reader is described in docs/method.md, and has a test with the file written inline
- [ ] Text from the input goes through `safeText`, so credentials in URLs are masked; the tool still runs no pip or Python, fetches nothing, opens no connection and reads no file outside the starting folder
- [ ] No real project's requirements or lock file and no real token in fixtures or examples
- [ ] The commit messages of this pull request follow Conventional Commits
