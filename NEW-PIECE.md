# One-command pieces

The generic core and bounded existing-host synthetic workflow are verified;
**deployment and real-device/principal-piece acceptance remain separate**.
Do not install generated plugins globally. Do not point
development tests at an existing writer, service, store or draft.

After the one-time private configuration and controlled service activation below:

```sh
export GALLEY_NEW_CONFIG=/absolute/private/local.json
node bin/galley-new.mjs --title 'A useful point' --format long-form
node bin/galley-new.mjs --resume PIECE_ID
```

Formats: `long-form`, `short-form`, `linkedin` (short-form pack guidance). Optional
`--id NAME` supplies a stable identifier; otherwise it is derived deterministically
from the title. Repeating NEW refuses, never overwrites or creates another session.
Use RESUME for an existing ready piece. Optional repeated `--source ABS_FILE`
enrolls exact read-only sources; `--learn-memory` explicitly grants the pack's one
CAS-protected learned-memory file. Neither option can change scope during resume.

Output is private JSON containing the piece identifier, a 24-hour phone review link
and `conversation: {sessionId, directory, agent}`. Open that exact directory/session
in OpenChamber: it is the principal-owned writer conversation, not a delegated
worker or another browser-created agent. No invented OpenChamber deep-link scheme
is used. Keep terminal output private: the review link is a document capability.

## One-time private install contract

Create a user-owned 0600 input JSON in a 0700 directory with these fields. All paths
must be absolute canonical paths without symlink components. No paths, voice,
model, host, credentials or pack are bundled/defaulted for public users.

```json
{
  "version": 1,
  "pack": {
    "packDirectory": "/absolute/own-pack",
    "skillsRoot": "/absolute/own-sources",
    "expectedVersion": "1.0.0"
  },
  "piecesDirectory": "/absolute/private/pieces",
  "stateDirectory": "/absolute/private/state",
  "controlDirectory": "/absolute/private/control",
  "publicOrigin": "https://review.example.invalid",
  "model": {"providerID": "your-provider", "id": "your-model"},
  "runtime": {
    "executable": "/absolute/matching-opencode-cli",
    "version": "2.1.3",
    "server": "http://127.0.0.1:4096"
  }
}
```

The server URL is an **explicit already-running, compatible native host**, not a
new service or an unauthenticated API fallback. The supported CLI owns its normal
connection/authentication context. Galley never reads host credential registries
or invents a bearer token. `--server` prevents automatic managed-server startup.
Supply a CLI matching the verified host; version skew refuses before API calls.
The numeric release minimum is 2.0.32, including 2.1.x; malformed/prerelease/build
versions refuse. Passing that gate does not certify arbitrary future host APIs.
No CLI download/upgrade is performed. The example port is not host discovery.

Keep state/control outside the pieces and pack/source trees. Unix socket paths
must fit 100 bytes; choose short state/control roots. Installer creates missing
private root directories but never changes existing modes, follows links or
replaces a configuration file:

```sh
node bin/galley-new.mjs --config /absolute/private/local.json --install /absolute/private/input.json
```

This only installs inert configuration. Later activation adds the single optional
`managedPiecesFile` absolute path to the existing native service's operator JSON,
preserving its existing attach mode, binding, privateDirectory and storeDirectory.
The configured public origin must exactly equal that service's `GALLEY_ORIGIN`.
Only the separately controlled deployment lane should change that operator file
and restart the existing Fleet service. No extra permanent listener or public
mount is required. Existing configurations without this option are unchanged.

## Runtime and admission

NEW exclusively creates five private Markdown artifacts, assets and a separate
review store. The initial draft has only the supplied title; the brief traces the
title/format, and other artifacts are empty. No facts, prose template or completed
phase is invented. The shared pack governs the four writing phases and learning.
Visual outputs are declared scopes only: the writer must request unavailable
capture/generation capabilities, not pretend to have made an image.

Per-piece `.opencode/opencode.json` defines the primary named `writer`; the local
`plugins/galley-piece/index.mjs` plugin registers exact artifact tools only in that
piece's location. Top-level `.mjs` files are not discovered by the pinned runtime.
Registration
in an ancestor/global location does nothing. Session hooks hide writer tools from
nonwriters; executors separately enforce agent, exact enrolled session, location,
session permissions, artifact scope and CAS. Generic read/edit/shell tools are not
writer capabilities. The optional learned file is the only pack write exception.

Native activation uses read-only, location-qualified existing-server CLI calls:
`GET /api/model/default` (pinned server handler waits for plugin activation), then
`GET /api/agent/writer`. An authenticated private Unix IPC owner handshake must
finish before startup. An absent/incompatible/cold plugin refuses; there is no
bootstrap session, model prompt, embedded production SDK server, runtime restart
or borrowed authentication fallback.

