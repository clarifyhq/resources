#!/usr/bin/env node

/**
 * Fireflies → Clarify Transcript Sync
 *
 * Pulls meeting transcripts from Fireflies.ai and uploads them to Clarify CRM.
 *
 * Usage:
 *   node sync.mjs              # Sync recent transcripts (last N days)
 *   node sync.mjs --backfill   # Sync ALL historical transcripts
 *   node sync.mjs --dry-run    # Preview what would be synced (no writes)
 *   node sync.mjs --test       # Test API connections only
 *
 * Environment variables (set in .env file):
 *   FIREFLIES_API_KEY    - Fireflies API key (Business plan required)
 *   CLARIFY_WORKSPACE    - Clarify workspace slug
 *   CLARIFY_API_KEY      - Clarify API key
 *   SYNC_WINDOW_DAYS     - Days to look back (default: 7)
 *   INTERNAL_DOMAINS     - Comma-separated internal domains (e.g. "yourcompany.com")
 *
 * See README.md for full documentation.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load configuration from .env file and environment variables.
 * .env file values are used as defaults; actual env vars take precedence.
 */
function loadConfig() {
  // Load .env file if it exists
  const envPath = resolve(__dirname, '.env');
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes (common copy-paste mistake)
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Don't override existing env vars
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  const config = {
    firefliesApiKey: process.env.FIREFLIES_API_KEY,
    clarifyWorkspace: process.env.CLARIFY_WORKSPACE,
    clarifyApiKey: process.env.CLARIFY_API_KEY,
    syncWindowDays: parseInt(process.env.SYNC_WINDOW_DAYS || '7', 10),
    internalDomains: (process.env.INTERNAL_DOMAINS || '')
      .split(',')
      .map(d => d.trim().toLowerCase())
      .filter(Boolean),
  };

  return config;
}

/**
 * Validate that all required configuration is present.
 * Prints helpful error messages for each missing value.
 */
