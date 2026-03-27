# Fireflies → Clarify Sync (CLI)

A standalone Node.js script for syncing Fireflies.ai transcripts into Clarify CRM. Zero dependencies — just `node sync.mjs` and it works.

> **Disclaimer:** This software is provided "as is", without warranty of any kind. See [LICENSE](../../../LICENSE) for details. Always test with `--dry-run` before running a full backfill.

## Requirements

| Requirement | Details |
|-------------|---------|
| **Node.js** | v18 or higher (uses native `fetch`) |
| **Fireflies plan** | Business or Enterprise (60 req/min API access) |
| **Clarify API key** | From your Clarify workspace settings |

## Setup

```bash
# 1. Copy the config template and fill in your keys
cp .env.example .env

# 2. Test your connections
node sync.mjs --test

# 3. Preview what would sync
node sync.mjs --dry-run

# 4. Run the backfill
node sync.mjs --backfill
```

## Configuration

All options are set in the `.env` file:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FIREFLIES_API_KEY` | Yes | — | From Fireflies Settings → Integrations → Developer |
| `CLARIFY_WORKSPACE` | Yes | — | Your workspace slug (from your Clarify URL) |
| `CLARIFY_API_KEY` | Yes | — | From Clarify Settings → API Keys |
| `SYNC_WINDOW_DAYS` | No | `7` | Days to look back on incremental runs |
| `INTERNAL_DOMAINS` | No | — | Your company's email domains, comma-separated |

## Commands

| Command | What it does |
|---------|-------------|
| `node sync.mjs --test` | Verify both API connections |
| `node sync.mjs --dry-run` | Preview what would sync (no writes) |
| `node sync.mjs --backfill` | Sync ALL historical transcripts |
| `node sync.mjs` | Sync recent (since last run, or last 7 days) |
| `node sync.mjs --help` | Show help |

Or use the npm convenience scripts:

```bash
npm run test-connection
npm run dry-run
npm run backfill
npm run sync
```

## How It Works

For each Fireflies transcript:

1. **Fetch** full transcript (sentences, attendees, speakers)
2. **Match** against existing Clarify meetings (calendar ID → scored matching)
3. **Create** a new meeting if no match found
4. **Convert** Fireflies sentences → Clarify word-level transcript format
5. **Upload** transcript to the meeting
6. **Resolve** attendees — find or create Person records, link to meeting
7. **Track** the transcript ID so it's skipped on the next run

## State Tracking

Progress is saved in `.sync-state.json` (auto-created):

- **Safe to re-run** — already-synced transcripts are skipped
- **Safe to delete** — next run will re-process everything (meeting matching prevents most duplicates)

## Rate Limits

Fireflies Business plan: 60 req/min. Each transcript needs 2 API calls (list + detail fetch).

| Transcripts | Estimated Time |
|-------------|---------------|
| 50 | ~2 min |
| 200 | ~7 min |
| 500 | ~17 min |
| 1000 | ~35 min |

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| Fireflies 401 | Bad API key | Check key at app.fireflies.ai/integrations |
| Fireflies rate limit | Free/Pro plan (50/day) | Upgrade to Business |
| Clarify 401 | Wrong key or format | Use `api-key <token>`, not `Bearer` |
| Clarify 403 "No access to meeting" | Meeting access restriction | Contact Clarify support |
| 0 transcripts returned | Empty account or date filter | Try `--backfill` |
| 5 consecutive errors → stops | Systemic issue | Check API keys and retry |
