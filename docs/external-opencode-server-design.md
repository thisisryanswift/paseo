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

## Session Catalog

OpenCode remains the durable source of truth for native sessions and transcripts. Paseo's Sessions screen is the operational inbox: it reads recent, non-imported root sessions from each connected OpenCode provider and displays them as **Available in OpenCode** alongside Paseo's own history.

Catalog rows are read-through data. Listing them must not create Paseo agents, workspaces, or event subscriptions. Opening a row lazily imports the native handle through the existing provider import path and navigates to the resulting Paseo agent. The provider listing already excludes sessions with an active Paseo record, so an opened session moves from the read-through section into normal Paseo history without duplicate rows.

The catalog follows the selected host and refreshes when the Sessions screen mounts or the user pulls to refresh. Provider rows stay out of history search because they do not carry the indexed transcript data needed to produce complete search results. An unavailable, incompatible, or failed host must be identified explicitly rather than presented as an empty catalog.

## Architecture

External mode uses an implementation of the current `OpenCodeServerManagerLike` contract. Every acquisition method returns the normalized configured server and a no-op release. Shutdown is a no-op. Existing managed-server behavior remains isolated in `OpenCodeServerManager`.

The OpenCode client constructor selects the external manager when `serverUrl` is configured. Availability probes `<serverUrl>/global/health` with a bounded timeout and validates a successful OpenCode health response.

## Reef Topology

OpenCode runs as a persistent service with Basic auth and a Tailscale-reachable listener. Paseo runs as a separate persistent service, connects to that same OpenCode server through localhost, and exposes its own password-protected endpoint on Reef's Tailscale address.

Running both services under the same Unix account is the simplest way to share provider credentials, OpenCode state, repository permissions, Git configuration, and absolute paths. Separate service accounts are also supported when both can access every workspace path; global catalog discovery uses the host's shared temporary directory so it does not require access to Paseo's private home. Tailscale ACLs and the host firewall restrict both ports to the intended user and devices.

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

A focused integration test should run against a real independently started `opencode serve`, confirm that Paseo can complete a turn, and confirm that stopping Paseo leaves both the OpenCode process and session available to a native OpenCode client.

## Non-Goals

- Multi-user OpenCode isolation.
- Mapping different filesystem paths between hosts.
- TLS certificate management or reverse-proxy configuration.
- A generic secret store or remote-provider framework.
- Sharing an external OpenCode server between unrelated trust domains.
