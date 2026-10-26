# Galley

<img src="release-assets/logo/galley-logo-256.png" width="160" alt="Galley hermit-crab proofreader">

Galley is a private, self-hosted review page for drafts written with an agent. Read rendered Markdown on a phone or desktop, highlight passages and save contextual notes, then send them together to the document's editing session. The page refreshes as the draft changes while preserving reading position and pending notes.

## Requirements

- macOS, Node.js 22.12.0+ and npm. Windows is unsupported; other Unix platforms are not verified.
- For connected editing, a compatible OpenCode/OpenChamber runtime and your own writing skills or pack.
- Optional private Tailscale access for reading from another device.

## Install

```sh
git clone https://github.com/batteryshark/galley.git
cd galley
npm ci --ignore-scripts --no-fund
```

There is no build step. The application runs from this checkout.

## Quick start: disconnected review

Create a Markdown draft and save a private `binding.json` outside the checkout. Replace these paths with existing canonical absolute paths, without symlinks:

```json
{
  "draft": "/absolute/project/draft.md",
  "sessionDirectory": "/absolute/project",
  "assetRoots": [],
  "sessionId": "not_connected",
  "upstreamIdentity": "disconnected-example"
}
```

```sh
node bin/galley.mjs enroll /absolute/private/binding.json
node bin/galley.mjs link
npm start
```

Open the private URL printed by `link`. Select text and leave a note; editing the Markdown file demonstrates automatic refresh. Disconnected mode saves notes but cannot send them to an editor. Treat the link fragment as a bearer secret.

![Galley desktop review](docs/images/desktop.png)

## Configuration

`assetRoots` permits local image directories; optional `siteAssetRoot` must be one of them. `GALLEY_ORIGIN` sets the exact browser origin, including any port, with no path or trailing slash. Use the same origin when issuing links and serving. Non-loopback origins require HTTPS; the listener remains on `127.0.0.1:4177`.

Connected editing requires explicit private runtime and skill configuration. Follow [native setup](docs/native-setup.md) for a bound document or [new pieces](NEW-PIECE.md) for a dedicated writer and writing pack. The CLI and host must match exactly and be at least release 2.0.32 for new pieces. No private skills, model account or host configuration is bundled.

## Key commands

```sh
node bin/galley.mjs link              # issue a private review link
node bin/galley.mjs revoke            # revoke review links
npm start                            # disconnected review server
node bin/galley-new.mjs --title 'A useful point' --format long-form
node bin/galley-new.mjs --resume PIECE_ID
```

Stop the serving process before legacy `link` or `revoke` operations on the same store. New-piece commands require `GALLEY_NEW_CONFIG` pointing to your configured private JSON file. See [review operation and recovery](docs/review.md) before managing a connected store.

## Documentation

- [Review links, notes and recovery](docs/review.md)
- [Native editor setup and private phone access](docs/native-setup.md)
- [Writing packs](PACK-WRITER.md) and [new pieces](NEW-PIECE.md)
- [Writer startup and additional drafts](docs/writer-workflow.md)

## License

[MIT](LICENSE), copyright © 2026 batteryshark. Preserve [third-party notices](THIRD_PARTY_NOTICES.md). The [logo](release-assets/logo/README.md) is AI-generated artwork.