function validateConfig(config) {
  const errors = [];

  if (!config.firefliesApiKey) {
    errors.push(
      'FIREFLIES_API_KEY is not set.\n' +
      '  → Get your API key from: https://app.fireflies.ai/integrations/custom/fireflies\n' +
      '  → Requires Fireflies Business plan or higher for production use.'
    );
  }

  if (!config.clarifyWorkspace) {
    errors.push(
      'CLARIFY_WORKSPACE is not set.\n' +
      '  → This is your workspace slug from your Clarify URL.\n' +
      '  → Example: if your URL is https://app.clarify.ai/mycompany, use "mycompany"'
    );
  }

  if (!config.clarifyApiKey) {
    errors.push(
      'CLARIFY_API_KEY is not set.\n' +
      '  → Find your API key in Clarify → Settings → API Keys'
    );
  }

  if (errors.length > 0) {
    console.error('\n--- Configuration Errors ---\n');
    errors.forEach((err, i) => console.error(`${i + 1}. ${err}\n`));
    console.error('Copy .env.example to .env and fill in your values:');
    console.error('  cp .env.example .env\n');
    process.exit(1);
  }

  if (config.internalDomains.length === 0) {
    console.warn(
      'WARNING: INTERNAL_DOMAINS is not set. All participants will be treated as external.\n' +
      '  → Set this to your company domain(s) to properly classify participants.\n' +
      '  → Example: INTERNAL_DOMAINS=yourcompany.com\n'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fireflies API Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fireflies.ai GraphQL API client.
 *
 * API docs: https://docs.fireflies.ai
 * Endpoint: POST https://api.fireflies.ai/graphql
 * Auth:     Bearer token
 *
 * Rate limits:
 *   - Free/Pro:          50 requests per day (testing only)
 *   - Business/Enterprise: 60 requests per minute
 *
 * Pagination:
 *   - Offset-based: limit (max 50) + skip (max 5000)
 *   - For >5000 transcripts, combine with date-range chunking
 */
class FirefliesClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.endpoint = 'https://api.fireflies.ai/graphql';
    this.requestCount = 0;
  }

  /**
   * Execute a GraphQL query against the Fireflies API.
   *
   * @param {string} query - GraphQL query string
   * @param {object} variables - Query variables
   * @returns {object} The `data` field from the GraphQL response
   * @throws {Error} On HTTP errors or GraphQL errors
   */
  async query(query, variables = {}) {
    this.requestCount++;

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Fireflies API error ${response.status}: ${text}`);
    }

    const result = await response.json();

    if (result.errors) {
      const messages = result.errors.map(e => e.message).join('; ');
      throw new Error(`Fireflies GraphQL error: ${messages}`);
    }

    return result.data;
  }

  /**
   * List transcripts with optional date filtering.
   * Returns lightweight metadata (no full transcript text).
   *
   * Pagination: max 50 per page, offset via `skip`.
   *
   * @param {object} options
   * @param {string} [options.fromDate] - ISO 8601 date string (inclusive)
   * @param {string} [options.toDate]   - ISO 8601 date string (inclusive)
   * @param {number} [options.limit=50] - Page size (max 50)
   * @param {number} [options.skip=0]   - Offset for pagination
   * @returns {Array} Array of transcript summary objects
   */
  async listTranscripts({ fromDate, toDate, limit = 50, skip = 0 } = {}) {
    const data = await this.query(`
      query ListTranscripts($limit: Int, $skip: Int, $fromDate: DateTime, $toDate: DateTime) {
        transcripts(limit: $limit, skip: $skip, fromDate: $fromDate, toDate: $toDate) {
          id
          title
          date
          dateString
          duration
          organizer_email
          calendar_id
          participants
          speakers {
            id
            name
          }
        }
      }
    `, { limit, skip, fromDate, toDate });

    return data.transcripts || [];
  }

  /**
   * Fetch ALL transcripts matching a date filter, handling pagination automatically.
   *
   * Uses offset-based pagination (limit + skip). The skip parameter caps at 5000,
   * so for very large accounts (>5000 transcripts), this chunks by date range.
   *
   * @param {object} options
   * @param {string} [options.fromDate] - ISO 8601 start date
   * @param {string} [options.toDate]   - ISO 8601 end date
   * @returns {Array} All matching transcript summaries
   */
  async listAllTranscripts({ fromDate, toDate } = {}) {
    const all = [];
    let skip = 0;
    const limit = 50; // Fireflies max per page

    while (skip <= 5000) { // skip caps at 5000
      const batch = await this.listTranscripts({ fromDate, toDate, limit, skip });
      if (!batch || batch.length === 0) break;
      all.push(...batch);

      // If we got fewer than `limit`, we've reached the end
      if (batch.length < limit) break;
      skip += limit;

      // Brief pause to stay well within rate limits
      await sleep(100);
    }

    // Warn if we hit the pagination ceiling — data may be truncated
    if (skip > 5000) {
      console.warn(
        `WARNING: Reached Fireflies pagination limit (5000 records). ` +
        `${all.length} transcripts fetched, but there may be more. ` +
        `Use startDate/endDate to sync in smaller date ranges.`
      );
    }

    return all;
  }

  /**
   * Fetch full transcript details for a single meeting, including sentences.
   *
   * This is the expensive call — returns the full speaker-labeled transcript.
   * Use listTranscripts() first to get IDs, then fetch details one at a time.
   *
   * @param {string} id - Fireflies transcript ID
   * @returns {object} Full transcript object with sentences, attendees, summary
   */
  async getTranscript(id) {
    const data = await this.query(`
      query GetTranscript($id: String!) {
        transcript(id: $id) {
          id
          title
          date
          dateString
          duration
          organizer_email
          host_email
          calendar_id
          audio_url
          video_url
          transcript_url
          meeting_link

          speakers {
            id
            name
          }

          meeting_attendees {
            displayName
            name
            email
            phoneNumber
          }

          sentences {
            index
            speaker_name
            text
            raw_text
            start_time
            end_time
          }

          summary {
            action_items
            keywords
            outline
            overview
            shorthand_bullet
          }
        }
      }
    `, { id });

    return data.transcript;
  }

  /**
   * Fetch the current user profile. Useful for testing the API connection.
   *
   * @returns {object} User profile with name, email, etc.
   */
  async getCurrentUser() {
    const data = await this.query(`
      query {
        user {
          name
          email
          is_admin
          num_transcripts
        }
      }
    `);
    return data.user;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clarify API Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clarify CRM API client for creating meetings and uploading transcripts.
 *
 * API docs: https://docs.clarify.ai
 * Base URL: https://api.clarify.ai/v1
 * Auth:     api-key <token> (NOT Bearer)
 *
 * Key endpoints used:
 *   POST /workspaces/{slug}/objects/meeting/records      - Create meeting
 *   GET  /workspaces/{slug}/objects/meeting/resources     - Search meetings
 *   POST /workspaces/{slug}/meetings/{id}/transcript      - Upload transcript
 */
class ClarifyClient {
  constructor(workspace, apiKey) {
    this.workspace = workspace;
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.clarify.ai/v1';
  }

  /**
   * Make an authenticated request to the Clarify API.
   *
   * @param {string} path - Path relative to workspace (e.g. "/objects/meeting/records")
   * @param {object} options - fetch() options (method, body, etc.)
   * @returns {object} Parsed JSON response
   * @throws {Error} On non-2xx responses, with the full error body
   */
  async fetch(path, options = {}) {
    const url = `${this.baseUrl}/workspaces/${this.workspace}${path}`;

    const response = await globalThis.fetch(url, {
      ...options,
      headers: {
        // IMPORTANT: Clarify uses "api-key", NOT "Bearer"
        'Authorization': `api-key ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Clarify API error ${response.status}: ${text}`);
    }

    // Some endpoints return 204 No Content
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return response.json();
    }
    return null;
  }

  /**
   * Search for an existing meeting by calendar ID, title, time, and participants.
   *
   * Matching strategy (tightest first):
   *   1. Calendar ID match (ical_uid ↔ Fireflies calendar_id) — automatic
   *   2. Multi-signal scoring within a 30-minute window:
   *      - Time proximity: 0-40 pts (30 min hard cutoff)
   *      - Title similarity: 0-40 pts (Jaccard word overlap, not substring)
   *      - Participant email overlap: 0-30 pts
   *      - Minimum 60 pts AND at least 2 signals required
   *
   * @param {string} title - Meeting title to search for
   * @param {string} dateIso - ISO 8601 date of the meeting
   * @param {string[]} participantEmails - Attendee emails for matching
   * @param {string|null} calendarId - Fireflies calendar_id (for ical_uid match)
   * @returns {object|null} Matching Clarify meeting, or null
   */
  async findMeeting(title, dateIso, participantEmails, calendarId = null) {
    // If no date, we can't do a meaningful search
    if (!dateIso) return null;

    // Search meetings within 1 day of the transcript to avoid scanning the entire workspace
    const transcriptDate = new Date(dateIso);
    if (isNaN(transcriptDate.getTime())) return null;
    const dayBefore = new Date(transcriptDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const dayAfter = new Date(transcriptDate.getTime() + 24 * 60 * 60 * 1000).toISOString();

    const params = new URLSearchParams({
      'filter[start][Is on or after]': dayBefore,
      'filter[start][Is on or before]': dayAfter,
      'page[limit]': '200',
    });

    const response = await this.fetch(`/objects/meeting/resources?${params}`);
    if (!response || !response.data) return null;

    // --- Try calendar ID match first (strongest possible signal) ---
    if (calendarId) {
      const calMatch = response.data.find(item =>
        item.attributes.ical_uid && item.attributes.ical_uid === calendarId
      );
      if (calMatch) {
        return { id: calMatch.id, ...calMatch.attributes, _matchType: 'calendar_id' };
      }
    }

    // --- Score-based matching within 30-minute window ---
    const targetDate = new Date(dateIso).getTime();
    const THIRTY_MIN = 30 * 60 * 1000;

    let bestMatch = null;
    let bestScore = 0;

    for (const item of response.data) {
      const attrs = item.attributes;
      let score = 0;
      let signals = 0;

      // Time proximity (30-minute hard cutoff, closer = more points, max 40)
      if (!attrs.start) continue;
      const meetingDate = new Date(attrs.start).getTime();
      const timeDiff = Math.abs(meetingDate - targetDate);
      if (timeDiff > THIRTY_MIN) continue;
      const timeScore = (1 - timeDiff / THIRTY_MIN) * 40;
      score += timeScore;
      if (timeScore > 10) signals++;

      // Title similarity via Jaccard word overlap (max 40)
      if (attrs.title && title) {
        const words1 = new Set(
          title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2)
        );
        const words2 = new Set(
          attrs.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2)
        );
        if (words1.size > 0 && words2.size > 0) {
          let intersection = 0;
          for (const w of words1) { if (words2.has(w)) intersection++; }
          const union = new Set([...words1, ...words2]).size;
          const jaccard = intersection / union;
          const titleScore = jaccard * 40;
          score += titleScore;
          if (titleScore > 10) signals++;
        }
      }

      // Participant email overlap (10 pts each, max 30)
      if (participantEmails.length > 0 && attrs.participants?.items) {
        const meetingEmails = attrs.participants.items
          .map(p => p.email?.toLowerCase())
          .filter(Boolean);
        const overlap = participantEmails.filter(e =>
          meetingEmails.includes(e.toLowerCase())
        ).length;
        if (overlap > 0) {
          score += Math.min(overlap * 10, 30);
          signals++;
        }
      }

      // Require minimum 60 pts AND at least 2 contributing signals
      if (score > bestScore && score >= 60 && signals >= 2) {
        bestScore = score;
        bestMatch = { id: item.id, ...attrs, _score: score, _signals: signals, _matchType: 'scored' };
      }
    }

    return bestMatch;
  }

  /**
   * Create a new meeting record in Clarify.
   *
   * Uses "adhoc-fireflies-" prefix on event_id so the meeting is editable via API.
   * (Meetings synced from calendar providers are read-only.)
   *
   * @param {object} attrs
   * @param {string} attrs.title - Meeting title
   * @param {string} attrs.start - ISO 8601 start time
   * @param {string} attrs.end - ISO 8601 end time
   * @param {Array<{email: string, name?: string}>} attrs.participants - Attendee list
   * @param {string} [attrs.firefliesId] - Fireflies transcript ID (for dedup)
   * @returns {string} Created meeting ID
   */
  async createMeeting({ title, start, end, participants, firefliesId }) {
    const eventId = `adhoc-fireflies-${firefliesId || Date.now()}`;

    const response = await this.fetch('/objects/meeting/records', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'meeting',
          attributes: {
            title,
            start,
            end,
            all_day: false,
            visibility: 'default',
            event_id: eventId,
            participants: {
              items: participants.map(p => ({
                email: p.email || null,
                name: p.name || null,
                phone_number: null,
                status: 'yes',
                organizer: false,
              })),
            },
          },
        },
      }),
    });

    return response.data.id;
  }

  /**
   * Upload a transcript to an existing Clarify meeting.
   *
   * Creates a MeetingRecording with recording_source "manual_upload".
   * The transcript format is an array of speaker segments with words.
   *
   * IMPORTANT: Uses the "legacy" transcript format (not 1.11), since that's
   * what the Clarify API DTO validates.
   *
   * @param {string} meetingId - Clarify meeting ID to attach transcript to
   * @param {Array} segments - Transcript segments (see convertTranscript())
   * @returns {string} Created recording ID
   */
  async uploadTranscript(meetingId, segments) {
    const response = await this.fetch(`/meetings/${meetingId}/transcript`, {
      method: 'POST',
      body: JSON.stringify({ transcript: segments }),
    });

    return response?.data?.id || 'ok';
  }

  /**
   * Search for a Person record by email address.
   *
   * Uses the Clarify collection filter syntax:
   *   GET /objects/person/resources?filter[email_addresses][Contains]=email
   *
   * @param {string} email - Email address to search for
   * @returns {object|null} Person record { id, name, email_addresses } or null
   */
  async findPersonByEmail(email) {
    const params = new URLSearchParams({
      'filter[email_addresses][Contains]': email,
      'page[limit]': '1',
    });

    const response = await this.fetch(`/objects/person/resources?${params}`);
    if (!response?.data?.length) return null;

    const person = response.data[0];
    return { id: person.id, ...person.attributes };
  }

  /**
   * Create a new Person record in Clarify.
   *
   * @param {object} attrs
   * @param {string} attrs.email - Primary email address
   * @param {string} [attrs.name] - Full name (will be split into first/last)
   * @returns {string} Created person ID
   */
  async createPerson({ email, name }) {
    // Build the name object — Clarify person name is { first_name, last_name, full_name }
    const nameObj = {};
    if (name) {
      nameObj.full_name = name;
      const parts = name.trim().split(/\s+/);
      if (parts.length >= 2) {
        nameObj.first_name = parts[0];
        nameObj.last_name = parts.slice(1).join(' ');
      } else if (parts.length === 1) {
        nameObj.first_name = parts[0];
      }
    }

    const attributes = {
      email_addresses: { items: [email] },
    };
    if (Object.keys(nameObj).length > 0) {
      attributes.name = nameObj;
    }

    const response = await this.fetch('/objects/person/records', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'person',
          attributes,
        },
      }),
    });

    return response.data.id;
  }

  /**
   * Link Person records to a Meeting via the relationships endpoint.
   *
   * IMPORTANT: The generic POST /objects/meeting/records endpoint does NOT
   * auto-resolve participant emails to Person records. That only happens via
   * the dedicated PUT /meetings/:id/participants endpoint. So for meetings
   * created via the records API (like this sync does), we must manually:
   *   1. Find or create Person records for each attendee email
   *   2. Link them via PATCH /relationships/people
   *
   * @param {string} meetingId - Clarify meeting ID
   * @param {string[]} personIds - Array of Clarify person IDs to link
   */
  async linkPeopleToMeeting(meetingId, personIds) {
    if (personIds.length === 0) return;

    await this.fetch(`/objects/meeting/records/${meetingId}/relationships/people`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: personIds.map(id => ({ type: 'person', id })),
      }),
    });
  }

  /**
   * Resolve a list of attendee emails to Clarify Person IDs.
   *
   * For each email:
   *   1. Check the local cache (avoids duplicate API lookups across transcripts)
   *   2. Search Clarify for an existing Person by email
   *   3. If not found and createMissing=true, create a new Person record
   *
   * @param {Array<{email: string, name?: string}>} attendees - Attendees with emails
   * @param {Map} cache - Email → personId cache (mutated in place)
   * @param {object} options
   * @param {boolean} [options.createMissing=true] - Create Person records for unknown emails
   * @param {string[]} [options.internalDomains=[]] - Domains to skip creating people for
   * @returns {string[]} Array of resolved Clarify person IDs
   */
  async resolvePersonIds(attendees, cache, { createMissing = true, internalDomains = [] } = {}) {
    const personIds = [];

    for (const attendee of attendees) {
      if (!attendee.email) continue;
      const email = attendee.email.toLowerCase();

      // Check cache first
      if (cache.has(email)) {
        const cachedId = cache.get(email);
        if (cachedId) personIds.push(cachedId);
        continue;
      }

      // Search Clarify for existing person
      try {
        const existing = await this.findPersonByEmail(email);
        if (existing) {
          cache.set(email, existing.id);
          personIds.push(existing.id);
          continue;
        }

        // Not found — create if enabled and external
        if (createMissing) {
          const domain = email.split('@')[1];
          if (internalDomains.includes(domain)) {
            // Internal people should already exist from team/calendar sync
            cache.set(email, null);
            continue;
          }

          const personId = await this.createPerson({
            email,
            name: attendee.name || null,
          });
          cache.set(email, personId);
          personIds.push(personId);
        } else {
          cache.set(email, null);
        }
      } catch (err) {
        // Don't fail the whole sync over a person resolution error
        console.warn(`    WARNING: Could not resolve person for ${email}: ${err.message}`);
        cache.set(email, null);
      }
    }

    return personIds;
  }

  /**
   * Test the API connection by fetching workspace info.
   *
   * @returns {boolean} true if connection successful
   */
  async testConnection() {
    const response = await this.fetch('/objects/meeting/resources?page[limit]=1');
    return !!response;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript Conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a Fireflies transcript into Clarify's transcript upload format.
 *
 * Fireflies format (per sentence):
 *   { speaker_name, text, start_time (seconds), end_time (seconds) }
 *
 * Clarify format (per segment):
 *   { speaker, speaker_id, language, words: [{ text, start_timestamp, end_timestamp }] }
 *
 * NOTE: Fireflies sentence timestamps are in SECONDS (not milliseconds).
 * Clarify also expects seconds, so no unit conversion is needed.
 * (Confirmed via vendor spec from live schema introspection, 2026-03-24.)
 *
 * Strategy: group consecutive sentences by the same speaker into segments,
 * then split each sentence's text into individual words with interpolated timestamps.
 *
 * @param {Array} sentences - Fireflies sentence objects
 * @param {Array} speakers - Fireflies speaker objects (for ID mapping)
 * @returns {Array} Clarify-format transcript segments
 */
function convertTranscript(sentences, speakers = []) {
  if (!sentences || sentences.length === 0) return [];

  // Build speaker name → ID map
  const speakerIdMap = {};
  speakers.forEach((s, i) => {
    speakerIdMap[s.name] = s.id != null ? parseInt(s.id, 10) : i;
  });
  let nextSpeakerId = speakers.length;

  const segments = [];
  let currentSegment = null;

  for (const sentence of sentences) {
    const speakerName = sentence.speaker_name || 'Unknown';
    const text = sentence.text || sentence.raw_text || '';
    const startSec = sentence.start_time || 0;
    const endSec = sentence.end_time || startSec;

    // Start a new segment if the speaker changed
    if (!currentSegment || currentSegment.speaker !== speakerName) {
      if (currentSegment) {
        segments.push(currentSegment);
      }
      // Assign a speaker ID (reuse if we've seen this speaker before)
      if (!(speakerName in speakerIdMap)) {
        speakerIdMap[speakerName] = nextSpeakerId++;
      }
      currentSegment = {
        speaker: speakerName,
        speaker_id: speakerIdMap[speakerName],
        language: null, // Fireflies doesn't reliably provide per-sentence language
        words: [],
      };
    }

    // Split the sentence text into words and interpolate timestamps.
    // Fireflies gives us sentence-level timestamps (in seconds), Clarify
    // also expects seconds. We distribute the time evenly across words.
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const durationSec = endSec - startSec;
    const wordDurationSec = durationSec / words.length;

    for (let i = 0; i < words.length; i++) {
      const wordStartSec = startSec + i * wordDurationSec;
      const wordEndSec = startSec + (i + 1) * wordDurationSec;

      currentSegment.words.push({
        text: words[i],
        // Both Fireflies and Clarify use seconds (float)
        start_timestamp: wordStartSec,
        end_timestamp: wordEndSec,
        language: null,
        confidence: null,
      });
    }
  }

  // Don't forget the last segment
  if (currentSegment && currentSegment.words.length > 0) {
    segments.push(currentSegment);
  }

  return segments;
}

/**
 * Extract participant info from a Fireflies transcript.
 * Combines meeting_attendees (structured, with emails) and speakers (names only).
 *
 * @param {object} transcript - Full Fireflies transcript object
 * @param {string[]} internalDomains - Domains to classify as internal
 * @returns {object} { all: [...], internal: [...], external: [...] }
 */
function extractParticipants(transcript, internalDomains = []) {
  const participants = [];
  const seen = new Set();

  // Prefer meeting_attendees (has emails)
  // NOTE: displayName is frequently null in Fireflies — fall back to name field
  if (transcript.meeting_attendees) {
    for (const a of transcript.meeting_attendees) {
      const email = a.email?.toLowerCase();
      const name = a.displayName || a.name || a.email || 'Unknown';
      if (email && !seen.has(email)) {
        seen.add(email);
        participants.push({ email, name });
      }
    }
  }

  // Fill in from speakers (names only, no emails)
  if (transcript.speakers) {
    for (const s of transcript.speakers) {
      const name = s.name;
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        participants.push({ name, email: null });
      }
    }
  }

  // Classify as internal/external
  const internal = [];
  const external = [];
  for (const p of participants) {
    if (p.email) {
      const domain = p.email.split('@')[1];
      if (internalDomains.includes(domain)) {
        internal.push(p);
      } else {
        external.push(p);
      }
    } else {
      external.push(p); // No email = assume external
    }
  }

  return { all: participants, internal, external };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync State Management
// ─────────────────────────────────────────────────────────────────────────────

const STATE_FILE = resolve(__dirname, '.sync-state.json');

/**
 * Load the sync state from disk.
 *
 * The state file tracks:
 *   - lastSyncDate: ISO timestamp of the last successful sync
 *   - syncedIds: Set of Fireflies transcript IDs already synced (dedup)
 *   - stats: Cumulative sync statistics
 *
 * @returns {object} Sync state
 */
function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(raw);
      // Convert array back to Set for lookups
      state.syncedIds = new Set(state.syncedIds || []);
      return state;
    } catch {
      console.warn('WARNING: Could not parse .sync-state.json, starting fresh.');
    }
  }

  return {
    lastSyncDate: null,
    syncedIds: new Set(),
    stats: {
      totalSynced: 0,
      totalSkipped: 0,
      totalErrors: 0,
      lastRunDate: null,
    },
  };
}

/**
 * Save the sync state to disk.
 *
 * @param {object} state - Sync state to save
 */
function saveState(state) {
  const serializable = {
    ...state,
    // Convert Set to Array for JSON serialization, cap at 10k to prevent unbounded growth
    syncedIds: [...state.syncedIds].slice(-10000),
  };
  // Atomic write: write to temp file then rename, so a mid-write crash
  // doesn't corrupt the state file and cause duplicate syncs.
  const tmpFile = STATE_FILE + '.tmp';
  writeFileSync(tmpFile, JSON.stringify(serializable, null, 2) + '\n');
  renameSync(tmpFile, STATE_FILE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main sync function. Orchestrates the full pipeline:
 *
 *   1. Fetch transcript list from Fireflies (with date filter)
 *   2. For each transcript not yet synced:
 *      a. Fetch full transcript details (sentences + attendees)
 *      b. Check if a matching meeting already exists in Clarify
 *      c. If no match: create a new meeting
 *      d. Convert Fireflies sentences → Clarify transcript format
 *      e. Upload the transcript to the Clarify meeting
 *   3. Update sync state
 *
 * @param {object} options
 * @param {boolean} options.backfill - If true, sync all history (ignore lastSyncDate)
 * @param {boolean} options.dryRun - If true, preview only (no writes to Clarify)
 */
async function sync({ backfill = false, dryRun = false } = {}) {
  const config = loadConfig();
  validateConfig(config);

  const fireflies = new FirefliesClient(config.firefliesApiKey);
  const clarify = new ClarifyClient(config.clarifyWorkspace, config.clarifyApiKey);
  const state = loadState();

  // Cache for email → personId lookups (persists across runs via state file)
  const personCache = new Map(Object.entries(state.personCache || {}));

  // Determine date range
  let fromDate;
  if (backfill) {
    fromDate = null; // No filter = get everything
    console.log('BACKFILL MODE: Fetching all historical transcripts from Fireflies.\n');
  } else if (state.lastSyncDate) {
    fromDate = state.lastSyncDate;
    console.log(`Syncing transcripts since: ${fromDate}\n`);
  } else {
    // First run (not backfill) — use the configured window
    const windowMs = config.syncWindowDays * 24 * 60 * 60 * 1000;
    fromDate = new Date(Date.now() - windowMs).toISOString();
    console.log(`First sync: fetching last ${config.syncWindowDays} days (since ${fromDate}).\n`);
    console.log('TIP: Run with --backfill to sync all historical transcripts.\n');
  }

  // ── Step 1: List transcripts from Fireflies ──────────────────────────────
  console.log('Fetching transcript list from Fireflies...');
  const transcripts = await fireflies.listAllTranscripts({
    fromDate: fromDate || undefined,
  });
  console.log(`Found ${transcripts.length} transcripts.\n`);

  if (transcripts.length === 0) {
    console.log('Nothing to sync. All done!');
    state.stats.lastRunDate = new Date().toISOString();
    saveState(state);
    return;
  }

  // ── Step 2: Filter already-synced transcripts ─────────────────────────────
  const toSync = transcripts.filter(t => !state.syncedIds.has(t.id));
  const skipped = transcripts.length - toSync.length;
  if (skipped > 0) {
    console.log(`Skipping ${skipped} already-synced transcripts.`);
  }
  console.log(`Processing ${toSync.length} new transcripts.\n`);

  if (toSync.length === 0) {
    console.log('Nothing new to sync. All done!');
    state.stats.lastRunDate = new Date().toISOString();
    saveState(state);
    return;
  }

  if (dryRun) {
    console.log('DRY RUN — showing what would be synced:\n');
  }

  // ── Step 3: Process each transcript ───────────────────────────────────────
  let synced = 0;
  let errors = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  for (const summary of toSync) {
    const label = `[${synced + errors + 1}/${toSync.length}]`;
    // summary.date is epoch milliseconds (Float), dateString is ISO 8601
    const dateStr = summary.dateString
      ? new Date(summary.dateString).toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric',
        })
      : summary.date
        ? new Date(summary.date).toLocaleDateString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric',
          })
        : 'unknown date';

    console.log(`${label} "${summary.title || 'Untitled'}" (${dateStr})`);

    if (dryRun) {
      console.log(`  → Would sync (Fireflies ID: ${summary.id})`);
      console.log(`  → Duration: ${summary.duration ? Math.round(summary.duration) + ' min' : 'unknown'}`);
      console.log(`  → Participants: ${(summary.participants || []).join(', ') || 'none listed'}`);
      console.log();
      synced++;
      continue;
    }

    try {
      // 3a. Fetch full transcript details
      const full = await fireflies.getTranscript(summary.id);
      if (!full) {
        console.log('  → Skipped: could not fetch transcript details.');
        errors++;
        continue;
      }

      const sentenceCount = full.sentences?.length || 0;
      if (sentenceCount === 0) {
        console.log('  → Skipped: no transcript content (0 sentences).');
        state.syncedIds.add(summary.id); // Mark as synced so we don't retry
        continue;
      }

      // 3b. Extract participants
      const participants = extractParticipants(full, config.internalDomains);
      const participantEmails = participants.all
        .filter(p => p.email)
        .map(p => p.email);

      // 3c. Find or create meeting in Clarify
      // Prefer dateString (ISO 8601) over date (epoch ms)
      const meetingDate = full.dateString || summary.dateString
        || (full.date ? new Date(full.date).toISOString() : null)
        || (summary.date ? new Date(summary.date).toISOString() : null);

      let meetingId;
      const existingMeeting = await clarify.findMeeting(
        full.title || summary.title,
        meetingDate,
        participantEmails,
        full.calendar_id || summary.calendar_id || null
      );

      if (existingMeeting) {
        meetingId = existingMeeting.id;
        console.log(`  → Matched existing meeting: ${existingMeeting.title || meetingId}`);
      } else {
        // Calculate meeting end time from duration
        // NOTE: duration units are ambiguous in Fireflies API — observed values
        // suggest minutes but this is unconfirmed. We assume minutes here.
        const startDate = new Date(meetingDate);
        const durationMin = full.duration || summary.duration || 30;
        const endDate = new Date(startDate.getTime() + durationMin * 60 * 1000);

        meetingId = await clarify.createMeeting({
          title: full.title || summary.title || 'Untitled Meeting',
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          participants: participants.all.filter(p => p.email), // Only include participants with emails
          firefliesId: full.id,
        });
        console.log(`  → Created new meeting: ${meetingId}`);
      }

      // 3d. Convert transcript to Clarify format
      const clarifyTranscript = convertTranscript(full.sentences, full.speakers);
      console.log(`  → Converted ${sentenceCount} sentences → ${clarifyTranscript.length} segments`);

      // 3e. Upload transcript
      const recordingId = await clarify.uploadTranscript(meetingId, clarifyTranscript);
      console.log(`  → Uploaded transcript (recording: ${recordingId})`);

      // 3f. Resolve attendees to Person records and link to meeting.
      //     The generic POST /objects/meeting/records endpoint does NOT
      //     auto-resolve participant emails — that only happens via the
      //     dedicated PUT /meetings/:id/participants endpoint. So we must
      //     manually find/create Person records and link them.
      const attendeesWithEmails = participants.all.filter(p => p.email);
      if (attendeesWithEmails.length > 0) {
        const personIds = await clarify.resolvePersonIds(
          attendeesWithEmails,
          personCache,
          { createMissing: true, internalDomains: config.internalDomains }
        );

        if (personIds.length > 0) {
          await clarify.linkPeopleToMeeting(meetingId, personIds);
          console.log(`  → Linked ${personIds.length} people to meeting`);
        }
      }

      // 3g. Mark as synced
      state.syncedIds.add(summary.id);
      synced++;
      consecutiveErrors = 0;

      // Brief pause between transcripts to avoid rate limits
      await sleep(200);

    } catch (err) {
      console.error(`  → ERROR: ${err.message}`);
      errors++;
      consecutiveErrors++;

      // Stop after too many consecutive errors (likely a systemic issue)
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`\nStopping: ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Check your API keys and try again.`);
        break;
      }

      // Brief pause before retrying next transcript
      await sleep(1000);
    }

    console.log();
  }

  // ── Step 4: Update state ──────────────────────────────────────────────────
  state.lastSyncDate = new Date().toISOString();
  state.stats.totalSynced += synced;
  state.stats.totalSkipped += skipped;
  state.stats.totalErrors += errors;
  state.stats.lastRunDate = new Date().toISOString();
  // Persist person cache (email → personId) to avoid re-resolving on next run
  state.personCache = Object.fromEntries(personCache);

  if (!dryRun) {
    saveState(state);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('─'.repeat(50));
  console.log(`Sync complete${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`  Synced:  ${synced}`);
  console.log(`  Skipped: ${skipped} (already synced)`);
  console.log(`  Errors:  ${errors}`);
  console.log(`  API calls made: ${fireflies.requestCount} (Fireflies)`);
  console.log();

  if (!dryRun && synced > 0) {
    console.log(`State saved to .sync-state.json`);
    console.log(`Next sync will start from: ${state.lastSyncDate}`);
  }
}

/**
 * Test API connections without syncing anything.
 * Validates both Fireflies and Clarify credentials.
 */
async function testConnections() {
  const config = loadConfig();
  validateConfig(config);

  console.log('Testing API connections...\n');

  // Test Fireflies
  console.log('1. Fireflies API:');
  try {
    const fireflies = new FirefliesClient(config.firefliesApiKey);
    const user = await fireflies.getCurrentUser();
    console.log(`   ✓ Connected as: ${user.name} (${user.email})`);
    console.log(`   ✓ Transcripts: ${user.num_transcripts || 0}`);

    // Quick count of recent transcripts
    const recent = await fireflies.listTranscripts({ limit: 1 });
    console.log(`   ✓ Transcripts accessible: yes`);
    if (recent[0]) {
      console.log(`   ✓ Most recent: "${recent[0].title}" (${new Date(recent[0].date).toLocaleDateString()})`);
    }
  } catch (err) {
    console.error(`   ✗ Failed: ${err.message}`);
    console.error('   → Check your FIREFLIES_API_KEY');
    console.error('   → Get your key from: https://app.fireflies.ai/integrations/custom/fireflies');
  }

  console.log();

  // Test Clarify
  console.log('2. Clarify API:');
  try {
    const clarify = new ClarifyClient(config.clarifyWorkspace, config.clarifyApiKey);
    await clarify.testConnection();
    console.log(`   ✓ Connected to workspace: ${config.clarifyWorkspace}`);
    console.log(`   ✓ Meetings endpoint accessible`);
  } catch (err) {
    console.error(`   ✗ Failed: ${err.message}`);
    console.error('   → Check your CLARIFY_WORKSPACE and CLARIFY_API_KEY');
    console.error('   → Make sure the API key has the correct workspace');
  }

  console.log();

  // Show internal domains config
  if (config.internalDomains.length > 0) {
    console.log(`3. Internal domains: ${config.internalDomains.join(', ')}`);
  } else {
    console.log('3. Internal domains: (not configured — set INTERNAL_DOMAINS in .env)');
  }

  console.log('\nDone. If both APIs are connected, you can run:');
  console.log('  node sync.mjs --dry-run     # Preview what would sync');
  console.log('  node sync.mjs --backfill    # Sync all history');
  console.log('  node sync.mjs              # Sync recent transcripts');
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Entry Point
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Fireflies → Clarify Transcript Sync

Usage:
  node sync.mjs              Sync recent transcripts (last N days)
  node sync.mjs --backfill   Sync ALL historical transcripts
  node sync.mjs --dry-run    Preview what would be synced (no writes)
  node sync.mjs --test       Test API connections only

Options:
  --backfill    Fetch all historical transcripts, not just recent ones
  --dry-run     Show what would be synced without making any changes
  --test        Verify Fireflies and Clarify API connections
  --help, -h    Show this help message

Environment:
  Configure via .env file (copy from .env.example).
  See README.md for full documentation.
`);
  process.exit(0);
}

if (args.includes('--test')) {
  testConnections().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
} else {
  sync({
    backfill: args.includes('--backfill'),
    dryRun: args.includes('--dry-run'),
  }).catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
