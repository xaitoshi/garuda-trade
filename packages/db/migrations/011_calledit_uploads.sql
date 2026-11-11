-- /calledit image uploads (fallback when a post's photo does not load). Type is sniffed server side; max 5 MB.
-- Identical files dedupe on sha256. Bytes are kept base64 in text (portable across Postgres and the pg-mem test db).
CREATE TABLE calledit_uploads (
  id text PRIMARY KEY,
  mime text NOT NULL,
  data_b64 text NOT NULL,
  size integer NOT NULL,
  sha256 text NOT NULL UNIQUE,
  ip_hash text,
  created_at bigint NOT NULL
);
