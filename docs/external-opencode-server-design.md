# External OpenCode Server Design

## Goal

Allow Paseo to use an independently supervised OpenCode server while preserving direct native OpenCode access. The initial deployment runs both services on Reef, exposes both through Tailscale, and uses OpenCode HTTP Basic authentication.

## Configuration

The OpenCode provider accepts an optional HTTP(S) `serverUrl`. When present, Paseo attaches to that server instead of spawning or rotating `opencode serve`.

Authentication uses the provider's existing environment configuration:

- `OPENCODE_SERVER_PASSWORD` enables HTTP Basic authentication.
- `OPENCODE_SERVER_USERNAME` overrides the username.
- The username defaults to `opencode` when a password is present.

Paseo must apply the same credentials to health checks, generated SDK requests, and the global SSE event stream. Credentials must not appear in URLs or logs.

## Server Ownership

An external OpenCode server is independently owned. Paseo must not spawn, rotate, terminate, or dispose it.

Closing a Paseo adapter attached to an external server detaches its event stream and releases local resources. It does not abort, archive, or delete the upstream OpenCode session. Explicit user actions that archive or delete an agent may still mutate the corresponding upstream session through their existing operation-specific paths.

Managed OpenCode servers retain their current lifecycle and close behavior.

## Session Identity

Paseo and OpenCode must see the same absolute workspace paths. Cross-host path mapping is outside this design because both services are colocated on Reef.

Persisted OpenCode handles must identify the external endpoint sufficiently to prevent silently resuming a session against a different server. A mismatch should return an actionable error rather than creating or controlling an unrelated session.

## Observation and handoff

An SSE disconnect does not mean the independently owned turn failed. The provider reconnects with bounded backoff and a first-record/heartbeat watchdog, using the same authenticated SDK client. Reconnection reconciles runner status and pending requests. Initial attachment also loads pending requests; native replies and rejections remove them across clients.

Native transcripts have no durable SSE cursor. External adapters expose the manager integration contract in `packages/server/src/server/agent/providers/opencode/native-history.ts`. The registry preserves those hooks, and the manager registers history and request sinks before the ordinary subscription. Attachment replays any already-active native turn's existing identity before permissions; the manager processes that activity before publishing ready state. This covers busy/retry events received while mode discovery is still initializing, without creating another turn or replaying one that already ended. This path bypasses legacy history priming even for an already-primed retained timeline. Managed OpenCode sessions keep their event-accumulated run-result stream; snapshot observation is an external-session capability, separate from local admission fencing.

History snapshots replace the root transcript, including partial and externally initiated turns. The manager commits one new timeline epoch and the client Session publishes a bounded projected tail through the existing `fetch_agent_timeline_response` protocol. The existing client reducer atomically installs it, including an empty replacement; older rows remain available by backward pagination. Selective subscribers receive updates only for their viewed agents. Unacknowledged local presentations survive independently of native history. Exact client/native IDs reconcile acknowledgement while retaining local presentation content; acknowledged rows omitted by a native revert do not reappear. Transient native retry/error rows without persisted history are not transcript authority.

Reads run serially per session; changes during a read trigger another snapshot without duplicate root deltas. Intermediate snapshots prevent continuous output from starving the display. Identical snapshots do not replace history. A failed read or sink commit keeps the previous timeline and retries. The manager checks adapter identity and the sink abort signal at commit, and revokes observation before draining during close. Provider reads run outside the manager event lane; a sink must not wait on a provider operation from that same lane.

Optional durable timeline stores must support guarded atomic replacement, never delete-then-insert. Every manager-owned append, bulk insert, acknowledgement update, replacement and deletion shares one per-agent durable commit lane. Detach releases the sink wait, but the lane remains held until the actual store mutation promise settles. A successful commit advances the lane's durable layout version and reconciles retained history using the original cold presentation seed, even if the consumer detached. Queued local presentation writes rebase by client identity against actual committed rows; a stale memory epoch cannot authorize an overwrite or silently discard a late presentation. Native acknowledgement metadata is retained, and omitted acknowledged history is not resurrected. Current adapter/abort checks govern client publication separately from internal committed truth. Public committed-row reads wait for prior writes; replacement and rebasing use raw store reads inside their own lane to avoid waiting on themselves. These stores are distinct from the file-backed agent-handle registry. Full native history is still read on each coalesced refresh; measure large-conversation cost before activation.

Pending-list absence proves that a request ended, but does not reveal its answer. The request sink reconciles membership without inventing allow/deny decisions; actual native replies retain their action or question answers. Native selection changes update the persisted model, agent mode and resume handle. History replay retains native file/image URLs, including inline image data, in the existing text-only user-message format. Shared-path readability and Android rendering remain live attachment gates.

