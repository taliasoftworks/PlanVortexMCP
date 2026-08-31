# Changelog

All notable changes to `planvortex-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- First working server. Twenty-five tools over the PlanVortex API, three prompts and four catalog
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
