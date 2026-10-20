# Optional pinned native contract tests

From the repository root (Node >=22.12.0):

```sh
npm ci --ignore-scripts --no-fund
npm test
npm ci --prefix test/native-runtime --ignore-scripts --no-fund
npm run test:native
```

This is a private, non-workspace test package. Root installs/tests do not install
or require it. Missing SDK installation fails the optional suite, never skips it.
Keep SDK **2.0.32**: this is a pinned runtime contract, not a live-host upgrade.

The single contract test retains four actual runtime fixture invocations: readonly
discovery/denials, enrolled discovery/writes/negative scopes, outgoing context/tool
schemas plus full edit/resume tool guidance, and production plugin-layout discovery
with the SDK development-host version correctly refused. Unit/fake-core coverage
stays in the default suite. No real host, model, credentials or author session is
used. Synthetic HOME/XDG and provider deny policies isolate the SDK; OAuth/MCP
servers are not configured, catalogue fetching is off, and HTTP requests are denied
except the owned loopback fake-provider endpoint in schema mode. Listeners and SDK
hosts close in finally, including SDK initialization failure.

The optional dev tree installs 385 packages on the verified macOS platform (432
lock entries include other-platform alternatives). It reports 17 known advisory entries
(8 low, 4 moderate, 5 high). This bounded isolation does not fix vulnerabilities
or establish exhaustive reachability. Do not run audit-fix or unrelated upgrades.

Packages are installed separately with their original shipped licence notices;
retain those notices whenever redistributing installed SDK/transitive packages.
Nothing is vendored or relicensed here. The root notices cover only the 19 root
runtime dependencies, not an exhaustive licence audit of this optional lock.
