## What and why

<!-- What this changes and why, in your own words. Link the issue it addresses: "Fixes #123". -->

## How it was verified

<!-- The test you added, or how you checked it by hand. UI changes need a screenshot. -->

## Checklist

- [ ] One logical change, with an imperative title ("Fix symlink check on macOS")
- [ ] Tests run from the package you changed (`bun --cwd packages/<name> test`) pass
- [ ] A change to permission handling adds a case under `test/permission/` or `test/tool/` that fails without it
- [ ] No unrelated formatting or refactors in the diff

<!-- Found a vulnerability? Do not describe it here. Report it privately: see SECURITY.md. -->
