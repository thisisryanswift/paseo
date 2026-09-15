# Upgrading Reef's Paseo/OpenCode stack

Use this guide to move the Reef host, Paseo fork checkout, or supervised
OpenCode server to a reviewed version after a human checkpoint and explicit
upgrade decision.

## What is running

OpenCode runs as `opencode-serve.service`. Its selected service binary is the
`/usr/local/libexec/opencode/active` symlink, currently targeting
`opencode-1.18.30`. This is the service binary selection, not a client link.
The service listens on `100.81.54.26:4096`; its configuration and state are
under `/home/opencode/.config/opencode` and `/home/opencode/.local/share/opencode`.
Paseo's home is `/home/paseo/.paseo` (config, state, pid, and logs); its health
endpoint is `http://100.81.54.26:6767/api/health`, not loopback.

The unit has existing command-line, environment, authentication, and CORS
settings. Preserve the complete unit and all of those settings when changing
the selected binary. Do not recreate `opencode-serve.service` from an
abbreviated command in this document. The `opencode-reef` wrapper connects to
the server. A local TUI update need not change the service, and vice versa. An
OpenCode-only update can break the SDK, API, event, permission, mode,
review-tool, or native-Task contract; test the pair when any of these change.

## Upgrade rules

- Record the current committed Paseo checkout and installed OpenCode binary as
  one known-good pair. Back up private config/state from the owning service
  identity using the host's ordinary backup/recovery process. Preserve the
  service unit, environment, auth, uploads, and checks. Do not copy credentials
  into Git or fixtures.
- Stop or pause agent work at the checkpoint. After checkpoint clearance, stop
  Paseo before changing production code or dependencies and before backing up
  durable state. Keep credentials out of Git and fixtures.
- Use the existing `machine upgrade` command, not a second upgrader. It updates
  Homebrew, may change Node and native dependencies, selects the Homebrew
  OpenCode version through the existing versioned mechanism, and may restart
  both services. It is not a command that accepts an arbitrary tested-version
  argument. Its internal helper functions are not standalone CLI commands.
  Its read-only source is
  `/srv/dev/dotfiles/dot_local/bin/executable_machine`; an installed copy is
  unverified. The source copies
  `/home/linuxbrew/.linuxbrew/opt/opencode/bin/opencode` to a root-owned
  versioned directory, rolls back on OpenCode readiness failure, and checks
  Paseo at `100.81.54.26:6767/api/health`.
- A binary-only rollback is not a guarantee after state migration. Keep an
  explicit state-migration rollback limit.

## Select and prepare a candidate

The source baseline is fork branch `ryan/opencode-reef-inbox` at
`51a680cefcc28a8656d79f8096251eb0723815b9`, with the reviewed 44-path custom
continuity/server-URL work and seven earlier Reef custom commits. `origin` is
`https://github.com/getpaseo/paseo.git`; `fork` is
`https://github.com/thisisryanswift/paseo.git`. This branch is authoritative;
old W3 donor worktrees are historical pre-hotfix material.

When authorized, fetch refs/tags and inspect the selected release/commit against
this branch. Do not rely on cached ref counts or stale remote refs. Choose a
reviewed tag/commit, not blind `latest`; record the tested pair without a
forever-pin promise:

```bash
git fetch origin --tags
git fetch fork --tags
```

Use a new branch/worktree so the published branch is not rewritten. Replace
every `REPLACE_ME` value below with the reviewed value before execution. These
assignments are examples, not ready-to-run production values. The merge is
intentional: the candidate starts from the published fork branch and merges the
selected upstream ref, so the validated candidate contains the published fork
and can be deployed by fast-forward.

```bash
REPO="/srv/dev/tools/paseo-next"
UPGRADE_DIR="/srv/dev/paseo-upgrade-REPLACE_ME"
UPGRADE_BRANCH="upgrade/REPLACE_ME"
UPSTREAM_REF="refs/tags/REPLACE_ME"

git -C "$REPO" worktree add -b "$UPGRADE_BRANCH" "$UPGRADE_DIR" ryan/opencode-reef-inbox
git -C "$UPGRADE_DIR" merge "$UPSTREAM_REF"
```

For a release, `UPSTREAM_REF` is a complete tag ref such as
`refs/tags/REPLACE_ME`. `origin/BRANCH` and a full commit SHA are also valid
complete values. Do not prefix a tag or commit hash with `origin/`.

Run every npm command in the candidate worktree. The candidate must contain the
current branch. Review provider configuration, external attachment, native
history, permissions, terminal behavior, custom TypeScript review tooling, and
native Task contracts. Do not use the old rollout bundle or its 43-file copy
setup. Do not casually rebase: history rewriting is a separately approved
workflow.

