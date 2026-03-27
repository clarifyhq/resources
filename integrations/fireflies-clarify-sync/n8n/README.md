# Fireflies → Clarify Sync (n8n Workflow)

An importable n8n workflow that automatically syncs meeting transcripts from Fireflies.ai into Clarify CRM.

> **Disclaimer:** This software is provided "as is", without warranty of any kind. See [LICENSE](../../../LICENSE) for details. This is a community integration maintained by the Clarify team — it is not an official Fireflies.ai or n8n product. Always test with a small batch (`batchSize: 1`) before enabling scheduled sync.

This is an alternative to the CLI script (`sync.mjs`) for those who prefer a visual automation tool. Both do the same thing — the CLI is better for one-off migrations, n8n is better for ongoing automated sync.

## Requirements

| Requirement | Details |
|-------------|---------|
| **n8n** | Self-hosted (free) or cloud ($20/mo) — [n8n.io](https://n8n.io) |
| **Fireflies plan** | Business or Enterprise (60 req/min API access) |
| **Clarify API key** | From your Clarify workspace settings |

## Setup

### 1. Import the workflow

1. Open n8n
2. Go to **Workflows** → **Import from File**
3. Select `workflow.json` from this folder

### 2. Create credentials

You need two **Header Auth** credentials in n8n. Go to **Credentials** → **Create credential** → **Header Auth** for each.

**Fireflies API Key:**

| Field | Value |
|-------|-------|
| Name (credential label) | `Fireflies API Key` |
| Name (header field) | `Authorization` |
| Value | `Bearer <your_fireflies_api_key>` |

> **Important:** The Value must include the `Bearer ` prefix (with a space). Example: `Bearer ff_abc123def456`
>
> Get your key from: [app.fireflies.ai/integrations/custom/fireflies](https://app.fireflies.ai/integrations/custom/fireflies) (Settings → Integrations → Developer)
>
> **Requires Fireflies Business plan** ($19/user/mo) for production API access.

**Clarify API Key:**

| Field | Value |
|-------|-------|
| Name (credential label) | `Clarify API Key` |
| Name (header field) | `Authorization` |
| Value | `api-key <your_clarify_api_key>` |

> **Important:** Clarify uses `api-key` (NOT `Bearer`). Example: `api-key your_clarify_api_key_here`
>
> Get your key from: Clarify → Settings → API Keys

**Why two different auth formats?**
- Fireflies uses standard Bearer token auth: `Authorization: Bearer <key>`
- Clarify uses a custom scheme: `Authorization: api-key <key>`

These credentials are used by the three HTTP Request nodes. The Code nodes (Find or Create Meeting, Resolve & Link People) read the Clarify key from the config block instead — see step 4.

### 3. Connect credentials to nodes

After importing, open each HTTP Request node and select the appropriate credential:
- **List Fireflies Transcripts** and **Fetch Full Transcript** → Fireflies API Key
- **Upload Transcript** → Clarify API Key

### 4. Configure the workflow

Open the **Load Sync State** node (first Code node after the schedule trigger). At the top of the JavaScript you'll see a `CONFIG` block:

```javascript
const CONFIG = {
  clarifyWorkspace: 'your-workspace-slug',           // your Clarify workspace slug
  clarifyApiKey: 'YOUR_CLARIFY_API_KEY', // your Clarify API key
  batchSize: 50,                        // transcripts per run (max 50, use 1-2 for testing)
  startDate: null,                      // optional: ISO date to start from (e.g. '2026-01-01T00:00:00Z')
  endDate: null,                        // optional: ISO date to end at
};
```

Update `clarifyWorkspace` and `clarifyApiKey` with your values. The Code nodes (Find or Create Meeting, Resolve & Link People) use these to call the Clarify API directly.

### 5. Activate

Toggle the workflow to **Active**. It will run every 6 hours by default (configurable in the Schedule Trigger node).

## How It Works

```
Schedule (6h)
  → Load Sync State (from n8n static data)
  → List Fireflies Transcripts (50 per run)
  → Filter Already Synced (skip processed IDs)
  → For each new transcript:
      → Fetch Full Transcript (sentences + attendees)
      → Convert to Clarify Format (word-level timestamps)
      → Find or Create Meeting (match by title + time + participants)
      → Upload Transcript
      → Resolve & Link People (search/create Person, link to meeting)
  → Update Sync State (save progress)
```

### Backfill

The workflow handles backfill automatically. On the first run, there's no saved date — so it fetches the oldest 50 transcripts from Fireflies. Each subsequent run picks up the next batch. A backlog of 500 transcripts would be fully synced in about 3 days (50 per run, every 6 hours).

No manual backfill step needed — just activate the workflow and it works through history on its own.

### Meeting Matching

Before creating a new meeting, the workflow searches Clarify for an existing one.

**Strongest signal first:** If Fireflies provides a `calendar_id` and it matches a Clarify meeting's `ical_uid`, that's an automatic match — no scoring needed.

**Otherwise, multi-signal scoring** within a 30-minute window:

| Signal | Points | How it works |
|--------|--------|-------------|
| Time proximity | 0-40 | Within 30 minutes, closer = more points |
| Title similarity | 0-40 | Jaccard word overlap (not substring) |
| Participant overlap | 0-30 | Each matching email = 10 pts (max 30) |

A match requires **60+ points AND at least 2 contributing signals**. This prevents false matches — a same-day meeting with one shared participant won't match unless the title also overlaps.

### Contact Resolution

The generic Clarify records API does not auto-resolve participant emails to Person records. So the workflow handles it explicitly:

1. **Search** for existing Person by email
2. **Create** new Person if not found (external contacts only)
3. **Link** all Person records to the meeting via `PATCH /relationships/people`

This ensures attendees appear on Person timelines, Company pages, and in AI Chat.

### State Tracking

Progress is stored in n8n's workflow static data (persists across runs):
- `lastSyncDate` — timestamp of last successful run
- `syncedIds` — array of processed Fireflies transcript IDs (capped at 10k)
- `lastRunStats` — count of transcripts processed in the last run

Safe to re-run — already-synced transcripts are skipped automatically.

## Workflow Nodes

| Node | Type | Purpose |
|------|------|---------|
| Every 6 Hours | Schedule Trigger | Runs the workflow on a timer |
| Load Sync State | Code | **Config node** — holds Clarify workspace/key, batch size, date range. Also reads sync state from static data |
| List Fireflies Transcripts | HTTP Request | GraphQL query for recent transcripts |
| Filter Already Synced | Code | Skips previously processed IDs |
| Has New Transcripts? | IF | Short-circuits if nothing to process |
| Fetch Full Transcript | HTTP Request | Gets sentences + attendees per transcript |
| Convert to Clarify Format | Code | Fireflies sentences → Clarify word-level segments |
| Has Sentences? | IF | Skips empty/failed transcripts |
| Find or Create Meeting | Code | Match existing meeting or create new one |
| Upload Transcript | HTTP Request | Attaches transcript to meeting |
| Resolve & Link People | Code | Find/create Person records, link to meeting |
| Update Sync State | Code | Saves progress for next run |
| Mark Skipped as Synced | Code | Marks empty transcripts so they aren't retried |
| Nothing to Sync | NoOp | Terminal node when no new transcripts |

## Troubleshooting

### "Authentication required" from Fireflies

Your Fireflies credential is wrong or expired. Check the Bearer token in the HTTP Header Auth credential.

### "401" from Clarify

Check that the Clarify API key is correct and uses `api-key` (not `Bearer`) as the auth prefix.

### Duplicate meetings

The matching algorithm may miss if titles differ significantly or participants don't overlap. You can delete duplicates in Clarify — synced transcript IDs are tracked, so they won't be re-processed.

### Workflow runs but processes 0 transcripts

All transcripts are already in the synced IDs list. If you want to re-process everything, clear the workflow static data (Settings → Static Data → Clear).

### Rate limit errors from Fireflies

You're on the Free/Pro plan (50 req/day). Upgrade to Business for 60 req/min. The workflow has a 1.1s delay between transcript fetches to stay within limits.
