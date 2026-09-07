/**
 * Idempotent Turso/libSQL domain-schema bootstrap statements.
 *
 * Keep each array item to exactly one SQL statement so callers can execute the
 * schema atomically with `client.batch(DOMAIN_SCHEMA_STATEMENTS, "write")`.
 * Tables are ordered before the tables that reference them.
 */
export const DOMAIN_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_name TEXT NOT NULL UNIQUE,
    characters_json TEXT NOT NULL DEFAULT '[]',
    environments_json TEXT NOT NULL DEFAULT '[]',
    episode_formula TEXT,
    agnes_seed INTEGER CHECK (agnes_seed BETWEEN 0 AND 2147483647),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS agnes_account_rate_state (
    account_id TEXT NOT NULL,
    lane TEXT NOT NULL,
    next_slot_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (next_slot_at_ms >= 0),
    blocked_until_ms INTEGER NOT NULL DEFAULT 0 CHECK (blocked_until_ms >= 0),
    block_reason TEXT,
    updated_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (updated_at_ms >= 0),
    PRIMARY KEY (account_id, lane)
  )`,

  `CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    premise TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'script', 'images', 'audio', 'assembly', 'done', 'failed')),
    script_json TEXT,
    output_path TEXT,
    youtube_video_id TEXT,
    youtube_url TEXT,
    uploaded_at TEXT,
    completed_at TEXT,
    completion_local_date TEXT,
    scheduler_skipped_at TEXT,
    scheduler_skip_reason TEXT,
    audio_revision INTEGER NOT NULL DEFAULT 0 CHECK (audio_revision >= 0),
    audio_mutation_token TEXT,
    audio_mutation_scene_number INTEGER
      CHECK (audio_mutation_scene_number IS NULL OR audio_mutation_scene_number > 0),
    audio_mutation_expires_at_ms INTEGER
      CHECK (audio_mutation_expires_at_ms IS NULL OR audio_mutation_expires_at_ms >= 0),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (series_id, episode_number)
  )`,

  // Invalid or partially-refined scripts live here until the production
  // contract passes. Keeping them separate from episodes.script_json prevents
  // resumable authoring work from becoming media-authoritative too early.
  `CREATE TABLE IF NOT EXISTS episode_script_drafts (
    episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    script_digest TEXT NOT NULL CHECK (length(script_digest) = 64),
    draft_json TEXT NOT NULL,
    validation_json TEXT
      CHECK (validation_json IS NULL OR length(validation_json) <= 8192),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS character_sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    character_name TEXT NOT NULL,
    description TEXT NOT NULL,
    reference_image_paths TEXT NOT NULL DEFAULT '{}',
    generation_prompt TEXT,
    approved_at TEXT,
    UNIQUE (series_id, character_name)
  )`,

  // Legacy image-key-art rows only. Direct key-art videos use reserved Agnes
  // generation row numbers so they share the exact scene retry state machine.
  `CREATE TABLE IF NOT EXISTS key_art (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    art_type TEXT NOT NULL CHECK (art_type IN ('series', 'episode')),
    episode_number INTEGER,
    candidate_paths TEXT NOT NULL DEFAULT '{}',
    selected_path TEXT,
    rationale TEXT,
    approved_at TEXT,
    UNIQUE (series_id, art_type, episode_number)
  )`,

  // Positive scene_number values are script scenes; -2/-1 are series/episode
  // key-art videos. Keeping them together guarantees one scheduler/retry path.
  `CREATE TABLE IF NOT EXISTS agnes_scene_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    scene_number INTEGER NOT NULL,
    variant TEXT NOT NULL CHECK (variant IN ('text', 'reference')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'submitted', 'queued', 'in_progress', 'completed', 'failed')),
    prompt TEXT NOT NULL,
    request_digest TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    seed INTEGER,
    requested_duration_seconds REAL NOT NULL,
    provider_duration_seconds INTEGER NOT NULL,
    public_reference_url TEXT,
    provider_task_id TEXT,
    provider_receipt_json TEXT,
    provider_video_url TEXT,
    raw_output_path TEXT,
    normalized_output_path TEXT,
    download_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (download_status IN ('pending', 'downloaded', 'failed')),
    error TEXT,
    submitted_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (series_id, episode_number)
      REFERENCES episodes(series_id, episode_number) ON DELETE CASCADE,
    UNIQUE (series_id, episode_number, scene_number, variant)
  )`,

  `CREATE TABLE IF NOT EXISTS episode_video_outputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    variant TEXT NOT NULL CHECK (variant IN ('static', 'agnes_text', 'agnes_reference')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'completed', 'failed')),
    output_path TEXT,
    duration_seconds REAL,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (series_id, episode_number)
      REFERENCES episodes(series_id, episode_number) ON DELETE CASCADE,
    UNIQUE (series_id, episode_number, variant)
  )`,

  `CREATE TABLE IF NOT EXISTS youtube_upload_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    video_id TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (series_id, episode_number)
      REFERENCES episodes(series_id, episode_number) ON DELETE CASCADE,
    UNIQUE (series_id, episode_number)
  )`,
] as const;