## Session Catalog

OpenCode remains the durable source of truth for native sessions and transcripts. Paseo's Sessions screen is the operational inbox for the configured built-in `opencode` provider: it reads recent, non-imported root sessions and displays them as **Available in OpenCode** alongside Paseo's own history. Custom providers that extend `opencode` are not included in this inbox.

Catalog rows are read-through data. Listing them must not create Paseo agents, workspaces, or event subscriptions. Opening a row lazily imports the native handle through the existing provider import path and navigates to the resulting Paseo agent. The provider listing already excludes sessions with an active Paseo record, so an opened session moves from the read-through section into normal Paseo history without duplicate rows.

The catalog follows the selected host and refreshes when the Sessions screen mounts or the user pulls to refresh. Provider rows stay out of history search because they do not carry the indexed transcript data needed to produce complete search results. An unavailable, incompatible, or failed host must be identified explicitly rather than presented as an empty catalog.

## Architecture

External mode uses an implementation of the current `OpenCodeServerManagerLike` contract. Every acquisition method returns the normalized configured server and a no-op release. Shutdown is a no-op. Existing managed-server behavior remains isolated in `OpenCodeServerManager`.

The OpenCode client constructor selects the external manager when `serverUrl` is configured. Availability probes `<serverUrl>/global/health` with a bounded timeout and validates a successful OpenCode health response.

### Automatic coordinator discovery

`agents.externalOpenCodeAdoption` is an opt-in daemon setting for the built-in external `opencode`
provider. Omit it, or set `enabled: false`, to disable discovery. Discovery creates ordinary closed,
resumable Paseo records; it does not require a new client RPC. Opening a discovered record hydrates
the native conversation through normal resume.

The active classification is `reserved-role-pilot`. Configure a real ISO UTC `activatedAt` cutoff and
exact absolute `roots`; sessions qualify only when their native creation time is after the cutoff and
their canonical `cwd` exactly matches an approved root. Register each approved worktree separately.
`workspaceId` may resolve same-cwd placement, and `pollIntervalMs` defaults to 15 seconds.

The pilot uses `coordinatorAgentNames: ["aw-coordinator"]` and
`workerAgentNames: ["aw-implement", "aw-integrate", "aw-luna-leaf", "aw-research", "review", "tests", "browser"]`.
The lists must be nonempty and disjoint. A session must have a meaningful nonsynthetic first user
message, and its first-user role, current mode, and observed agent roles must all be coordinator
roles. Native children, archived or empty sessions, pre-cutoff sessions, unapproved paths, explicit
exclusions, worker roles, and unknown or mixed roles are excluded. Configured worker or exclusion
records win when an `enrollmentDirectory` is supplied. Role names provide trusted-workflow
classification; they do not authenticate human or TUI origin.

The retained W3 worktree is a historical input source for this consolidation. It remains untouched
until a later sync and is not deployable truth; the reviewed source in this checkout is authoritative.

Strict `file-enrollment` remains the default outside the pilot. It requires authoritative enrollment
for the exact endpoint and native ID, canonical `cwd`, and meaningful native activity. Enrollment
events are immutable, endpoint-scoped records; worker and exclusion events take precedence, and
conflicting, missing, unreadable, or malformed authority fails closed. The pilot does not require a
TUI-origin producer, but it still honors configured negative enrollment records.

The provider's `listExternalOpenCodeSessions` read-only port supplies native IDs, archive state,
roles, model/mode, and the first meaningful user turn. It fails explicitly on upstream,
pagination, or message-scan errors; the daemon never substitutes an unclassified catalog.

The daemon persists endpoint-scoped cutoffs and adoption/exclusion tombstones in
`$PASEO_HOME/external-opencode-adoption.json`. Immutable enrollment evidence remains in the
configured `enrollmentDirectory` and is not copied into adoption state. Existing native mappings win
before workspace allocation; exact-cwd placement is reused, while ambiguous or archived-only
placement fails without restoring anything. Adoption state is committed atomically, and recovery
validates the recorded workspace and project.

Automatic discovery only writes local records. It never resumes a runtime, prompts a model,
answers a permission, or invokes native archive/unarchive operations. Existing serialized manual
import remains the explicit restore path.

### Pilot send boundaries

The pilot targets installed OpenCode 1.18.30 and stock Android 0.8. External sends use the existing
compatible paths; managed and non-OpenCode providers retain their behavior.

