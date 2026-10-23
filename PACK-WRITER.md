# Pack-backed named writer

For the implemented one-command workflow, start with [NEW-PIECE.md](NEW-PIECE.md).
Configure your private pack and compatible runtime once; NEW returns a phone review
capability and the same direct OpenChamber writer. This guide describes the adapter
and inert maintainer generator underneath it. No private pack or local configuration
is supplied by this repository; local installation/service activation is separate.

`src/writing-pack.mjs` resolves caller-owned schema-1 private writing manifests.
Supply **both** canonical `packDirectory` and `skillsRoot`, plus `expectedVersion`.
There is no installed-path default, catalogue lookup, network fallback or bundled
voice. Files are bounded UTF-8 regular single-link files; symlinks in every path
component, traversal, permission metacharacters, unknown phases/roles, missing files
and mismatched nested source metadata fail closed. Fingerprints track current
immutable guidance and source bodies, not just version strings. Mutable learned
memory is excluded and refreshed each model step.

`preparePackWriter(options, enrollment?)` creates a **writer** profile. Without
enrollment it allows only built-in reads of exact resolved pack/source files and
their external-directory boundary checks. Edits, shell, delegation, Code Mode,
MCP, network, build and publishing are denied. It does not inherit Build's prompt.
The lean global Markdown refers to the shared files, not copied voice text. It
installs **no global plugin or custom tools**. A manifest adding/changing references
requires regenerating this exact-read profile; missing grants fail closed.

## Adapter and maintainer interface

1. Exclusively create the private piece files yourself; never initialize over
   existing files. Explicitly supply an enrollment object:

   ```js
   { directory, artifacts: { brief, beats, 'visual-plan': visualPlan, draft,
       continuation }, sources: [exactReadOnlyFile],
     assetDirectories: [namedExistingDirectory], learnMemory: false,
     phase: 'design-piece', format: 'long-form', resume: false }
   ```

   All artifact paths are exact canonical existing files under `directory`; roles
   may share a file. Hidden/config paths, pack/skills files, source/artifact aliases
   and asset roots containing protected files are rejected. Sources are exact files,
   never a store wildcard. Asset directories are declarations for later specialized
   capture/generation tools, **not write grants or an available visual capability**.
2. Call `preparePackWriter`, then `generatePackArtifacts`. Global generation emits
   agent/config only, never a plugin. Explicit piece enrollment also emits a plugin.
   Generated files are
   **private**, contain local paths, and must never be exported. The maintainer
   command `node bin/galley-pack-writer.mjs --pack-directory ABS --skills-root ABS
   --expected-version SEMVER [--enrollment PRIVATE_JSON] --output EMPTY_PRIVATE_DIR`
   only generates inert artifacts. It installs nothing and starts no runtime.
3. Use a dedicated configuration domain/isolated runtime for the piece. Put its
   named profile and generated plugin in that domain; do not override the global
   writer for every existing project or load two competing enrollment wrappers.
   The implemented NEW command installs a per-piece `.opencode` domain, discovers
   it through the compatible existing host, and enrolls it in the managed registry
   on the same Galley listener. Production does not import the embedded SDK.
4. Resolve the effective named profile, verify the intended system and permission
   sequence (later built-in deny rules are possible), then create the session with
   `agent: 'writer'` and **exact** `prepared.sessionPermissions`. Every piece tool
   checks session location, agent and these session rules, independent of prompts.
   Never attach a lead's session/permissions. Re-read identity before forwarding
   review input. Existing native `galley-writer-ID` attachment/journals are unchanged;
   this new path uses the separate `pack-writer-v1` verifier, preserving legacy mode.
   Initial session creation/readback requires empty metadata and no parent; later
   exact-session observational work/assist metadata is advisory only, not authority
   or automatic work. See NEW-PIECE for the exact accepted shapes and message-affinity
    check. Compatible CLI and host must match exactly and be numeric releases
    **>=2.0.32** (including 2.1.x); skew fails closed. Admission is not universal
    future-version compatibility certification.
