-- FTS5 index over company name and domain for the accounts search (SPEC §2, §6).
-- External-content table kept in sync by triggers.
CREATE VIRTUAL TABLE `companies_fts` USING fts5(name, domain, content='companies', content_rowid='rowid', tokenize='unicode61');
--> statement-breakpoint
CREATE TRIGGER `companies_fts_ai` AFTER INSERT ON `companies` BEGIN
  INSERT INTO companies_fts(rowid, name, domain) VALUES (new.rowid, new.name, new.domain);
END;
--> statement-breakpoint
CREATE TRIGGER `companies_fts_ad` AFTER DELETE ON `companies` BEGIN
  INSERT INTO companies_fts(companies_fts, rowid, name, domain) VALUES ('delete', old.rowid, old.name, old.domain);
END;
--> statement-breakpoint
CREATE TRIGGER `companies_fts_au` AFTER UPDATE ON `companies` BEGIN
  INSERT INTO companies_fts(companies_fts, rowid, name, domain) VALUES ('delete', old.rowid, old.name, old.domain);
  INSERT INTO companies_fts(rowid, name, domain) VALUES (new.rowid, new.name, new.domain);
END;
