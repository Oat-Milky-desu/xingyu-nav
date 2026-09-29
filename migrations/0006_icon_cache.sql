-- Derived provider favicons are private per-link cache entries. They are
-- intentionally excluded from content revisions and backup payloads.
CREATE TABLE link_icon_cache (
  link_id TEXT PRIMARY KEY REFERENCES links(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  mime_type TEXT,
  image BLOB,
  negative_until_ms INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until_ms INTEGER,
  last_refresh_at_ms INTEGER,
  updated_at TEXT NOT NULL,
  CHECK (
    (image IS NULL AND mime_type IS NULL)
    OR (image IS NOT NULL AND length(image) BETWEEN 1 AND 65536 AND mime_type IN (
      'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon'
    ))
  ),
  CHECK (status != 'ready' OR image IS NOT NULL),
  CHECK (status != 'failed' OR image IS NULL),
  CHECK ((lease_id IS NULL AND lease_until_ms IS NULL) OR (lease_id IS NOT NULL AND lease_until_ms IS NOT NULL))
);

-- An in-flight fetch is tied to the link fields it read. Releasing its lease
-- on edits prevents a stale response from overwriting the next icon state.
CREATE TRIGGER links_invalidate_icon_cache_lease
AFTER UPDATE OF url, icon_type, icon_value ON links
WHEN NEW.url IS NOT OLD.url OR NEW.icon_type IS NOT OLD.icon_type OR NEW.icon_value IS NOT OLD.icon_value
BEGIN
  UPDATE link_icon_cache SET lease_id = NULL, lease_until_ms = NULL WHERE link_id = NEW.id;
END;
