-- Idempotency keys for revive checkout (payment is stubbed; the key stops a double charge on retry).

CREATE TABLE revive_requests (
  idempotency_key text PRIMARY KEY,
  wallet text NOT NULL,
  source_challenge_id text NOT NULL,
  new_challenge_id text NOT NULL,
  created_at bigint NOT NULL
);
