CREATE TABLE mmr_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  ratings TEXT NOT NULL CHECK (json_type(ratings) = 'object'),
  updated_at TEXT
) STRICT;
--> statement-breakpoint
INSERT INTO mmr_state (id, revision, ratings) VALUES (1, 0, '{}');
