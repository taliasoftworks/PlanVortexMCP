# Changelog

All notable changes to `planvortex-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] — 2026-09-24

**Pinterest reaches the server, and it is the first network where choosing the account does not
choose where the post comes out: every pin goes to a board.** A model that does not know that
publishes, reads "created", and reports a pin that never goes out — the server does not reject a
pin without a board, it saves it with error 987. Everything below exists so a model gets it right
from the tool descriptions alone.

### Added

- **`list_destinations`**, a read tool: the boards of a connected Pinterest account, and with
  `id_destination` one board's sections. Its answer says to pass the **id**, not the name, and a
  secret board comes back marked `SECRET`, because a pin there is seen by nobody else.
- **`destination_id`, `destination_section_id` and `link` on `create_publication`**, and
  `destination_id` and `link` on `update_publication`, which is also how a pin saved with the 987
  gets fixed. The description of `create_publication` names the three things a pin needs that no
  other network asks for: a board, an image or a video, and the URL in `link` rather than in the text.
- **They are checked before calling the API**, against `GET /social_capabilities` and not a list
  of ours: a Pinterest post without a board, a board passed by name, or a `link` on a network that
  has no such field (where the server would delete it without a word) all come back as an error
  that says what to do.
- **`destinations` and `options.link` on `create_ai_plan`.** A plan with a Pinterest account needs
  that account's board (2118), and one that would leave pins without an image is refused (2119).
- **Advice for Pinterest's errors**: 987 (no board) and 993 (a board of another account) send the
  model to `list_destinations`, 992 says the network has no destinations, 988 says a personal
  account has no analytics, and **991 is transient** — Pinterest throttling PlanVortex's
  application — so the model waits instead of rewriting the post.
- `get_social_capabilities` gains the `destinations` and `link` columns.

### Changed

- **`planvortex` goes to `^0.12.0`**, the release with the board methods. Same `^0.x` trap as
  always: **publish `planvortex@0.12.0` first and refresh `package-lock.json` before tagging this
  one.**
- The comment tools say that **Pinterest has no comments** to read — its API does not expose
  them — so a model does not read an empty inbox as a delay and retry.
- The instructions list the fourteen networks and give Pinterest a paragraph of its own. The
  package, registry and bundle descriptions no longer count networks: the number went stale with
  every new one.

### Fixed

- **A Pinterest title was counted in graphemes**, so `create_publication` let through titles the
  server rejects with 995: Pinterest counts the title in code points, and a family emoji is one
  grapheme and up to seven code points. The description is counted in UTF-16 units, as the server
  does.

## [0.5.0] — 2026-09-17

**A model can now answer «which of my AI plans worked?» without stitching it together by hand.**

### Added

- **`get_ai_plan_results`**, a read tool, so it is listed with or without
  `PLANVORTEX_MCP_ALLOW_AI`. It returns what every plan achieved with what it published, and the
  aggregate per template. Three sentences in its answer are there because a model gets each of them
  wrong without being told:
    - **`ranked: false` is not a bad plan**, it is a plan with too few measured posts to compare.
      Plans are ranked by interactions per _measured_ post — the total would just reward the plans
      with more accounts — and only those with at least three measured posts compete.
    - **`maturing: true` means the numbers are still moving**, so comparing that plan with last
      month's is unfair to the new one.
    - **A missing metric is not a zero**, as in every other number this server returns.
    - **Being first is not being good.** Every plan carries `vs_your_average` — its interactions per
      post over the organization's own posts on the same networks, where `1x` is the usual level —
      and the note says the first plan in the ranking can still be below `1x`.

        The range filters on the **week the plan published in**, not on when it was created, and the
        empty answer says so: otherwise a plan created today for next week reads as a plan that did
        nothing.

### Changed

- **`planvortex` goes to `^0.11.0`**, the release that adds `aiPlans.results()`. It is the same
  `^0.x` trap 0.4.0 described: `^0.10.0` would never pick it up on its own. **Publish
  `planvortex@0.11.0` first and refresh `package-lock.json` before tagging this one** — until then
  the lock still pins 0.10.0, which has no such method.

## [0.4.0] — 2026-09-13

**Slack is the thirteenth network, and it arrives with the same shape of bug 0.3.0 shipped to fix:
a `^0.x` pin that cannot catch up on its own.**

npm reads `^0.9.0` on a 0.x package as `>=0.9.0 <0.10.0`, so every install would have kept pulling
0.9.0 while 0.10.0 sat published — and 0.10.0 is the release that widens the publication family to
**986**, which is where Slack's own codes live. Without the bump, every Slack failure reached the
model with no family and therefore the generic advice.

### Fixed

- **Slack's 980 no longer tells a model to rewrite the post.** With the family corrected, 980-986
  land in the publication range, whose default guidance is "this is a problem with the post, fix
  the text or the media". For 980 — **the commonest error on that network**: the PlanVortex app is
  not in the channel — that is exactly backwards. Nothing about the post is wrong, retrying with a
  different text fails identically, and what unblocks it is a **person** typing
  `/invite @PlanVortex` inside the channel, which on a private one is the only way at all because
  Slack has no API for an app to join one. 985 (the channel is archived or gone) gets its own
  advice for the same reason, and **984** — Slack's 429 with the retry window exhausted — now goes
  through the rate-brake path with 978, 979 and 545, because it is transient and the generic
  advice would have had the model rewriting a post that was fine. Two tests pin the sentences.

### Changed

- `planvortex` moves from `^0.9.0` to `^0.10.0`.
- **The network count, in the six places it is written by hand**: `package.json`,
  `manifest.json` (both `description` and `long_description`, which is what the Claude Desktop
  directory shows), `server.json`, `README.md` and the `INSTRUCTIONS` the MCP client reads before
  anything else. Twelve networks became thirteen, and eleven that publish became twelve.
- **The tool descriptions that enumerate networks where the capability is uneven**, because Slack
  is absent from most of them: `list_conversations` (it has no private messages — a bot cannot
  start a conversation), `get_comment_thread` and `get_social_capabilities` (it has no comment
  inbox at all), and the missing-metrics note on the stats tools, where Slack joins Telegram and
  Bluesky as a network with **no impressions and no reach anywhere** — and is the most extreme of
  the three, because reactions is the only metric it has.
- **`INSTRUCTIONS` now says what Slack is not.** It is a team channel, not an audience: it
  publishes, it reports reactions, and that is the whole of it. Each channel is a separate account.
  A model that assumes a thirteenth network behaves like the other twelve promises the user a
  comment inbox that does not exist.

## [0.3.0] — 2026-09-04

**The client library underneath was two versions behind, and `^0.7.0` could not have caught up on
its own.**

npm treats `^0.7.0` on a 0.x package as `>=0.7.0 <0.8.0`, so every install since 03-09 kept
pulling 0.7.0 while 0.8.0 sat published. What that cost was not features — it was error
classification. 0.8.0 widened the families this server leans on to tell a model what went wrong:
the publication range now reaches **979**, which is where the two rate brakes live (978, publishing
too fast on this account; 979, that network's daily cap), and 0.8.0 also added **545** (the plan's
API rate limit, a 429 with `Retry-After`), **546** (the email must be verified to create an app)
and **1308** (no more apps fit). Until now all of those arrived as a bare error with no family, so
the guidance handed to the model was generic exactly where it needed to be specific.

### Changed

- `planvortex` moves from `^0.7.0` to `^0.9.0`. Nothing in this server used the plan keys that
  0.9.0 removes (`users`, `artificial_inteligence`, `stats`, `whatsapp`), so there is no code
  change — only the error families and the corrected documentation that come with it.
- Every link to the developer site now points at `/en/developers` instead of `/developers`. The
  site only auto-detects language at its root, so the unprefixed path served Spanish to everyone
  arriving from npm or from the MCP registry — and always to crawlers, which send no
  `Accept-Language`.

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
