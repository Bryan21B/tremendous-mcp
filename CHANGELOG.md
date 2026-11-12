# Changelog

## [0.1.2](https://github.com/Bryan21B/tremendous-mcp/compare/v0.1.1...v0.1.2) (2026-11-12)

### Bug Fixes

* **login:** receive the OAuth callback on https://localhost with a self-signed certificate ([c8f2762](https://github.com/Bryan21B/tremendous-mcp/commit/c8f2762603597d1483ddef4c8d8e643ccccbdfcc))

## [0.1.1](https://github.com/Bryan21B/tremendous-mcp/compare/v0.1.0...v0.1.1) (2026-11-12)

### Bug Fixes

* **login:** keep asking for the callback address and explain what was copied ([5304bab](https://github.com/Bryan21B/tremendous-mcp/commit/5304bab1bb56dcac74117ed6001b7358397ea614))

## 0.1.0 (2026-11-12)

### Features

* local stdio MCP server for the Tremendous rewards API, with OAuth 2.0 login (`npm run login`)
* read tools: `get_account`, `list_funding_sources`, `list_products`, `list_campaigns`, `get_campaign`, `list_orders`, `get_order`, `get_reward`
* `list_rewards`: who received rewards, with per-recipient totals and filters (email, name, dates, campaign, delivery status)
* `review_rewards`: checks a reward batch without sending
* write tools: `send_rewards` (idempotent per recipient), `resend_reward`, `cancel_reward`, `generate_reward_link`, `approve_order`, `reject_order`
* MCP Apps views: rewards dashboard and editable send form
* single-use refresh tokens refreshed under a file lock
* sandbox by default; `TREMENDOUS_ENV=production` for real money
