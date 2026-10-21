CREATE TABLE IF NOT EXISTS media_mentor_publication_copy_links(
 company_id INTEGER NOT NULL REFERENCES companies(id),post_id INTEGER PRIMARY KEY REFERENCES autoposting_posts(id),
 version_id TEXT NOT NULL UNIQUE,source_post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),source_revision INTEGER NOT NULL,
 source_content_revision INTEGER NOT NULL,source_plan TEXT NOT NULL,target_platform TEXT NOT NULL,
 original_snapshot TEXT NOT NULL,created_at TEXT NOT NULL,actor_id INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS media_mentor_publication_copy_decisions(
 company_id INTEGER NOT NULL REFERENCES companies(id),post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),sequence INTEGER NOT NULL,
 version_id TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('approved','withdrawn')),fingerprint TEXT NOT NULL,
 content_revision INTEGER NOT NULL,brief_revision INTEGER NOT NULL,snapshot TEXT NOT NULL,actor_id INTEGER NOT NULL,
 created_at TEXT NOT NULL,PRIMARY KEY(company_id,post_id,sequence));
 CREATE TRIGGER IF NOT EXISTS media_mentor_publication_copy_links_no_update BEFORE UPDATE ON media_mentor_publication_copy_links BEGIN SELECT RAISE(ABORT,'Immutable publication copy provenance'); END;
 CREATE TRIGGER IF NOT EXISTS media_mentor_publication_copy_links_no_delete BEFORE DELETE ON media_mentor_publication_copy_links BEGIN SELECT RAISE(ABORT,'Immutable publication copy provenance'); END;
 CREATE TRIGGER IF NOT EXISTS media_mentor_publication_copy_decisions_no_update BEFORE UPDATE ON media_mentor_publication_copy_decisions BEGIN SELECT RAISE(ABORT,'Immutable publication copy decision'); END;
 CREATE TRIGGER IF NOT EXISTS media_mentor_publication_copy_decisions_no_delete BEFORE DELETE ON media_mentor_publication_copy_decisions BEGIN SELECT RAISE(ABORT,'Immutable publication copy decision'); END;
CREATE TABLE IF NOT EXISTS autoposting_publication_payloads(
 company_id INTEGER NOT NULL REFERENCES companies(id),post_id INTEGER NOT NULL REFERENCES autoposting_posts(id),channel_id TEXT NOT NULL,started_at TEXT NOT NULL,
 content_revision INTEGER NOT NULL,payload TEXT NOT NULL,fingerprint TEXT NOT NULL,captured_at TEXT NOT NULL,
 PRIMARY KEY(company_id,post_id,channel_id,started_at));
 CREATE TRIGGER IF NOT EXISTS autoposting_publication_payloads_no_update BEFORE UPDATE ON autoposting_publication_payloads BEGIN SELECT RAISE(ABORT,'Immutable publication payload'); END;
 CREATE TRIGGER IF NOT EXISTS autoposting_publication_payloads_no_delete BEFORE DELETE ON autoposting_publication_payloads BEGIN SELECT RAISE(ABORT,'Immutable publication payload'); END;