## Dependencies and build

Resolve the target's Node requirement first. Reef uses Homebrew Node `26.8.2`,
and Homebrew can change it with OpenCode. Check native dependency compatibility
and rebuild locked dependencies as needed.

A fresh upgrade worktree always needs `npm ci` from its lockfile, even when the
lockfile did not change. A Node ABI change can also require reinstalling
dependencies. The following npm commands run from `UPGRADE_DIR` through
`--prefix`; do not run them in the running checkout:

```bash
npm --prefix "$UPGRADE_DIR" ci
umask 022 && npm --prefix "$UPGRADE_DIR" run build:server
```

Build validated source with `umask 022` so outputs are readable by Paseo. After
a code update, deployment always rebuilds; a prior candidate build does not
replace that deployment build.

Before deployment, run focused server tests, starting with `config.test.ts` and
`external-opencode-pilot.test.ts`; add affected recovery, history, attachment,
or permission files as needed. These commands also run in `UPGRADE_DIR`:

```bash
CONFIG_TEST_FILE="src/server/config.test.ts"
PILOT_TEST_FILE="src/server/agent/external-opencode-pilot.test.ts"
ROOT_CONFIG_TEST_FILE="packages/server/src/server/config.test.ts"
ROOT_PILOT_TEST_FILE="packages/server/src/server/agent/external-opencode-pilot.test.ts"
ROOT_SOURCE_FILE="packages/server/src/server/config.ts"

npm --prefix "$UPGRADE_DIR" run test:unit --workspace=@getpaseo/server -- "$CONFIG_TEST_FILE" "$PILOT_TEST_FILE" --bail=1 --maxWorkers=1
npm --prefix "$UPGRADE_DIR" run typecheck --workspace=@getpaseo/server
npm --prefix "$UPGRADE_DIR" run lint -- "$ROOT_SOURCE_FILE"
npm --prefix "$UPGRADE_DIR" run format:check -- "$ROOT_CONFIG_TEST_FILE" "$ROOT_PILOT_TEST_FILE" "$ROOT_SOURCE_FILE"
```

Replace the test and source variables with the smallest existing tests and
source files for the changed contract before execution. Do not run the whole
suite locally or add paid-model tests without authority. Use existing scripts
and targeted CI for broader coverage.

## Preserve the Reef configuration boundary

Before and after a version change, verify that `agents.providers.opencode`
carries the configured `serverUrl` and that auth reaches provider settings
through `loadConfig`. Do not print or copy auth values.

Preserve `agents.externalOpenCodeAdoption`, including cutoff
`2026-09-14T12:45:32Z` (historical initial activation), exact approved absolute
roots and explicit exclusions, `classificationMode: reserved-role-pilot`, and
coordinator and worker allowlists. An ordinary upgrade must not generate a new
cutoff or replay initial adoption. See [External OpenCode Server Design](external-opencode-server-design.md)
for the full discovery, role, endpoint, and send policy.

Keep `/srv/paseo/uploads` and its existing ACLs. Do not broad-sync the whole
repository, broadly `chown` files, or perform an unreviewed state migration.
Preserve private OpenCode configuration/state and Paseo durable state before a
new version can migrate them. Use the ordinary backup and recovery procedure;
do not create a new journal or installer for an upgrade.

## OpenCode-specific validation

OpenCode `1.18.30` is the last validated baseline, not a permanent requirement.
Before checkpoint clearance, run only disposable validation runs: test the
candidate binary and configuration, plus the native roles and custom tools, in
disposable state. Do not copy live authentication into that state. Do not run
`machine upgrade`, deploy, or use service controls before clearance. After
clearance, pause agent work and back up private OpenCode state/config and Paseo
durable state before using `machine upgrade`, deployment, or service controls;
use the existing versioned deployment mechanism only then. `machine upgrade`
selects the Homebrew version; it may also change Node and restart both services,
so do not imply that it installs an arbitrary version named in a test record.

Check OpenCode's loaded registry for these reviewed entries:

1. `aw-coordinator` with Astra.
2. `aw-implement` with Luna at high effort.
3. `review` and `tests` with their reviewed pins.
4. `browser` with Luna at max effort and `80`.

`aw-luna-leaf` is a per-invocation CLI primary profile. It is not a native
Task/menu target and must not be checked or documented as one. Stock Android
`0.8` is the last tested app baseline, not a forever-required version.

## Deploy after the checkpoint

