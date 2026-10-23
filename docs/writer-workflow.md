# Operator writer startup and separate draft review

Keep every input, prepared profile, generated plugin, capability and store private,
outside any published checkout. No skills, image backend, credentials, chief
session or executable defaults are supplied. Use only skills and tools you own or
have permission to use. The public default legacy profile remains draft-only.

## Normal supported startup

Create an owned 0600 JSON file in a 0700 private directory. All paths below are
generic placeholders: replace them with existing canonical nonsymlink paths.

```json
{
  "binding": {
    "sessionDirectory": "/absolute/owned/project",
    "draft": "/absolute/owned/project/_drafts/first.md",
    "assetRoots": [],
    "skillPaths": [
      "/absolute/owned/skills/first.md",
      "/absolute/owned/skills/second.md",
      "/absolute/owned/skills/third.md",
      "/absolute/owned/skills/fourth.md"
    ],
    "skillReferenceDirectories": [],
    "writerTools": {
      "imageCommand": "/absolute/trusted/bin/image-command",
      "imageSkill": "/absolute/owned/skills/image.md",
      "chiefFile": "/absolute/private/chief.json",
      "home": "/absolute/owned/home"
    }
  },
  "model": {"providerID": "your-provider", "id": "your-model"},
  "runtime": {
    "executable": "/absolute/matching/opencode",
    "version": "2.1.3",
    "server": "http://127.0.0.1:4096"
  },
  "stateDirectory": "/absolute/private/short-state"
}
```

The fourth skill must contain Humanizer `version: 3.1.0` metadata, without implying
that Galley distributes that skill. The chief designation is a private JSON object
with `session` and `directory` identifying a real existing recipient. No sample
session ID is supplied: prepare against the actual intended recipient. A changed
designation fails closed. Do not repoint it to bypass an existing prepared policy.

The trusted image executable must accept `--help` (mentioning `--prompt`) and
literal `--prompt`, `--out`, optional `--size` and `--transparent` flags. It must
write a new PNG exclusively in the working directory, refuse overwrites, and own
its authentication. It is trusted code, not an OS sandbox. It receives only the
configured HOME, a fixed system PATH and locale; use an absolute executable path,
not shell expansion. Paths with whitespace/pattern metacharacters are refused.
No image provider is downloaded or called by cloning/installing Galley.

From the source checkout:

```sh
node bin/galley-writer.mjs start /absolute/private/writer.json
```

This deliberately installs a project-local agent/image guard/native entry and
activates only the configured project through the supported CLI. It checks exact
CLI/host versions, PID/birth, resolved profile, final session permissions and model;
creates one unparented writer with empty metadata; runs guarded image **help** and
chief reachability **without sending**; then records its actual session and attach
operator. Keep the state socket path <=100 bytes. No first writing prompt, image
generation, chief message or service start is part of startup.

Explicit `writerTools` enables the guarded image/chief pair plus read-only project
`_research/**` and `_images/**`, and read/create/edit `_drafts/*.md`. No general
shell, network, MCP or delegation grant is added. Four-skill preparation without
`writerTools` retains the older enrolled-draft-only policy; it cannot use this
self-checking launcher. Tool executors independently recheck agent/session/location
and exact permission affinity. Images use new simple basenames under `_images/`;
nested drafts should reference their registered absolute paths, never `..`.

Identical completed startup returns the saved session without a second create.
Uncertain startup/send stays fenced: retain state and reconcile, never delete
journals or retry with another ID. `enroll /absolute/private/repair.json` is the
separate existing-session path; it additionally needs exact `preparedFile` and
`sessionId`, and does not create a replacement writer. Do not weaken permissions
or switch an existing author merely to make an enrollment pass.

## Additional draft under the same verified author

Use `node bin/galley-draft.mjs enroll /absolute/private/next-draft.json` while the
author's serving process is stopped so its store is not locked. Never restart the
OpenCode host or create a second writer for this operation. Input fields:

- `authorOperatorFile`, `preparedFile`, exact existing `model`;
- existing canonical `draft`, registered `assetRoots`, optional `siteAssetRoot`;
- fresh private `storeDirectory`, `operatorOutput`, `resultFile`;
- exact private HTTPS `publicOrigin`, optional `ttl` (at most24h).

Only drafts already allowed by that prepared author can enroll. The output
operator retains prior `additionalDraftStores` and appends the separate new one.
In the trusted serving operator, list this author operator once in
`attachedAuthors` (replace its previous path, never duplicate the connector).
Attach the review listener separately; no new public control route is created.

Each draft retains distinct capabilities, comments and immutable draft-scoped
feedback. Native dispatch rechecks the same actual author/model/permissions before
every Send. No old store is rebound to a new draft. `retainedReadOnly: true` on an
attach-only base operator retains old history while refusing all mutations; it is
not a way to bypass a missing or incompatible writer. Partial enrollment failures
must retain files for reconciliation, not overwrite or reset them.

Tests use synthetic caller-owned skills and fake native contexts, never a real
image backend/chief. The optional SDK suite remains separately pinned to2.0.32;
it is not relabelled as2.1.3. Actual runtime acceptance is separate from the
numeric version gate and these offline publication checks.
