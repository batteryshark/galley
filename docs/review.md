# Review operation and recovery

## Notes and updates

Select text, tap the contextual field or type on desktop, then finish with Enter, Escape or tap-away. Shift+Enter adds a line. Acknowledged notes are saved on the server and visible on other devices; unacknowledged text exists only in the current tab. Copy it before closing or reloading.

Active selections and note composition defer prose replacement. Original quotes survive revisions; changed or ambiguous quotes require review before sending. Send batches pending notes to the exact enrolled editor. Admission is not completion: confirm changes in that session and the revised draft.

## Links and store ownership

Legacy `galley.mjs link` links expire after one hour. Issuing another does not revoke older unexpired links; `revoke` invalidates stored review links. New-piece links last 24 hours and can renew locally on resume.

The server holds an exclusive `.galley` store lock. Stop it gracefully before legacy link management, then restart disconnected serve or native **attach** to the confirmed writer. Do not repeat native startup. Preserve the store and native journals across restarts.

Uncertain startup or Send blocks replay. Inspect the exact editor history and draft; changing a request ID or creating another writer is not a safe retry. There is no automatic clear-fence CLI. Before addressing a stale lock, confirm the old process has exited and reconcile its state.

## Private access

Use a private Tailscale Serve HTTPS mount, not Funnel; see [native setup](native-setup.md#private-tailscale-route). The server must remain awake and reachable. Everyone with a valid link and network access shares review authority and pending notes; there are no per-person roles.

## Rendering limits

Markdown is sanitized to inert elements. Scripts, arbitrary HTML attributes, external navigation and remote images are stripped. Local PNG, JPEG, GIF and WebP images must be under registered roots; SVG is unsupported. Drafts are limited to 1 MiB, images to 5 MiB each, with 64 image IDs and a 20 MiB presentation-read budget.

Selections can span DOM nodes and contain up to 12,000 UTF-16 code units; comments can contain up to 8,000. This is text review, not visual image annotation or a complete Markdown-site renderer. Keep drafts, capabilities, skills and generated runtime profiles outside published source trees.
