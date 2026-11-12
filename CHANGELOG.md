# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-12

### Added

- Local stdio MCP server for the Tremendous rewards API, with OAuth 2.0 login (`npm run login`).
- Read tools: `get_account`, `list_funding_sources`, `list_products`, `list_campaigns`, `get_campaign`, `list_orders`, `get_order`, `get_reward`.
- `list_rewards`: who received rewards, with per-recipient totals and filters (email, name, dates, campaign, delivery status).
- `review_rewards`: checks a reward batch without sending.
- Write tools: `send_rewards` (idempotent per recipient), `resend_reward`, `cancel_reward`, `generate_reward_link`, `approve_order`, `reject_order`.
- MCP Apps views: rewards dashboard and editable send form.
- Single-use refresh tokens refreshed under a file lock.
- Sandbox by default; `TREMENDOUS_ENV=production` for real money.

[Unreleased]: https://github.com/Bryan21B/tremendous-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Bryan21B/tremendous-mcp/releases/tag/v0.1.0
