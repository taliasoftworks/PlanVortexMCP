# Changelog

All notable changes to `planvortex-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-04

**PlanVortex writes the content, and until today the one surface built for agents was the only one
that could not ask it to.**

The server shipped twenty-five tools and not one of them reached the AI planner. The gap was easy to
miss because a prompt papered over it: `weekly_plan` walked the model through the accounts, the
calendar and the top posts, and then had the _model_ write the texts. That is a decent prompt and it
is also what any MCP server can do with no product behind it. The one thing PlanVortex has that a
generic tool does not — a planner that turns a theme, your own photos, an article or a connected
shop's catalogue into a week of posts — was not reachable from here at all.

It was left out on purpose, and the reason was good: creating a plan spends AI credits, and an agent
that retries in a loop is the worst possible caller for an endpoint that bills. The plan was to wait
for the protocol's own confirmation flow (elicitation, redesigned in the 2026-07-28 spec) and let
the server ask before spending. Almost no client implements it yet, so waiting meant waiting
indefinitely.

The way out was noticing that the reason covers `create`, not reading. **The three read tools are
always there; creating is switched on by a person, once, in the configuration file.** That is the
same confirmation elicitation would ask for, moved to a place that exists today — and because the
switch acts at registration, with it off `create_ai_plan` is not in `tools/list` at all, so nothing
can call it.

### Added

- **`get_planner_templates`** — the five templates (`standard`, `from_images`, `from_text`,
  `from_catalog`, `campaign`) with what each one costs, which options it accepts and how many source
  items it takes. Read, never remembered: these are prices, and the one number that changes a user's
  mind is that a template which does not generate images costs a fraction — a week of 7 posts with a
  picture each is 519 credits on `standard` and 48 on `from_images`.
- **`list_ai_plans`** and **`get_ai_plan`** — the plans and their state. `get_ai_plan` is what you
  poll after creating one, and it hands back the **ids** of the drafts rather than a count, because
  a count is two posts the model cannot open.
- **`create_ai_plan`**, behind `PLANVORTEX_MCP_ALLOW_AI=1`. It does not return posts: it queues the
  plan and returns the budget that was approved, and generation takes minutes.
- **`PLANVORTEX_MCP_ALLOW_AI`**, in `server.json`, the README and `--help`.
- `Context.resolveClient()`. The AI plan routes hang off **two** identifiers
  (`/clients/:id/organizations/:id/ai_plans`) and are the only ones in this server that do. Asking
  the model for an `id_client` it has no way to know is asking it to invent one, so it is resolved
  from the same `/clients_organizations` call that already resolves the organization — no extra
  request. A child organization is not in that map (it only carries root ones), so with a single
  client it uses that one instead of claiming the organization does not exist.

### Changed

- **The `weekly_plan` prompt offers the planner before writing anything itself.** It used to
  walk the model through the calendar and then have the MODEL write the texts, which is what
  any MCP server can do with no product behind it. It now shows what a plan can be generated
  from and what it costs, and only falls back to writing them by hand if the user prefers.
- The server `INSTRUCTIONS` now say PlanVortex writes the content, that it costs credits and that
  what comes out are drafts. It is the first thing a model reads, and the AI was absent from it.
- Twenty-eight tools by default, twenty-nine with the AI switch, nineteen under
  `PLANVORTEX_MCP_READ_ONLY`.
- **`PLANVORTEX_MCP_READ_ONLY` wins over `PLANVORTEX_MCP_ALLOW_AI`.** A server declared read-only
  does not create plans, whatever else is switched on.

### Fixed

- **The first message a new user reads no longer sends them to pay for something they already
  have.** `CREDENTIALS_HELP` said "apps are part of the Custom plan", which was true until
  02-09-2026, when `requireCustomPlan` came off the app routes and every plan got apps — 1 on Free,
  2 on Basic, 5 on Pro, 10 on Custom. It is what a person sees when they start the server with no
  credentials, so of all the places to be a plan behind, it was the worst one. Same sentence
  corrected in the README, `server.json` and `manifest.json`; a test now asserts it does not come
  back.

### What is deliberately still missing

- **`validate_ai_plan`.** Validating turns the whole generated week into scheduled posts in one
  call, which is exactly the multiplier the original decision was worried about. What a plan
  produces are ordinary drafts, so an agent that wants to schedule one already has
  `update_publication` — one post at a time, with a person reading each text.
- **Deleting or cancelling a plan.** This server still deletes nothing.

## [0.1.6] — 2026-09-03

**Publications are unlimited**, and until today this server was the last place still telling agents
otherwise.

That is worse here than in a typed library. A wrong type stops a build; a wrong sentence in a tool
description is read by a model that then decides not to schedule the user's week. `get_plan_use`
printed a `publications` row whose `limit` had quietly become `undefined` — and `asLines` drops
`undefined`, so the model saw a counter climbing towards a ceiling nobody named.

### Changed

- `get_plan_use` reports `publications_this_month` with an explicit `unlimited` limit, and its
  description says so twice: publications have no ceiling, and what can stop a batch is rate.
- **The two rate brakes now get their own advice.** Errors 978 (too fast on this account) and 979
  (that network's daily cap) are the only things that can stop a batch now, and both are
  transient — the one thing the generic advice got backwards, since it told the model to fix the
  post and call again. They are handled before the error family is even looked at, because they
  were born above 960 and arrive unclassified with the published `planvortex`.
- Error **924** (the monthly plan quota) is gone from the advice: the server retired it on
  02-09-2026. **926**, the per-account safety net, stays and now says it is not something the user
  fixes by paying more.
- The `weekly_plan` prompt no longer tells the model to check there is room in the plan before
  proposing posts.
- **The API's own rate limit (545) is answered as what it is.** The public API is on every plan now,
  free included, and it comes with a per-plan ceiling — so this server, which authenticates as an
  app, can meet it on any tool. It lands in the `auth` family, whose advice talks about checking
  credentials; a freshly minted token would hit it exactly the same. It is handled with the other
  rate brakes instead: transient, wait what `Retry-After` says, do not retry in a loop.

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
