# Security policy

## Reporting a vulnerability

**Do not open a public issue.** Write to <contact@planvortex.com> with the details and, if you can,
a way to reproduce it. You will get an answer within a few working days.

Please include the package version, the Node version, the transport (stdio or `--http`), and which
MCP client you were using.

## What this server is, in security terms

It runs on your machine with **your** PlanVortex app credentials inside the process, and it puts
text written by strangers — comments, reviews, private messages — in front of a language model that
also holds tools to publish under your brand. That combination is the whole threat model.

Three decisions follow from it, and they are not configurable:

- **No tool deletes anything.** Not a post, not an account, not a contact, not a comment. If a
  prompt injection succeeds, the worst case is a post the user sees and removes, rather than a
  wiped inbox.
- **All third-party text is delimited and labelled** as untrusted before it reaches the model, and
  it never enters a tool description or a cached resource, where the client would not mark it.
- **Credentials arrive through the environment**, never as a tool argument. A secret in a tool
  parameter ends up in the model's context, in the conversation history and in the client's log.

None of this makes prompt injection impossible. It makes the blast radius small.

## In scope

- A secret appearing in a log line, an error message or a tool result.
- Reaching the `--http` endpoint without the configured `PLANVORTEX_MCP_AUTH_TOKEN`, or from a
  disallowed `Origin`.
- `upload_media` reading a file outside `PLANVORTEX_MCP_UPLOAD_DIRS`, or fetching a URL that
  resolves to a private address.
- A request going somewhere other than the configured `PLANVORTEX_BASE_URL`.
- A way to escape the `untrusted_content` wrapper from inside a comment.

## Not in scope

- **A model doing something silly with a comment it read.** Wrapping raises the bar; it is not a
  guarantee, and no server can make one. Whether a publish needs human confirmation is decided by
  your MCP client, not here.
- **Binding `--http` to a public address on purpose and sharing the token.** Anyone with that token
  can publish as you; that is what it is for.
- Vulnerabilities in the PlanVortex API itself — those go to PlanVortex support.

## Supported versions

The latest published minor version receives security fixes.
