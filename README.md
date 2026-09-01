# planvortex-mcp

[![smithery badge](https://smithery.ai/badge/taliasoftworks/planvortex)](https://smithery.ai/servers/taliasoftworks/planvortex)

The official [Model Context Protocol](https://modelcontextprotocol.io) server for
[PlanVortex](https://planvortex.com). It lets an AI assistant — Claude Desktop, Claude Code, Cursor,
VS Code — schedule posts, read the comment inbox and answer private messages across eleven social
networks: Facebook, Instagram, LinkedIn, TikTok, X, WhatsApp, YouTube, Google Business, Bluesky,
Discord and Telegram.

> **You need a PlanVortex app, and apps are part of the Custom plan.**
> The server authenticates with a `client_id` and a `client_secret` that you create in the
> PlanVortex panel under Settings → Apps. On any other plan those credentials cannot be created, and
> this server has nothing to connect with.

## Install

Nothing to install: your MCP client starts it with `npx`.

### Claude Desktop, Cursor, VS Code

```json
{
    "mcpServers": {
        "planvortex": {
            "command": "npx",
            "args": ["-y", "planvortex-mcp"],
            "env": {
                "PLANVORTEX_CLIENT_ID": "...",
                "PLANVORTEX_CLIENT_SECRET": "...",
                "PLANVORTEX_ORGANIZATION_ID": "optional, but saves a call per conversation"
            }
        }
    }
}
```

### Claude Code

```bash
claude mcp add planvortex \
  --env PLANVORTEX_CLIENT_ID=... \
  --env PLANVORTEX_CLIENT_SECRET=... \
  -- npx -y planvortex-mcp
```

Then ask for something: _"what do I have scheduled this week, and which comments are still
unread?"_

## What it can do

Twenty-five tools, grouped by what they act on.

| Group      | Tools                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| Context    | `list_organizations`, `list_accounts`, `get_plan_use`, `get_unread_counts`                              |
| Publishing | `list_publications`, `get_publication`, `create_publication`, `update_publication`, `retry_publication` |
| Media      | `upload_media`                                                                                          |
| Comments   | `list_comments`, `get_comment_thread`, `reply_to_comment`, `hide_comment`, `mark_comment_read`          |
| Messages   | `list_conversations`, `list_messages`, `send_message`                                                   |
| Numbers    | `get_dashboard_summary`, `get_publication_stats`, `get_top_publications`, `get_account_metrics`         |
| Catalog    | `get_social_limits`, `get_social_capabilities`, `create_connect_link`                                   |

Plus three prompts — `weekly_plan`, `inbox_triage`, `publish_from_brief` — and four resources with
the per-network limits, capabilities, comment matrix and your organizations.

### Two things it deliberately cannot do

**It never deletes anything.** No tool removes a post, an account, a contact or a comment. This is
not a switch you can turn on; the code is not there. The reason is in the security section below.

**It cannot connect a social account.** Connecting Instagram is an OAuth flow with a person clicking
"authorize" on Meta's own screen, and an app with client credentials cannot do that — nobody's app
can. `create_connect_link` returns a single-use link that expires in fifteen minutes; hand it to the
user and let them open it.

## Security

This server runs on your machine with your app's `client_secret` inside the process, and it feeds a
language model text that **members of the public wrote** — comments, reviews, DMs — while that same
model holds tools that publish under your brand.

That is a prompt-injection surface by construction, and it is worth knowing how it is handled:

- Every comment, review and incoming message arrives wrapped in an `untrusted_content` block with an
  explicit notice that it is data, not instructions. It is not a guarantee — no wrapper is — but it
  raises the bar.
- **No destructive tools.** If an injection succeeds, the worst case is a post you can see and
  delete, not four thousand deleted contacts.
- Third-party text never enters a tool description or a cached resource, where your client would not
  mark it as untrusted.
- Whether a publish is confirmed by a human is decided by your MCP client, not by this server. The
  tools declare the annotations that make clients show the warning; keep them on.

Set `PLANVORTEX_MCP_READ_ONLY=1` to remove the nine write tools from the listing entirely — useful
if you want to give an unsupervised agent read access and nothing else.

### The `--http` mode

`planvortex-mcp --http` serves MCP over HTTP for a self-hosted deployment. **The process holds your
`client_secret`**, so anything that can reach the port can publish to your accounts with a plain
`curl`. Therefore:

- it binds to `127.0.0.1` by default;
- binding anywhere else **requires** `PLANVORTEX_MCP_AUTH_TOKEN` and the server refuses to start
  without it;
- the `Origin` header is validated on every request (DNS rebinding);
- TLS is your reverse proxy's job — put one in front;
- and a token from the request is never forwarded to PlanVortex. It authenticates against this
  process and stops here.

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e PLANVORTEX_CLIENT_ID=... -e PLANVORTEX_CLIENT_SECRET=... \
  -e PLANVORTEX_MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  planvortex-mcp --http --host 0.0.0.0
```

## Environment variables

| Variable                     | Required                   | What it does                                                   |
| ---------------------------- | -------------------------- | -------------------------------------------------------------- |
| `PLANVORTEX_CLIENT_ID`       | yes                        | The app from your Custom plan.                                 |
| `PLANVORTEX_CLIENT_SECRET`   | yes                        | Its secret. Never passed as a tool argument.                   |
| `PLANVORTEX_ORGANIZATION_ID` | no                         | Default organization. Saves a discovery call per conversation. |
| `PLANVORTEX_BASE_URL`        | no                         | Point at another PlanVortex deployment.                        |
| `PLANVORTEX_MCP_UPLOAD_DIRS` | no                         | Directories `upload_media` may read from. Empty means none.    |
| `PLANVORTEX_MCP_AUTH_TOKEN`  | with `--http` off-loopback | Bearer token the HTTP endpoint requires.                       |
| `PLANVORTEX_MCP_READ_ONLY`   | no                         | `1` removes the nine write tools.                              |
| `PLANVORTEX_MCP_LOG_LEVEL`   | no                         | `debug`, `info`, `warn`, `error`, `silent`. Always to stderr.  |

### Uploading media

With stdio the server runs on your machine, so `upload_media` accepts an **absolute local path** —
but only inside `PLANVORTEX_MCP_UPLOAD_DIRS`, which is empty by default. Set it to the folders you
actually want reachable:

```
PLANVORTEX_MCP_UPLOAD_DIRS=/Users/you/Pictures,/Users/you/Downloads
```

Reading an arbitrary path is exactly what an injected prompt would ask for, so there is no way to
disable the allowlist. In `--http` mode a local path is refused outright: it would be a path on the
server, not on your machine. Pass a public https URL there.

## Which organization?

Almost everything in PlanVortex hangs off an organization. The server resolves it in three steps:
the `id_organization` argument if the model passed one, then `PLANVORTEX_ORGANIZATION_ID`, and
finally — only if your app reaches exactly one — that one. If it reaches several and nothing says
which, the tool answers with the list of names and ids so the model can retry correctly, rather than
failing with a bare error.

## Development

```bash
npm install
npm test          # layers 1 and 2: no network, no credentials
npm run build
npm run inspector # MCP Inspector against the built server
```

Built on [`planvortex`](https://www.npmjs.com/package/planvortex), the official Node client. This
server speaks no HTTP of its own: every call goes through the library, which is where the error
catalogue, the token cache, the multipart upload and the pagination already live.

## Links

- [PlanVortex for developers](https://planvortex.com/developers)
- [`planvortex` for Node](https://www.npmjs.com/package/planvortex) · [`planvortex` for Python](https://pypi.org/project/planvortex/)
- [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

MIT © Talia Softworks
