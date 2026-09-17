# Deprecate `@noriq-dev/runner` on npm

Requires npm account access for the `@noriq-dev` scope (trusted publishing owner). **Do not**
run from CI without credentials — execute locally or in a one-off authenticated session.

## Recommended message

```bash
npm deprecate @noriq-dev/runner@0.19.1 \
  "Noriq Runner is archived. Use external coding agents (Cursor, Claude Code, Codex) with Noriq MCP coordination only. Repo: https://github.com/noriq-dev/runner"
```

To deprecate **all** published versions (if multiple exist on the registry):

```bash
npm deprecate @noriq-dev/runner \
  "Noriq Runner is archived. Use external coding agents with Noriq MCP coordination only. Repo: https://github.com/noriq-dev/runner"
```

## Verify

```bash
npm view @noriq-dev/runner deprecated
npm view @noriq-dev/runner version
```

## Optional final git tag (if not already on GitHub)

From a clean checkout at `package.json` version **0.19.1**:

```bash
git tag -a v0.19.1 -m "Final Noriq Runner release before archive"
git push origin v0.19.1
```

Skip if `v0.19.1` already exists on the remote.
