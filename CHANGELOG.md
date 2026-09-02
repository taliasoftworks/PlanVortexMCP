# Changelog

All notable changes to `planvortex-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] — 2026-09-02

The release that says twelve. Threads landed in the backend and this server never noticed, because
nothing in it enumerates networks: `social_network` travels as a plain string and `SocialNetwork` in
the library is an open enum, so every tool worked with a Threads account from day one while every
sentence a person or a directory reads still said eleven.

### Changed

- **Threads is in the network list**, in the six places that are prose and no test watches: the
  `INSTRUCTIONS` the MCP client hands the model, the README, `package.json`, `server.json` and
  `manifest.json` (`description` **and** `long_description`).
- **The two tool descriptions that enumerate capabilities**, which is where being out of date
  actually misleads the model: `list_conversations` now says Threads has no private messages
  (it does not: a Threads account has no inbox), and the comment-actions note counts it among the
  networks that cannot delete somebody else's reply.
- **`planvortex` bumped to `^0.7.0`**, the first version whose types know the twelfth network. The
  caret on a `0.x` version does not cross a minor, so this had to be explicit.

## [0.1.4] — 2026-09-02

The release that made the server visible to a directory, and the trail that led there started with a
listing that read `Container exited with code 1 before responding to ping`.

### Fixed

- **The Docker image never served anything, in any mode.** Its `ENTRYPOINT` ran `dist/index.js`,
  which only _exports_ — the `bin` is `dist/cli.js` — so the container started, exited with code 0
  in silence and never spoke a word of MCP. That is the failure the two-file split
  (`index.ts`/`cli.ts`) exists to warn about, and it went unnoticed because nothing ran the image.

- **The `.mcpb` bundle had the same bug, and had never worked either.** `manifest.json` declared
  `dist/index.js` as its entry point, so Claude Desktop installed the bundle with a double click and
  started a process that exited with code 0 in silence — the server simply never appeared. It is the
  same file as the Dockerfile's, found the same way: by running what the manifest says instead of
  reading it.

- **The image now speaks stdio by default.** It was pinned to `--http --host 0.0.0.0`, which is not
  what a container of an MCP server is for: a client starts one with `docker run -i` and a
  directory (Glama, Smithery) builds the Dockerfile, runs the image and asks for `tools/list` — and
  neither of those speaks HTTP. The `--http` mode is unchanged and now an argument behind the
  image: `docker run ... planvortex-mcp --http --host 0.0.0.0`.

- **Missing credentials no longer kill the process over stdio.** `PLANVORTEX_CLIENT_ID` and
  `PLANVORTEX_CLIENT_SECRET` were required to boot, so a directory introspecting the server with no
  environment at all got `Container exited with code 1 before responding to ping` and the listing
  stayed empty. The server now starts, lists its 25 tools, and fails on the first tool that reaches
  PlanVortex with the same message it used to print — which is also a better deal for whoever
  misconfigures it in an MCP client: that message now arrives _in the conversation_ instead of
  dying in a log behind "server disconnected". It still goes to `stderr` at startup, and no client
  is built without credentials. In `--http` the process still refuses to start: that is a
  deployment, and one that answers `200` while every tool fails is worse than one that does not
  come up.

### Added

- **`scripts/introspect.mjs`, and CI now runs the Docker image.** All three bugs above shared one
  cause: the four test layers exercise the server, and nothing ever ran the image or the binary over
  a real stdio pipe. The script takes any command — `node dist/cli.js`, `docker run -i --rm <image>`
  — and performs the handshake a directory performs: `initialize`, the three listings, and a tool
  call. CI builds the Dockerfile and runs it against the image, plus the `--http` mode inside the
  container, which had never been exercised either, and it runs whatever command `manifest.json`
  declares — checking on the way that `entry_point` and `mcp_config.args` still name the same file.
  The old check that asserted the server _refuses_ to start without credentials is now the opposite
  check, for the reason above.

## [0.1.3] — 2026-09-01

### Fixed

- **Four families of API error were explained to the model with advice that could not be followed.**
  All of them came out of running the layer 3 suite against a real PlanVortex for the first time.

    The error catalogue groups codes by range, and a range is not a diagnosis. Error **516**
    ("this needs a paid plan") lives in the 500-544 block, which the library calls `auth`, so the
    server answered "your credentials were rejected, check `PLANVORTEX_CLIENT_ID` and
    `PLANVORTEX_CLIENT_SECRET`" — with perfect credentials, sending whoever read it to inspect a
    configuration file that was fine. The same block also holds **511**, **515**, **517** and
    **542** (the Custom plan), plus **512** and **519**, which are not credentials either: they are
    things an app cannot do with any credentials, and now point at `create_connect_link`.

    Error **917** ("that publication does not exist") sat in the publication range and came back as
    "this is a problem with the post itself, fix the text or the media" — there is no text to fix
    when the id is wrong. **921**, **924** and **926** were misfiled the same way.

    And **1502** ("this network has no direct messages") was answered with Meta's 24-hour window
    rule, on a call that was not sending anything.

- **A post created with errors read as a post that had gone out.** The server stores a publication
  that does not validate — no title on YouTube, a broken account — with state `withErrors` and the
  reasons inside, and answers `200`. `create_publication` showed `state: withErrors, errors: 2`
  and nothing else, so the model had to call `get_publication` to find out why, or concluded the
  post was published. It now lists the reasons and says plainly that nothing was sent.

### Added

- **Layer 4 (tool choice) is now a script, not a manual pass**: `node scripts/choice-eval.mjs` runs
  the twelve cases of `test/choice.md` through a headless Claude Code with this server as its only
  MCP, and reports which tool each case actually picked. It does not run in CI — it needs a model and
  a stack — and it finds Claude Code inside the VS Code extension, so there is nothing to install.
  A flag it does not recognise stops it: the default run starts twelve models, so a typo must not
  be the thing that pays for them.

### Changed

- `list_comments` no longer prints the untrusted-content warning when the inbox is empty. There is
  no third-party text to mark, and the warning is fifty words the model pays to read.

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

[0.1.4]: https://github.com/taliasoftworks/PlanVortexMCP/releases/tag/v0.1.4
[0.1.3]: https://github.com/taliasoftworks/PlanVortexMCP/releases/tag/v0.1.3
[0.1.2]: https://github.com/taliasoftworks/PlanVortexMCP/releases/tag/v0.1.2
[0.1.1]: https://github.com/taliasoftworks/PlanVortexMCP/releases/tag/v0.1.1
[0.1.0]: https://github.com/taliasoftworks/PlanVortexMCP/releases/tag/v0.1.0