Deploy only a checked candidate containing the current branch. After the
checkpoint is cleared, stop Paseo, use ordinary backup/recovery to preserve
private configuration and durable state, then fast-forward the runtime checkout
to the exact validated candidate. Do not reset a mixed worktree or overwrite
work created after the checkpoint.

The merge and deployment commands below use `git -C`; replace each
`REPLACE_ME` value before execution. The npm commands run in `PASEO_DIR`, the
runtime checkout:

```bash
PASEO_DIR="/srv/dev/tools/paseo-next"
VALIDATED_UPGRADE_COMMIT="REPLACE_ME"

sudo systemctl --user --machine=paseo@.host stop paseo.service

git -C "$PASEO_DIR" merge --ff-only "$VALIDATED_UPGRADE_COMMIT"

# Run this when the validated lockfile or Node ABI requires matching dependencies.
npm --prefix "$PASEO_DIR" ci

# Always rebuild after the code update, including when npm ci was not needed.
umask 022 && npm --prefix "$PASEO_DIR" run build:server

sudo systemctl --user --machine=paseo@.host start paseo.service
```

Install matching dependencies when the lockfile or Node ABI requires it, and
always rebuild with `umask 022` after a code update. Start or restart the
affected service using the existing service/versioned deployment mechanism.
For Paseo, the stop/start controls are shown above; use this restart control
when a restart is appropriate:

```bash
sudo systemctl --user --machine=paseo@.host restart paseo.service
```

Use the equivalent existing OpenCode service control only when upgrading
OpenCode. Do not recreate its unit or drop its environment and CORS flags. Do
not restart the main daemon as a troubleshooting reflex; it controls agents.

## Readiness is not integration

The source `machine upgrade` readiness probe requests exactly
`http://100.81.54.26:4096/global/health` without authentication. It accepts an
HTTP `401` as a readiness signal; that is not an authenticated response. It does
not use another OpenCode health path. Paseo's provider health checks remain
separately authenticated according to its configured provider settings. Check
Paseo at the actual endpoint:

```bash
if curl --fail --silent --show-error --max-time 10 http://100.81.54.26:6767/api/health; then
  printf '%s\n' "Paseo health probe succeeded"
else
  printf '%s\n' "Paseo health probe failed" >&2
fi
```

Use a conditional shell path over SSH so a failed probe does not trigger an
interactive `set -e` exit. An active supervisor unit is not proof of readiness;
PID metadata must identify the actual listening address. Correlate new errors
with the latest restart; old log entries do not prove a new failure.

After both services are ready, validate the integration path:

1. Confirm the loaded registry has `aw-coordinator` (Astra), `aw-implement`
   (Luna/high), `review`, `tests`, and `browser` (Luna/max, `80`). Confirm
   `aw-luna-leaf` is used only as a per-invocation CLI primary profile, not as a
   native Task/menu target.
2. Run one small native job or review and inspect its result.
3. Start a new `aw-coordinator` session in an approved root and confirm it
   appears in Paseo discovery.
4. Exercise phone-to-terminal and terminal-to-phone exchange using stock
   Android `0.8`, which was used for the last verification. Treat it as a
   tested baseline rather than a permanent version requirement.
5. Exercise harmless attachment, permission, and Stop-while-busy paths when
   the candidate changes those surfaces.
6. Record the tested Paseo commit, OpenCode binary version, app version, and
   result. Health responses alone are insufficient evidence of integration.

The protocol is intended to remain backward-compatible, but new features are
capability-gated and may require a newer daemon or app. See
[Protocol Compatibility](protocol-compatibility.md) before treating an app
update as proof that an older host supports the feature.

Use [Architecture](architecture.md) for system boundaries and
[Testing](testing.md) for the repository's test-value and test-scope rules.

## Recovery

If candidate checks fail, do not deploy the candidate. If a deployed candidate
fails, stop at a human checkpoint, retain evidence, and restore the recorded
compatible set: Paseo commit, locked dependencies and build outputs, selected
OpenCode binary, and compatible Node environment. Use the existing versioned
binary mechanism. If the known-good version or state cannot be restored, stop
and escalate. A binary-only rollback is not a guarantee after state migration.
Restore private config or durable state only as required by the observed
migration boundary, using the ordinary backup/recovery process.

Prefer the retained known-good worktree or a fresh rebuild from its recorded
commit. Never use `git reset --hard`, force-push the published branch, or mix a
rollback with post-upgrade user work. A successful health check after rollback
does not establish that every native session or attachment is intact; repeat
the focused integration checks and record the version pair again.
