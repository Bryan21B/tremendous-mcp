# tremendous-mcp

An [MCP](https://modelcontextprotocol.io) server for the [Tremendous](https://www.tremendous.com) rewards API. Use it to send rewards from an AI assistant, see who has received rewards, and manage orders that need approval.

The server runs on your computer over stdio. It works with Claude Desktop, Claude Code and other MCP clients. Two tools also show interactive views in clients that support [MCP Apps](https://github.com/modelcontextprotocol/ext-apps).

> This project is not affiliated with Tremendous.

## Features

- **Send rewards** to one or more recipients (email, SMS or link delivery), with a campaign or a list of products.
- **See who received rewards**: one summary for each recipient (number of rewards, total, last date), with filters for email, name, dates, campaign and delivery status.
- **Fix failed deliveries**: resend a reward (optionally to a corrected email or phone), or cancel it.
- **Approve or reject** orders in `PENDING APPROVAL`.
- **Read the account**: organization, funding sources and balance, product catalog, campaigns, orders.
- **Interactive views** (MCP Apps): a rewards dashboard and an editable send form.
- **Sandbox by default**: the server uses the Tremendous sandbox (fake money) until you set `TREMENDOUS_ENV=production`.

## Requirements

- Node.js 20.11 or later.
- A Tremendous account with admin access, to register an OAuth app.
- Optional: the [1Password CLI](https://developer.1password.com/docs/cli/), if you want to keep the client secret out of your shell environment.

## Setup

### 1. Register a Tremendous OAuth app

Start in the sandbox: https://testflight.tremendous.com.

1. Go to **Team settings → Developers → Developer apps** and click **Register app**.
2. Set the redirect URI to `https://localhost:8787/callback`. Tremendous accepts only `https` redirect URIs. No server has to run at this address (see step 3).
3. Keep the client ID and the client secret.

For production, register a second app at https://api.tremendous.com.

### 2. Install and build

```sh
git clone https://github.com/Bryan21B/tremendous-mcp.git
cd tremendous-mcp
npm install
npm run build
```

### 3. Log in

Give the client credentials to the login script in one of these two ways.

Option A: environment variables:

```sh
export TREMENDOUS_CLIENT_ID=...
export TREMENDOUS_CLIENT_SECRET=...
npm run login
```

Option B: 1Password references:

```sh
cp .env.op.example .env.op   # then edit the op:// paths
op run --env-file=.env.op -- npm run login
```

The login opens your browser:

1. Log in to Tremendous and allow access.
2. The browser goes to `https://localhost:8787/callback` and shows a "can't connect" page. This is expected: the authorization code is in the address bar.
3. Copy the full address (Cmd+L, Cmd+C on macOS).
4. Go back to the terminal and press Enter. The script reads the address from the clipboard. You can also paste the address, then press Enter.

The script then shows "Connected to: <your organization>".

The script writes the tokens to `~/.config/tremendous-mcp/tokens.<env>.json`, with mode `0600`. Tremendous refresh tokens are single-use. The server refreshes them under a file lock, so two clients can run the server at the same time.

> Reading the clipboard uses `pbpaste` (macOS). On other systems, paste the address into the terminal.

### 4. Add the server to your MCP client

The server needs the client credentials at run time, because it refreshes the tokens.

**Claude Code**

```sh
claude mcp add tremendous -s user \
  -e TREMENDOUS_ENV=sandbox \
  -e TREMENDOUS_CLIENT_ID=... \
  -e TREMENDOUS_CLIENT_SECRET=... \
  -- node /absolute/path/to/tremendous-mcp/build/index.js
```

**Claude Desktop** (`claude_desktop_config.json`, in `mcpServers`)

```json
"tremendous": {
  "command": "node",
  "args": ["/absolute/path/to/tremendous-mcp/build/index.js"],
  "env": {
    "TREMENDOUS_ENV": "sandbox",
    "TREMENDOUS_CLIENT_ID": "...",
    "TREMENDOUS_CLIENT_SECRET": "..."
  }
}
```

With 1Password, do not put the secrets in the configuration file. Launch through `op run` instead:

```json
"tremendous": {
  "command": "op",
  "args": ["run", "--env-file=/absolute/path/to/tremendous-mcp/.env.op", "--",
           "node", "/absolute/path/to/tremendous-mcp/build/index.js"],
  "env": { "TREMENDOUS_ENV": "sandbox" }
}
```

Claude Desktop does not use your shell `PATH`. If it cannot find `op` or `node`, use the full path (for example `/opt/homebrew/bin/op`). Restart Claude Desktop after you change the file.

## Tools

| Tool                             | Type        | What it does                                                                        |
| -------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `get_account`                    | read        | Organization, environment, funding sources and balance                              |
| `list_funding_sources`           | read        | Balance, cards, bank accounts, invoice                                              |
| `list_products`                  | read        | Reward catalog. Filter by country, currency, name and category                      |
| `list_campaigns`, `get_campaign` | read        | Campaigns (reward templates)                                                        |
| `list_orders`, `get_order`       | read        | Orders. Filter by date, campaign, `external_id` and status                          |
| `get_reward`                     | read        | One reward and its delivery status                                                  |
| `list_rewards`                   | read + view | Who received rewards. Filter by email, name, dates, campaign and delivery status    |
| `review_rewards`                 | read + view | Check a batch and show the send form. This tool sends nothing                       |
| `send_rewards`                   | **write**   | Send rewards. Makes one order for each recipient                                    |
| `resend_reward`                  | **write**   | Resend after a delivery failure                                                     |
| `cancel_reward`                  | **write**   | Cancel a reward that is not redeemed                                                |
| `generate_reward_link`           | **write**   | New redemption link (LINK rewards only). Anyone with the link can redeem the reward |
| `approve_order`, `reject_order`  | **write**   | Orders in `PENDING APPROVAL`. Requires "Allow approvals via API" in Tremendous      |

The typical flow to send rewards is `review_rewards`, then the user checks the draft, then `send_rewards` with the same `draft_id`.

### Interactive views (MCP Apps)

- **Rewards dashboard** (`list_rewards`): totals, search, delivery-status filters, a "by recipient" or "all rewards" table, **Resend** and **Cancel** buttons on failed rewards, and **Load more** for older rewards.
- **Send form** (`review_rewards`): edit the recipients, amounts, campaign, funding source, delivery method and message, then click **Send** and **Confirm**. The form then shows the result for each recipient.

All tools also return a text summary, for clients that do not show the views.

## Safety

- **Sandbox first.** The default environment is the sandbox. Each tool result shows `SANDBOX` or `PRODUCTION`.
- **Write tools are marked.** Tools that spend money or cannot be undone have `destructiveHint: true`. Most clients then ask you before each call. This does not occur if you select "Always allow". Do not select "Always allow" for the write tools.
- **Buttons in the views call tools directly.** Your client may not ask you first. In the send form, the two clicks (Send, then Confirm) are the only check.
- **No double payments on retry.** `send_rewards` gives each reward the Tremendous `external_id` `mcp-<draft_id>-<hash of the recipient>`. The hash comes from the email, else the phone, else the name. If you send the same draft again, Tremendous returns the existing order for each recipient who was already paid. This is also true if you remove, reorder or add recipients. If you change the amount for a recipient who was already paid, Tremendous returns a 409 conflict and does not make a second payment.
- **Insufficient funds stop the batch.** After a `402` response, the server does not try the remaining recipients.
- **No step-up authentication.** The OAuth login gives full access within the granted scope.

## Configuration

| Variable                                           | Default                           | Use                                                                        |
| -------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| `TREMENDOUS_ENV`                                   | `sandbox`                         | `sandbox` (testflight.tremendous.com) or `production` (api.tremendous.com) |
| `TREMENDOUS_CLIENT_ID`, `TREMENDOUS_CLIENT_SECRET` | none                              | OAuth app credentials                                                      |
| `TREMENDOUS_SCOPES`                                | `default`                         | OAuth scopes                                                               |
| `TREMENDOUS_REDIRECT_URI`                          | `https://localhost:8787/callback` | Must be the same as the redirect URI of the app                            |
| `TREMENDOUS_TOKEN_DIR`                             | `~/.config/tremendous-mcp`        | Folder for the token files                                                 |

### Use production

1. Register an app at https://api.tremendous.com with the same redirect URI.
2. Log in with the production credentials: `TREMENDOUS_ENV=production npm run login`.
3. Set `TREMENDOUS_ENV=production` in your MCP client configuration.

The sandbox and production use different token files, so you can keep both.

## Notes and limitations

- **Recipient search scans rewards.** The Tremendous API cannot filter rewards by recipient. `list_rewards` reads up to `max_scan` rewards (default 5,000, 500 for each request) and filters them. With a date range or a campaign, the tool reads orders instead, because the API can filter orders by date and campaign. If the result is truncated, call the tool again with `offset=next_offset`, or click **Load more** in the dashboard.
- **One order for each reward.** The Tremendous API requires this. A batch of N recipients makes N requests, one after the other.
- **Not verified yet:**
  - PKCE support. The login does not use PKCE.
  - Whether the `default` scope is sufficient for order approvals.

## Development

| Command                                  | What it does                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run build`                          | Compile the server to `build/` and bundle each view into one HTML file in `dist/` |
| `npm test`                               | Unit and contract tests with a fake Tremendous API (no network)                   |
| `npm run typecheck`                      | Type-check the server and the views                                               |
| `npm run lint`                           | Biome lint and format check (`npm run lint:fix` fixes)                            |
| `npm run check`                          | Lint, typecheck, tests and build (what CI and the pre-push hook run)              |
| `npm run login`                          | Interactive OAuth login                                                           |
| `npm run smoke -- <email> [campaign_id]` | Live test against the **sandbox** only: sends a 1.00 reward to `<email>`          |

Project layout:

```
src/
  index.ts          stdio entry point
  server.ts         MCP server: tools and UI resources
  tools/read.ts     read-only tools (including the two view tools)
  tools/write.ts    tools that spend money or cannot be undone
  rewards-query.ts  paging and filtering for list_rewards
  client.ts         REST client: refresh on 401, backoff on 429, readable errors
  token-store.ts    token file, locked single-use refresh
  login.ts          OAuth login script
ui/                 MCP Apps views (plain TypeScript and CSS, bundled with Vite)
test/               Vitest tests and a fake Tremendous API
```

## Releases and versioning

This project uses [Semantic Versioning](https://semver.org). The version in `package.json` is the single source of truth. The server reports it to MCP clients, and the views use it too.

Releases are automatic. On each push to `main`, CI runs the checks. If they pass, [semantic-release](https://semantic-release.gitbook.io) reads the commit messages since the last tag. It then sets the next version, updates `CHANGELOG.md` and `package.json`, tags `v<version>` and makes the GitHub release.

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org). The type sets the version:

| Commit type                                                        | Release                                |
| ------------------------------------------------------------------ | -------------------------------------- |
| `feat:`                                                            | minor (0.**x**.0)                      |
| `fix:`, `perf:`                                                    | patch (0.x.**y**)                      |
| `feat!:` or a `BREAKING CHANGE:` footer                            | minor while the version is below 1.0.0 |
| `docs:`, `test:`, `chore:`, `ci:`, `refactor:`, `style:`, `build:` | no release                             |

The public interface is the tool names, their input fields and their results. A change that breaks it is a breaking change.

### Git hooks

`npm install` installs these hooks (husky):

- **commit-msg**: rejects a subject that is not a Conventional Commit.
- **pre-commit**: Biome on the staged files, then the typecheck.
- **pre-push**: a secret scan of the commits to push, then `npm run check` (lint, typecheck, tests, build).

## License

[MIT](LICENSE)
