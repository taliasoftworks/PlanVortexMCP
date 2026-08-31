# Changelog

All notable changes to `planvortex-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] — 2026-08-31

### Fixed

- **`server.json` was written against an obsolete schema, so the listing in the official MCP
  registry failed silently on every release.** The registry job carries `continue-on-error` by
  design — it is in preview and must not fail a release already on npm — so the run stayed green and
  the server never appeared anywhere.

    The trap is that the old schema (`2025-07-09`) is still published and still downloads fine, so a
    validator pointed at it goes green while the live API answers `422`. Between that revision and the
    current one (`2025-12-11`) the field names changed from `snake_case` to `camelCase`.

    `npm run check:registry` now asks the registry which schema it is actually stamping on its own
    entries before validating against it. Nothing here changes the published package.

- **The package described itself as covering ten social networks when it covers eleven.** That
  sentence is the one npmjs.com prints under the package name, and it was the only place still
  saying ten — `server.json`, `manifest.json`, the README and the server's own instructions
  all said eleven. Telegram was the network missing from the count.

## [0.1.1] — 2026-08-31

### Fixed

- **The server did not start when its path contained a space, an accent or a `~`, and never started
  on Linux or macOS when launched through `npx`.** It exited with code 0 and printed nothing, which
  is the worst possible failure: the MCP client just showed a server that would not connect, with no
  error to search for.

    The bin and the package exports lived in the same file, so it had to guess whether it had been
    executed or imported by comparing `process.argv[1]` with `import.meta.url`. That comparison cannot
    work: `import.meta.url` is a URL, so a space travels as `%20` and `é` as `%C3%A9`, and npm installs
    the bin as a symlink on Linux and macOS, where the two values point at different files by design.

    The bin is now its own entry point (`dist/cli.js`) that simply runs, with nothing to guess. CI
    packs the tarball, installs it into a directory with a space in the name and runs it through the
    bin, which is how a user actually starts it.

## [0.1.0] — 2026-08-31

### Added

- First release. Twenty-five tools over the PlanVortex API, three prompts and four catalog
  resources, on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.0.0), which speaks the
  2026-07-28 revision and the 2025 one at the same time.
- **stdio by default, `--http` for a self-hosted deployment.** The HTTP mode binds to `127.0.0.1`
  unless `PLANVORTEX_MCP_AUTH_TOKEN` is set, validates `Origin`, and never forwards a request token
  to PlanVortex.
- **`PLANVORTEX_MCP_READ_ONLY`** removes the nine write tools from the listing entirely, for giving
  an unsupervised agent read access and nothing else.
- Built on [`planvortex`](https://www.npmjs.com/package/planvortex) 0.4: the server speaks no HTTP
  of its own, so the error catalogue, the token cache, the multipart upload and the pagination are
  the library's and are not reimplemented here.

### Security

- **No tool deletes anything** — not a post, an account, a contact or a comment. This server reads
  text written by strangers while holding tools that publish under the user's brand, so the blast
  radius of a successful prompt injection is kept to something a person can see and undo.
- Every comment, review and incoming message is delimited and labelled as untrusted before it
  reaches the model, and never enters a tool description or a cached resource.
- Credentials come from the environment and are never accepted as a tool argument.
- `upload_media` reads local files only from `PLANVORTEX_MCP_UPLOAD_DIRS` (empty by default) and
  refuses URLs that resolve to private addresses.
- A shared token bucket caps all outbound traffic, so a model in a loop cannot flood the API.

## [0.0.1] — 2026-08-31

Name reservation, published by hand so that npm trusted publishing could be configured against an
existing package. Not intended for use.

[0.1.2]: https://github.com/taliasoftworks/PlanVortexMCP/releases/tag/v0.1.2
[0.1.1]: https://github.com/taliasoftworks/PlanVortexMCP/releases/tag/v0.1.1
[0.1.0]: https://github.com/taliasoftworks/PlanVortexMCP/releases/tag/v0.1.0
