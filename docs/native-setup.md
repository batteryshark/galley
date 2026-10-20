# Native editing setup

This guide describes the shipped source interface, not a one-command installer or a promise that every OpenCode/OpenChamber release is compatible. Start with a synthetic draft. Keep all paths, profiles, bindings, session output and capabilities private. All uppercase `/ABSOLUTE/...` paths and angle-bracket values below are placeholders to replace locally, not literal working settings.

## 1. Check the external runtime contract

Use Node >=22.12.0 on macOS. Install and authenticate a compatible OpenCode V2 runtime separately, with the provider/model you choose. OpenChamber is optional UI for that runtime; Galley does not install either product or relay through OpenChamber’s HTTP routes.

The project-local default-export plugin is `{ id: 'galley.native', setup(ctx) }`, with cleanup. Its owner must expose:

- `ctx.location.directory`: exactly the canonical enrolled project.
- `ctx.agent.get({ agentID })`: `{ location, data }`; the resolved profile must have the exact generated system text, primary mode and ordered permission suffix.
- `ctx.session.create/get/prompt/context/interrupt`: native Promise APIs. Creation must retain explicit location, agent, model, permissions and empty `metadata: {}`; optional `parentID` must read back exactly.
- `session.prompt` must admit the exact `{ id, text, delivery: 'queue', resume: true }` request and return a matching user inbox item with `sessionID`, `delivery`, `payload: { text }` and positive `time.created`.

