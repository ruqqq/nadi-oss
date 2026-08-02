CREATE VIRTUAL TABLE thread_search_fts USING fts5(
  content,
  content='thread_search_messages',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER thread_search_messages_ai AFTER INSERT ON thread_search_messages BEGIN
  INSERT INTO thread_search_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER thread_search_messages_ad AFTER DELETE ON thread_search_messages BEGIN
  INSERT INTO thread_search_fts(thread_search_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER thread_search_messages_au AFTER UPDATE OF content ON thread_search_messages BEGIN
  INSERT INTO thread_search_fts(thread_search_fts, rowid, content)
  VALUES ('delete', old.id, old.content);
  INSERT INTO thread_search_fts(rowid, content) VALUES (new.id, new.content);
END;