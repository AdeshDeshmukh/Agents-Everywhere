## Problem and related issue

<!-- Explain the problem and who it affects. Link the agreed issue with "Fixes #123" when this PR resolves it, or "Refs #123" for partial work. -->

## Changes

<!-- Describe the approach and resulting behavior. Include a before/after example when helpful. -->

## How it was verified

<!-- List the exact commands you ran and their results, plus manual checks where relevant. Run tests from package directories. Mark checks you did not run and explain why. Include screenshots for UI changes, with credentials and private data removed. -->

## Compatibility and follow-up

<!-- Mention config changes, database migrations, protocol/API changes or remaining work. Write "None" if this does not apply. -->

## Permission and deployment impact

<!-- If applicable, describe changes to grants, denies, approvals, credentials, install commands or deployment behavior. Explain which sample configuration or workflow you verified. Write "None" otherwise. Report suspected vulnerabilities privately through SECURITY.md instead of this public PR. -->

## Checklist

- [ ] One logical change, with an imperative title ("Fix symlink check on macOS")
- [ ] Relevant package tests and typechecks are recorded above, with unrun checks identified
- [ ] Permission changes include a regression case under `test/permission/` or `test/tool/`, or this does not apply
- [ ] Public Protocol or Server HttpApi changes regenerate the client with `bun run generate` from `packages/client`, or this does not apply
- [ ] Changed user-facing behavior is documented, or this does not apply
- [ ] No unrelated formatting or refactors in the diff
- [ ] No credentials or private data in the diff, logs or screenshots

<!-- Found a vulnerability? Do not describe it here. Report it privately: see SECURITY.md. -->