The native executor verifies the resolved agent profile before creating the sole
author-facing session with exact permissions, explicit `metadata: {}`, no parent
and the configured model. It verifies readback and durably enrolls that exact
session before admitting one short conversational kickoff. The generic command
does not supply a whole draft/interview or lead/goal automation.

RESUME reuses the saved identity, files, permissions, review capabilities and
history. It sends no kickoff, continuation prompt or replay. An expired/revoked
link is renewed locally without creating a writer; still-valid old links remain
valid. A clean service restart reattaches ready pieces, never retries incomplete
or uncertain startup. Unavailable ready pieces fail closed without preventing the
legacy review from serving. Their histories remain on disk for local diagnosis.

Review capabilities choose only an already-enrolled store on the same `/galley/`
listener. Browser callers cannot enroll, switch arbitrary files/packs/sessions,
create agents or invoke control/native methods. The legacy default route and its
tokens continue to select the old store; new capabilities select their own stores.
Existing note/batch authorization, Host/Origin/CSRF and uncertainty fences remain.

Phases advance within the same exact session through `writer_read` guidance's
validated phase selector. A small header in the existing continuation file tracks
current phase/resume; normal continuation writes must preserve it. Resume refreshes
handoff sources and learned notes without another model prompt or session. Full
editing sources load in edit; initial design guidance alone is not four-phase proof.

Creation and startup readback still require `metadata: {}` and no parent. Subsequent
checks accept only empty metadata or the exact benign observational host shape
`{openchamber:{work:{state:'open',openedBy:'auto',openedAt:SAFE_NONNEGATIVE_INTEGER}}}`.
That observational shape may also contain exactly `assist: {recap, suggestion,
forMessageID, generatedAt}` under `openchamber`: strings bounded to 320/500
characters respectively, a bounded message ID, and safe nonnegative integer time.
The referenced assistant message must be found by a supported read-only lookup
scoped to this exact writer session. Pinned host source establishes these as
advisory UI fields; their text is untrusted and never enters writer instructions,
authorization or automatic work. Unknown keys, automation/goal metadata and all
identity/model/rules changes refuse. Startup still accepts only empty metadata.

Piece-local `tool_output` permits complete guidance returns (1 MiB/20,000 lines);
assembled guidance itself refuses above 512 KiB/16,000 lines, leaving room for
host serialization. This avoids a misleading truncated edit/handoff load without
changing global settings, file scopes or model permissions.

An explicit operator-only pre-startup recovery is available for an allocated piece:
`--resume-allocated ID --expected-allocation ABS_PRIVATE_JSON`. That JSON contains
only its exact `directory`, `fingerprint`, `enrollmentDigest`. Under the exclusive
manager lock, recovery requires exact allocated state/identity, no session record,
no startup/kickoff/owner evidence and a retired old native generation, if any.
It never resets a journal. The fsynced `startup-uncertain` fence precedes enqueuing
any native create. Anything uncertain remains unrecoverable by this operation.

Immutable pack/body drift refuses context, write, native delivery and resume even
without a version change. Mutable learned memory refreshes normally. No automatic
refresh/recreate/reset is provided: save/reconcile privately and explicitly prepare
a changed adapter in a later maintenance lane. Uncertain journals retain session
identity when known and the exact kickoff ID/text before admission. Do not delete
locks/journals or change IDs to bypass a fence.

## Verification and remaining acceptance

`node --test test/new-piece.test.mjs` uses test-created synthetic packs, private
temporary directories, real local Unix IPC, a fake native context and an ephemeral
HTTP listener. The CLI/existing-server argument contract uses a synthetic CLI,
not the person's runtime. These tests prove the core lifecycle, not actual host
cold discovery, model-facing tool schemas or direct OpenChamber UI discovery.

The pinned 2.0.32 runtime has completed bounded synthetic cold-location activation,
same-session OpenChamber visibility, all four phases, edit/resume/render/HTTP note
delivery and complete edit/handoff guidance return. Actual outgoing schema capture
against a local fake provider proves nonwriter exclusion and the writer-only pair;
hook callback/registry tests alone are not that proof. This is not deployment,
physical-phone, principal-piece or arbitrary-version acceptance.

Normal `npm ci --ignore-scripts --no-fund` and `npm test` stay lightweight: only
the 19 root application dependencies are installed. Actual SDK contracts live in
an optional separately installed test package, with no silent skips:

```sh
npm ci --prefix test/native-runtime --ignore-scripts --no-fund
npm run test:native
```

See [PACK-WRITER.md](PACK-WRITER.md#verification) for test isolation, known optional
SDK advisories and licence boundaries. No external provider/model calls are made.
After separately authorized service activation, the same phone HTML refreshes as
this exact writer revises the draft; note/send admission is not edit completion.