5. Preparation pins immutable pack bodies, format, artifact scope and session rules.
   Phase is mutable: `writer_read({target: 'guidance', phase: 'edit'})` (also
   `design-piece`, `design-visuals`, `draft`) loads the complete phase sources and
   saves a validated state header in the existing continuation artifact. This uses
   its existing write grant, never a new file/tool/session or another setup step.
   Preserve that header when writing hand-offs and local learning proposals.
   Each context loads current phase, continuation and refreshed learned notes.
   RESUME marks `resume: true` without a prompt; the next model step loads saved
   phase sources (including full editing guidance in edit) plus handoff sources.
   Immutable changes still fail closed: no automatic reload/recreation is supplied.
   Piece-local tool-output bounds keep full edit/resume guidance below the host's
   truncation cap. Bundles above 512 KiB/16,000 lines fail explicitly, never claim
   complete loading from a truncated prefix.

## Effective tools

In an explicitly opted-in piece runtime, only `writer_read` and (when granted)
`writer_write` are writer's direct tools, explicitly outside Code Mode. The plugin
refuses setup without enrollment and must never be installed globally. Its V2
context hook removes its two schemas from nonwriter model requests without changing
unrelated tools or permissions; direct invocation by another agent is rejected.
Unrelated runtimes never register these tools at all. The first accepts `guidance`
with optional phase/resume, or an exact enrolled path without phase options. All
phase-selected pack bodies are bundled in guidance, not independently readable
through arbitrary pack paths. The
second replaces an existing exact artifact with an expected SHA-256. Sources and
all immutable pack files are read-only. Optional learning adds **only** the resolved
`voice/learned.md`; no native edit grant exists. Writes reject stale hashes, symlinks,
hardlinks and inode replacement, serialize within the runtime, fsync, and cannot
create/delete/rename piece or pack files. An exclusive derived coordination lease
in the private system temp area serializes cooperating writers across runtimes
(including the one shared learned file). It is removed after each write; a crash
leaves a fail-closed lease needing maintainer review, never automatic lock stealing.
This is optimistic compare-before-write, not an OS
transaction: hostile local rename races, a noncooperating writer in the final
check/write window, and crash-atomic replacement are not promised. The CLI must
own one runtime per piece, not concurrent writer processes for one enrollment.
Plugins are trusted host code; this is a scoped tool boundary, not an OS sandbox.
Unrelated project/global plugins and instructions are outside this adapter's control;
use the isolated configuration domain for exact enrolled operation.

`conversationAdapter` cheaply generates Pi and Claude Code argument arrays from
fresh shared guidance with tools/extensions/MCP disabled. They are **conversation
only**, checked against installed CLI help, not model-exercised editing adapters.
Enrolled editing is refused. Codex generation refuses because a verified no-tools,
no-arbitrary-read launch contract was not established; `read-only` shell sandboxing
is not an equivalent boundary. No harness download or global harness config edit.

## Verification

`npm test` retains all unit/fake-core coverage with synthetic packs and artifacts;
it requires only the 19 root application dependencies, not an SDK installation.
The actual native contract is a separately installed, optional suite:

```sh
npm ci --ignore-scripts --no-fund
npm test
npm ci --prefix test/native-runtime --ignore-scripts --no-fund
npm run test:native
```

The optional suite fails if its SDK is missing; it does not silently skip tests.
Its isolated V2 SDK host verifies generated Markdown/plugin discovery, real
permission denials, exact piece writes, learned-memory exception and stale-hash
rejection. All provider use is denied, model catalogue fetching disabled, and no
HTTP listener is opened in the provider-denied discovery cases. A separate bounded
local fake-provider listener captures actual outgoing model requests: nonwriter
schemas omit both writer tools and retain unrelated tools; writer schemas expose
only the scoped pair. No real model/credentials/provider network is used there.
The production directory/index.mjs generator is also tested through actual cold
discovery; embedded SDK's development host version is correctly refused by the
native-version fence, not spoofed. Cold registry reads alone may be empty until location
plugins activate; the fixture admits a synthetic provider-denied activation prompt.
It never sends a model request. Fixture entry refuses execution without an explicit
isolated-test flag. External OAuth, provider and catalogue paths are disabled;
only the owned loopback fake provider is permitted for schema capture.
`@opencode/sdk@2.0.32` and its tree (385 packages installed on verified macOS) belong
only to the optional private test package, not root installs, the running service
or a new installed harness.
The pinned tree has 17 known dev-optional advisory entries (8 low, 4 moderate,
5 high); isolation is not remediation or a claim that every path is unreachable.
Do not use audit-fix or change a live SDK to run this contract. Retain installed
SDK/transitive packages' shipped licence notices if redistributing them; they are
not vendored, relicensed, or included in the root 19-package notice inventory.
