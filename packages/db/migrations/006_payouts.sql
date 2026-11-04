-- M8: payouts. `payouts` is the mutable projection (current state of each request, what the API and the reconciler
-- query); `payout_ledger` is the append-only history it is derived from; `balance_adjustments` is the account-ledger
-- entry that moves a funded account's balance (sweep on request, reversal on reject), replayed by SimAccount.restore.
--
-- open_key holds the challenge id while a payout is in flight and is NULL once it is terminal: the UNIQUE constraint
-- (NULLs are distinct) is the database-level guard for "one request in flight per account" (rulebook section 11).

CREATE TABLE payouts (
  id text PRIMARY KEY,
  challenge_id text NOT NULL,
  wallet text NOT NULL,
  status text NOT NULL,
  open_key text UNIQUE,
  idempotency_key text,
  amount_base_units text NOT NULL,
  next_attempt_at bigint,
  data text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX payouts_idempotency_idx ON payouts (wallet, idempotency_key);
CREATE INDEX payouts_wallet_idx ON payouts (wallet, created_at);
CREATE INDEX payouts_challenge_idx ON payouts (challenge_id, created_at);
CREATE INDEX payouts_status_idx ON payouts (status);

CREATE TABLE payout_ledger (
  payout_id text NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  ts bigint NOT NULL,
  data text NOT NULL,
  PRIMARY KEY (payout_id, seq)
);

CREATE TABLE balance_adjustments (
  challenge_id text NOT NULL,
  seq integer NOT NULL,
  id text NOT NULL,
  kind text NOT NULL,
  amount double precision NOT NULL,
  ref text NOT NULL,
  ts bigint NOT NULL,
  PRIMARY KEY (challenge_id, seq),
  UNIQUE (challenge_id, id)
);
