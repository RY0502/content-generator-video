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

  // A rejected chunk remains private and non-authoritative, but retaining its
  // exact candidate lets a later invocation patch only the failing fields
  // instead of asking the model to recreate an otherwise-good scene range.
  // The accepted draft identity is an optimistic-concurrency boundary: a
  // candidate can never be applied after its durable prefix has advanced.
  `CREATE TABLE IF NOT EXISTS episode_script_pending_chunks (
    episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
    accepted_draft_revision INTEGER NOT NULL CHECK (accepted_draft_revision >= 1),
    accepted_draft_digest TEXT NOT NULL CHECK (length(accepted_draft_digest) = 64),
    operation TEXT NOT NULL CHECK (operation IN ('start', 'append', 'restart')),
    scene_start INTEGER NOT NULL CHECK (scene_start >= 1),
    scene_end INTEGER NOT NULL CHECK (scene_end >= scene_start),
    candidate_scenes_json TEXT NOT NULL,
    candidate_digest TEXT NOT NULL CHECK (length(candidate_digest) = 64),
    structured_issues_json TEXT NOT NULL,
    issue_fingerprint TEXT NOT NULL CHECK (length(issue_fingerprint) = 64),
    consecutive_no_progress_attempts INTEGER NOT NULL DEFAULT 0
      CHECK (consecutive_no_progress_attempts >= 0),
    total_correction_attempts INTEGER NOT NULL DEFAULT 0
      CHECK (total_correction_attempts >= 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (consecutive_no_progress_attempts <= total_correction_attempts)
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
    render_revision INTEGER NOT NULL DEFAULT 0 CHECK (render_revision BETWEEN 0 AND 1),
    qa_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (qa_status IN ('pending', 'passed', 'awaiting_regeneration', 'exhausted')),
    qa_request_digest TEXT,
    qa_video_sha256 TEXT,
    qa_result_json TEXT,
    qa_contact_sheet_path TEXT,
    qa_model TEXT,
    qa_error TEXT,
    qa_checked_at TEXT,
    error TEXT,
    submitted_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (series_id, episode_number)
      REFERENCES episodes(series_id, episode_number) ON DELETE CASCADE,
    UNIQUE (series_id, episode_number, scene_number, variant)
  )`,

  // A QA rejection is the only transition allowed to supersede a completed
  // Agnes render. Preserve its full durable snapshot before the active row is
  // reset so retries remain auditable without weakening the normal monotonic
  // generation state machine.
  `CREATE TABLE IF NOT EXISTS agnes_scene_generation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    scene_number INTEGER NOT NULL,
    variant TEXT NOT NULL CHECK (variant IN ('text', 'reference')),
    render_revision INTEGER NOT NULL CHECK (render_revision BETWEEN 0 AND 1),
    request_digest TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    qa_result_json TEXT NOT NULL,
    archived_video_path TEXT,
    archived_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (series_id, episode_number)
      REFERENCES episodes(series_id, episode_number) ON DELETE CASCADE,
    UNIQUE (series_id, episode_number, scene_number, variant, render_revision)
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