New pilot-adopted records persist `externalOpenCodePilot: true` in their Paseo resume-handle metadata.
An explicit daemon-side `AgentSessionConfig.externalOpenCodePilot` also selects that local policy.
Ordinary pilot sends to an observed busy or locally preparing session reject visibly before any
replacement/abort, mode mutation or false acceptance. A final provider idle/status-revision check
catches activity discovered during preparation. Explicit Stop and permission/question replies retain
their control paths. Nonpilot legacy replacement behavior remains separate.

Use **one input client at a time**. The native status-check → POST interval still races another
terminal or API writer. A refusal is not a queued acceptance, and an accepted send is not a global
ordering reservation. Paseo stores no durable prompt queue or automatic resubmission loop. Existing
native terminal behavior is unchanged.

External dispatch waits for provider admission before reporting acceptance to the stock client or MCP
caller. Its local prompt handle observes permissions and terminal outcome for that native input. The
observation is a local presentation aid, not a new native wire or delivery guarantee.

Activation requires the operator's real cutoff, exact approved roots/worktrees, and a validated
`ExternalOpenCodeAdoptionConfigSchema` fragment. Do not substitute a historical/example cutoff or
blanket `/srv/dev` root.

Local adapter identity and generation fences remain local runtime checks. A submitted operation can
remain uncertain after cancellation or transport failure; saved observations reconcile by reads and
block a subsequent send until native evidence settles the receipt. They are never automatically
resent and are not a durable pre-POST journal.

### Deferred guarantees

The installed runtime has no conditional native admission, delivery-mode, or conditional-abort
contract. The status-check → POST interval therefore remains racy with direct TUI or other native
writers. The pilot does not provide a durable native queue, automatic resubmission, native
exactly-once retry behavior, durable POST revocation, or authenticated human/TUI origin. Local
generation fences, role classification, and saved outcome observations do not provide those
guarantees.

## Reef Topology

OpenCode runs as a persistent service with Basic auth and a Tailscale-reachable listener. Paseo runs as a separate persistent service, connects to that same OpenCode server through localhost, and exposes its own password-protected endpoint on Reef's Tailscale address.

Running both services under the same Unix account is the simplest way to share provider credentials, OpenCode state, repository permissions, Git configuration, absolute paths, and uploaded attachments. Separate service accounts are supported when both can access every workspace path and the attachment directory described below; global catalog discovery uses the host's shared temporary directory so it does not require access to Paseo's private home. Tailscale ACLs and the host firewall restrict both ports to the intended user and devices.

### Shared attachment directory

Set `PASEO_UPLOADS_DIR` to an absolute local directory when Paseo and the external OpenCode server run under separate service accounts. Paseo writes attachment files there and sends their absolute paths to OpenCode, which opens those paths as its own service account. The default `$PASEO_HOME/uploads` often sits below a private home directory and is not suitable unless the OpenCode account can traverse and read it.

The Paseo account must be able to create and remove entries in `PASEO_UPLOADS_DIR`. The OpenCode account needs read and directory-traverse access to the root and every newly created upload directory and file. Configure a shared group with a setgid directory and a service umask that preserves group read and traverse permissions, or use default POSIX ACLs that grant the OpenCode account those permissions on new children. Do not grant access only on the root: upload directories and files are created later and must inherit usable permissions. Both services must see the directory at the same absolute path, including across container bind mounts.

## Error Handling

- Reject non-HTTP(S) server URLs during configuration parsing.
- Treat missing or invalid external credentials as provider unavailability with an actionable diagnostic.
- Bound health checks so provider discovery cannot hang.
- Distinguish external-server diagnostics from local binary diagnostics.
- Never fall back to spawning a local server when an explicitly configured external server is unavailable.
- Reject persisted endpoint mismatches rather than silently redirecting a session.

## Testing

Targeted tests cover:

- Provider schema validation and legacy configuration migration.
- Runtime-setting inheritance and merging.
- URL normalization and default ports.
- External manager acquisition and no-op lifecycle behavior.
- Authenticated health checks, SDK requests, and SSE requests.
- Read-through native-session listing, partial host failures, and lazy import from the Sessions screen.
- Session create and resume against the configured endpoint.
- Endpoint mismatch handling for persisted sessions.
- Detach-only close behavior for external sessions.
- Unchanged close behavior for managed sessions.
- Diagnostics that identify external mode and avoid irrelevant local auth checks.

The reviewed source was built, and live terminal/mobile exchange passed against the deployed
services. Those checks cover the exercised path; they do not establish the deferred queue, origin,
or native exactly-once guarantees above.

## Non-Goals

- Multi-user OpenCode isolation.
- Mapping different filesystem paths between hosts.
- TLS certificate management or reverse-proxy configuration.
- A generic secret store or remote-provider framework.
- Sharing an external OpenCode server between unrelated trust domains.
