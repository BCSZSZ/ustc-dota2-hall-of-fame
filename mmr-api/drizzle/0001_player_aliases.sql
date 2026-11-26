ALTER TABLE mmr_state ADD COLUMN aliases TEXT NOT NULL DEFAULT '{}' CHECK (json_type(aliases) = 'object');
