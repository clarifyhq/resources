# Fireflies → Clarify Transcript Sync

Sync meeting transcripts from [Fireflies.ai](https://fireflies.ai) into [Clarify CRM](https://clarify.ai). Two tools for two use cases:

> **Disclaimer:** This software is provided "as is", without warranty of any kind. See [LICENSE](../../LICENSE) for details. This is a community integration maintained by the Clarify team — it is not an official Fireflies.ai product. Use at your own discretion and always test with a small batch before running a full backfill.

- **CLI script** ([`cli/`](cli/)) — bulk backfill of historical transcripts. Single file, zero dependencies, Node 18+.
- **n8n workflow** ([`n8n/`](n8n/)) — ongoing incremental sync. Import into n8n, configure, activate.

Both handle transcript conversion, meeting matching, contact resolution, and state tracking.

---

## How It Works

### Data Flow

```
Fireflies.ai                    Clarify CRM
─────────────                    ──────────
Transcript (sentences)    →      Meeting (with word-level transcript)
  + attendee emails       →      Person records (found or created)
  + speaker names         →      Meeting ↔ Person relationships
  + calendar_id           →      Matched to calendar-synced meeting
```

### Field Mapping: Fireflies → Clarify

**Transcript conversion:**

| Fireflies | Clarify | Notes |
|-----------|---------|-------|
| `sentences[].speaker_name` | `transcript[].speaker` | Grouped by consecutive speaker |
| `sentences[].text` | `transcript[].words[].text` | Split into individual words |
| `sentences[].start_time` | `transcript[].words[].start_timestamp` | Both in seconds, interpolated per word |
| `sentences[].end_time` | `transcript[].words[].end_timestamp` | Both in seconds, interpolated per word |
| `speakers[].id` | `transcript[].speaker_id` | Normalized to integer |

**Meeting creation (when no match found):**

| Fireflies | Clarify | Notes |
|-----------|---------|-------|
| `title` | `meeting.title` | Direct mapping |
| `dateString` | `meeting.start` | ISO 8601 |
| `duration` (minutes) | `meeting.end` | Calculated: start + duration |
| `meeting_attendees[].email` | `meeting.participants.items[].email` | Used for person resolution |
| `meeting_attendees[].name` | `meeting.participants.items[].name` | Falls back to email if null |
| `id` | `meeting.event_id` | Prefixed as `adhoc-fireflies-{id}` |

**Contact resolution (per attendee email):**

| Step | Clarify API | Notes |
|------|------------|-------|
| Search existing | `GET /objects/person/resources?filter[email_addresses][Contains]={email}` | Reuses cached lookups |
| Create if missing | `POST /objects/person/records` | With name + email_addresses |
| Link to meeting | `PATCH /objects/meeting/records/{id}/relationships/people` | Required — records API doesn't auto-resolve |

### Meeting Matching

Before creating a new meeting, the sync searches Clarify for an existing one to avoid duplicates.

**Strongest signal:** If Fireflies provides a `calendar_id` and it matches a Clarify meeting's `ical_uid`, that's an automatic match.

**Otherwise, multi-signal scoring** within a 30-minute window:

| Signal | Points | How it works |
|--------|--------|-------------|
| Time proximity | 0-40 | Within 30 minutes; closer = more points |
| Title similarity | 0-40 | Jaccard word overlap |
| Participant overlap | 0-30 | Each matching email = 10 pts (max 30) |

Requires **60+ points AND at least 2 contributing signals**. If no match, creates a new ad-hoc meeting.

---

## API Quick Reference

### Fireflies

| Detail | Value |
|--------|-------|
| Endpoint | `POST https://api.fireflies.ai/graphql` |
| Auth | `Authorization: Bearer <api_key>` |
| Plan required | Business ($19/user/mo) for production |
| Docs | [docs.fireflies.ai](https://docs.fireflies.ai) |

### Clarify

| Detail | Value |
|--------|-------|
| Auth | `Authorization: api-key <token>` (NOT Bearer) |
| Create meeting | `POST /objects/meeting/records` |
| Upload transcript | `POST /meetings/{id}/transcript` |
| Search person | `GET /objects/person/resources?filter[email_addresses][Contains]=email` |
| Link people | `PATCH /objects/meeting/records/{id}/relationships/people` |

---

## Files

```
fireflies-clarify-sync/
├── README.md             # This file — overview and field mapping
├── cli/
│   ├── README.md         # CLI setup, commands, troubleshooting
│   ├── sync.mjs          # Sync script (zero dependencies)
│   ├── .env.example      # Configuration template
│   └── package.json      # npm convenience scripts
└── n8n/
    ├── README.md         # n8n setup, credentials, workflow nodes
    └── workflow.json     # Importable n8n workflow
```
