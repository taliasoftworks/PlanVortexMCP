# Contributing

Thanks for taking the time. This is the official MCP server for the PlanVortex API, and it is
developed in the open.

## Before you start

- **Bugs and questions about the API itself** (an endpoint that answers something unexpected, a
  permission that does not behave) belong in PlanVortex support, not here.
- **A new endpoint does not start here either.** This server speaks no HTTP: it calls
  [`planvortex`](https://github.com/taliasoftworks/PlanVortexNode), the Node client. Anything a tool
  wants to do has to exist there first — that is what stops a third copy of the API appearing.
- **A tool per endpoint is not the goal.** The API has 113 operations and this server has 25 tools.
  A mirror of the REST API is ~40.000 tokens of definitions before the first question and a worse
  choice of tool. Tools are written for the model, not for the API: `list_comments` with an unread
  filter beats six comment endpoints.

## Setting up

```bash
npm install
npm test
```

The tests need no network and no credentials, on purpose.

## Testing

Four layers, and each one catches something the others cannot.

| Layer            | What it pins                                                                                                             | Command             | Cost            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------- | --------------- |
| **1 — tools**    | Each tool's logic with the API mocked (`msw`): projections, error translation, organization resolution, dedupe cache.    | `npm test`          | free            |
| **2 — protocol** | The server through a **real MCP client** over an in-memory transport: tool order, schemas, `isError`, stdout purity.     | `npm test`          | free            |
| **3 — live**     | The 25 tools end to end against a real PlanVortex stack. The only layer that sees an `outputSchema` that no longer fits. | `npm run test:live` | needs the stack |
| **4 — choice**   | That a model picks the right tool first time for a plain-language request.                                               | manual              | needs a model   |

Layers 1 and 2 run in CI. An unmocked request fails the test, so a tool that calls the wrong route
cannot go green quietly.

**Layer 4 is the one with no equivalent in the libraries, and it gives the most signal: a tool
nobody picks is a broken tool, however green its tests are.** Run the cases in `test/choice.md` by
hand against a real client before a release.

## The rules that are not negotiable

Each of these is a trap that already cost someone a day, here or in the server:

- **Nothing writes to `stdout`.** In stdio the protocol travels through it; a stray `console.log`
  corrupts the JSON-RPC and the symptom is a server that "does not start", with no error anywhere.
  All logs go through `src/log.ts`, to `stderr`. ESLint enforces it and a test watches it.
- **No deletion tools.** Ever. This server reads text written by strangers while holding tools that
  publish under a client's brand; the small blast radius is the mitigation.
- **Third-party text is wrapped**, and never enters a tool description or a cached resource.
- **Credentials come from the environment**, never from a tool argument.
- **Every list returns a short projection** with `limit` 10 and a cap of 50, and says out loud when
  it truncated and how many remain. A silent truncation is how a model ends up telling someone they
  have no more posts.
- **Missing metrics are omitted, not zeroed.** Telegram and Bluesky have no impressions; a `0` there
  reads as "nobody saw it".
- **Tools are registered in a fixed order** (`src/server.ts`). `tools/list` is cached with a TTL, and
  a shifting order throws away that cache and the model's prompt cache on every conversation.
- **Every outbound call goes through the shared token bucket.** The PlanVortex API has no rate limit
  of its own, and a model that decides to paginate a 3.000-comment inbox is 300 requests a minute
  against production.

## Sending a change

1. A branch off `main`.
2. `npm run lint`, `npm run typecheck` and `npm test` in green.
3. A line in `CHANGELOG.md` under _Unreleased_.
4. If you added or renamed a tool: update the expected list in `test/protocol.test.ts`, the table in
   the README, and add a case to `test/choice.md`.
5. A pull request describing what changes for whoever uses the server.