`src/native-worker.mjs` is the exact contract, including readback and timeouts. The runtime needs to load the generated Markdown agent format and a local TypeScript plugin importing this checkout’s ESM module. V1 plugin APIs, generic SDK adapters, desktop pairing and HTTP fallbacks are not supported. See the upstream [V2 plugin](https://opencode.ai/v2/docs/build/plugins) and [configuration](https://opencode.ai/v2/docs/config) documentation, but verify your installed runtime against Galley’s stricter checks. No minimum compatible runtime version is certified here.

## 2. Lay out private inputs

Keep the Galley source checkout at a stable canonical path after artifact generation. The writer project is the project containing the draft, not necessarily the Galley checkout. Choose:

- a private working directory for the CLI store (`<working-directory>/.galley`);
- an existing private artifact output directory, initially empty;
- a short private native directory **outside the writer project**. It must be owned by your user, mode `0700`, with no symlink components. Its `ipc.sock` full path must fit in 100 bytes. Avoid filesystem-root paths and permission-pattern metacharacters;
- private input and operator JSON files, mode `0600`; use `umask 077` when creating them. Do not use shared temporary directories for credentials.

The native connector writes `binding.json` inside the native directory; **do not author that credential file yourself**. It contains a fresh IPC token and epoch, unrelated to the browser review link.

Create a trusted input binding (at most 32 KiB when used by enrollment):

```json
{
  "draft": "/ABSOLUTE/PATH/TO/draft-project/draft.md",
  "sessionDirectory": "/ABSOLUTE/PATH/TO/draft-project",
  "assetRoots": ["/ABSOLUTE/PATH/TO/draft-project/images"],
  "sessionId": "not_connected",
  "upstreamIdentity": "native-startup-placeholder",
  "skillPaths": [
    "/ABSOLUTE/PATH/TO/owned-skills/first/SKILL.md",
    "/ABSOLUTE/PATH/TO/owned-skills/second/SKILL.md",
    "/ABSOLUTE/PATH/TO/owned-skills/third/SKILL.md",
    "/ABSOLUTE/PATH/TO/owned-skills/humanizer/SKILL.md"
  ],
  "skillReferenceDirectories": []
}
```

All paths must exist and be canonical absolute nonsymlink paths; the draft must be inside `sessionDirectory`. Create the example image directory or use `assetRoots: []`. Optional `siteAssetRoot` must be in `assetRoots`. Initial session/identity strings are inert enrollment placeholders, replaced only after successful native creation. They do not attach an arbitrary existing session.

Supply four skill bodies you own or have permission to use. Galley neither distributes nor downloads them. Each file is bounded to 256 KiB; the fourth must contain `version: 3.1.0` metadata (quoted values also accepted). This is the Humanizer version check, not verification of authorship or a public download location. Do not copy private skill bodies into this repository.

Optional `skillReferenceDirectories` grants read-only supporting trees: at most 16 explicit existing canonical nonsymlink directories, no filesystem roots or permission metacharacters. No trees are inferred from skill-relative links. Skill files and declared trees are readable; **only the enrolled draft is editable**. Shell, network/MCP, delegation and alternative editing tools remain denied by the generated policy. Unsupported auxiliary skill workflows must be reported as not run.

## 3. Enroll a fresh store and prepare inert artifacts

Use a new store for native startup, not your disconnected experiment’s note history. Enrollment is exclusive and will not overwrite an existing store. From your chosen private CLI working directory, using the stable absolute source location:

```sh
node /ABSOLUTE/PATH/TO/galley/bin/galley.mjs enroll /ABSOLUTE/PATH/TO/private/input-binding.json
node /ABSOLUTE/PATH/TO/galley/bin/galley-writer.mjs prepare \
  /ABSOLUTE/PATH/TO/private/input-binding.json \
  /ABSOLUTE/PATH/TO/private/artifacts \
  /ABSOLUTE/PATH/TO/private/native/binding.json
```

`prepare` exclusively creates `prepared.json`, `galley-writer-<generated-id>.md` and `galley-native.ts`. The prepared object includes the agent profile and `config.agents`, embedded skill bodies, digests and absolute paths. The plugin imports the stable Galley checkout and names the **future connector-written** binding file. No `.opencode` files are installed, no config is merged, and no session or service is started.

For an already prepared object, `generate <prepared.json> <existing-output-directory> <future-binding.json>` generates the profile/plugin after validation. Outputs refuse overwrites; a partial failure can leave files, so inspect them and use a fresh private output directory rather than overwriting. Changing skill bodies requires preparation again; skill digests and reference directory safety are rechecked.

## 4. Install profile and plugin explicitly

Pause the relevant project runtime using its supported lifecycle before installation. Preserve unrelated configuration. Do not load duplicate plugin owners for this project.

There is no install CLI. To install only the prepared agent via the shipped API, run this from the Galley source directory, after replacing the prepared path:

```sh
node --input-type=module <<'JS'
import { boundedRead } from './src/files.mjs';
import { installWriter } from './src/writer.mjs';
const prepared = JSON.parse(await boundedRead('/ABSOLUTE/PATH/TO/private/artifacts/prepared.json', 2 * 1024 * 1024));
await installWriter(prepared);
JS
```

`installWriter` validates digests and paths, creates missing `.opencode/agents` parents safely and exclusively writes the generated Markdown agent in `prepared.directory`. It does not install the plugin.

Next, create/verify a nonsymlink `.opencode/plugins` directory in that **writer project**, owned by you. Copy the generated `galley-native.ts` there as `.opencode/plugins/galley-native.ts`, mode `0600`, only if that destination does not exist. Inspect rather than overwrite any existing Galley entry. Do not also load it through a `plugins` config entry: that can create an ambiguous second owner. V2 auto-loads project-local plugins from this directory. The generated `prepared.config` is an alternative representation of the same agent; do not blindly merge it or install a second divergent definition.

This installation changes private local runtime configuration intentionally; it is not part of cloning or `npm ci`. Both files contain private paths, and the profile embeds caller-owned skill bodies. Keep these installed files out of any public repository/history even if the writer project itself uses Git. Moving Galley source breaks the absolute plugin import; regenerate and deliberately replace the entry while stopped if its location changes.

## 5. Start one runtime, then native startup

Open the exact writer project in your compatible OpenCode runtime (for a CLI installation, run `opencode` from that project). If using OpenChamber, select that same project on that same runtime. Load the profile and plugin once through the runtime’s supported reload/restart lifecycle. No Galley service restart command can reload the host runtime’s plugins for you.

The plugin polls its fixed binding path and waits harmlessly until the connector creates it. Keep that one owner available. Create a private startup operator JSON:

```json
{
  "mode": "startup",
  "privateDirectory": "/ABSOLUTE/PATH/TO/private/native",
  "storeDirectory": "/ABSOLUTE/PATH/TO/private/review-work/.galley",
  "preparedFile": "/ABSOLUTE/PATH/TO/private/artifacts/prepared.json",
  "model": { "providerID": "<YOUR_PROVIDER_ID>", "id": "<YOUR_MODEL_ID>" }
}
```

Replace model values with a real authenticated model supported by that runtime. Optional `model.variant` is explicit, not inferred. Optional `parentID` must be an exact known parent in the same project; omit it for an unparented direct editing session. Automatic registration selects a single authenticated owner. Advanced configurations may instead pin **both** `ownerPID` and `ownerStartedAt` (process birth time in epoch milliseconds); do not guess or use stale values.

Before any serving process holds the store, issue a link from the same private working directory:

```sh
node /ABSOLUTE/PATH/TO/galley/bin/galley.mjs link
node /ABSOLUTE/PATH/TO/galley/bin/galley-native.mjs /ABSOLUTE/PATH/TO/private/startup-operator.json
```

For remote use, first follow the origin/route section below and set `GALLEY_ORIGIN` on **both** commands. The connector waits up to 60 seconds for the plugin owner. Startup writes an exclusive uncertainty journal **before** creation. On confirmed creation it updates the enrolled binding’s session ID, agent and native identity, records `created-not-edit-verified`, and serves review on loopback 4177. Treat the printed session output as private. Startup creates the constrained editing session; it does not send an initial writing prompt or verify an edit.

Talk directly to the created session in OpenCode/OpenChamber. Browser Send queues one immutable batch of pending author notes into that same session with resume enabled. A matching admission receipt does not prove that the agent acted, finished or made the intended edit. Inspect its response and the revised file; the page polls about every three seconds while visible. No second authoring agent is created per Send.

## 6. Restart with attach, never repeat startup

After successful startup, save a separate private attach operator file:

```json
{
  "mode": "attach",
  "privateDirectory": "/ABSOLUTE/PATH/TO/private/native",
  "storeDirectory": "/ABSOLUTE/PATH/TO/private/review-work/.galley"
}
```

Gracefully stop the startup connector with Ctrl+C before starting attach:

```sh
node /ABSOLUTE/PATH/TO/galley/bin/galley-native.mjs /ABSOLUTE/PATH/TO/private/attach-operator.json
```

Attach requires the store’s exact writer and a matching confirmed startup journal. It inspects that existing session, rotates IPC credentials/native identity, and starts review; it does not create another writer. Keep the plugin loaded and private directories stable. Optional owner pinning must remain accurate. Do not re-enroll with the initial input binding after startup.

The CLI store is always `.galley` in its current working directory; the native CLI instead takes explicit `storeDirectory`. To renew links or revoke all links, stop the connector, run `link` or `revoke` from the directory containing that exact store, and restart with attach. Review links expire in one hour; a new link leaves older unexpired ones valid. Revocation cannot erase already viewed content or unsaved browser text. Reopen the newly issued private URL after renewal.

## Private Tailscale route

Install and authenticate Tailscale separately on Mac and phone. Enable the account’s required HTTPS/Serve features and appropriate private access policy. Check existing mounts before changing them; do not reset unrelated Serve configuration. This pattern intentionally mounts **only** Galley and restores the prefix stripped by Serve:

```sh
tailscale serve status
tailscale serve --bg --https=9443 --set-path=/galley http://127.0.0.1:4177/galley
```

Use the actual HTTPS origin reported for your own node privately. In the shell used for both link issuance and native/disconnected serving:

```sh
export GALLEY_ORIGIN='https://review.example.invalid:9443'
```

`review.example.invalid` is reserved and deliberately nonworking: replace it locally. The origin has no `/galley`, slash suffix, query or fragment; include `:9443` if using that port. The public URL shape is `https://review.example.invalid:9443/galley/#review=<PRIVATE_CAPABILITY>`, not a working capability. Do not publish the substituted URL. Do not enable Funnel.

The proxy must preserve the browser Host and Origin and forward `/galley/...` to the same backend path. Galley does not trust forwarded-host/origin headers. With a remote origin configured, ordinary local browser requests may fail the Host gate; the fixed loopback `/galley/health` probe is an intentional inert exception, not an authenticated review check.

Serve’s `--bg` persists its proxy mapping; it does not supervise Galley or keep the Mac awake. The phone needs its Tailscale connection, and the Mac needs to stay awake and online. Fleet is optional and is not bundled, auto-installed or registered. If you configure a supervisor, use native attach after the one confirmed startup, a stable store/native directory, the same exact origin and a single process. Avoid auto-retrying startup on failure.

## Failure and uncertainty are not retry permission

- A pre-dispatch editor-unavailable response leaves notes pending. Correct the connection and review state before Send.
- Once a batch crosses the persisted native boundary, a missing/late response becomes `uncertain`. Sending batches at shutdown also become uncertain on reopen. Neither old comments nor batches are automatically replayed. Identical browser transport retries can retrieve the same operation/batch, not perform a new native admission.
- An uncertain startup journal remains a permanent fence for that prepared agent, even when failure appears to have occurred during preflight. Do not rerun startup, generate another agent, delete journals or change IDs as a workaround. First manually determine whether a session was created and whether work occurred. There is no supported automatic fence-clear or startup-recovery command.
- Native reconciliation can inspect active context, not a complete inbox/history API. An absent context message may be pending, compacted or unavailable and is **not retryable evidence of absence**. Continuous batches have no automatic reconciliation UI/CLI.
- Store locks fail closed after crashes. Native recovery checks known process birth/ownership, not cryptographic process attestation. Confirm all old processes are gone before any manual lock recovery; preserve state/journals and inspect the direct session. The trusted-user model does not cover hostile local rename races or malicious runtime plugins.
- Missing owner, duplicate owners, changed profiles, symlinks, skill drift, wrong session/project/model/permissions or unsupported receipt schemas stop the connector rather than selecting a fallback.

The isolated source install and full synthetic test suite have been checked for this distribution. Native tests exercise actual local IPC and plugin/connector code with fake runtime APIs; they do not establish compatibility with an external runtime. This setup guide remains source-derived, not an independently executed native installation. Responsive synthetic browser captures do not establish physical iPhone gesture or keyboard behavior.
