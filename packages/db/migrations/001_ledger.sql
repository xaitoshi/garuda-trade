-- Garuda core: challenge ledger.
-- Money columns are double precision (simulated USDC; the sim engine is IEEE double). Times are ms since epoch (bigint).
-- The ledger tables (fills, funding_payments, risk_events, combat_log) are append-only: see 004_append_only.sql.
-- `challenges.state` is a cache of the risk monitor and mark state; balances are rebuilt by replaying the ledger.

CREATE TABLE challenges (
  id text PRIMARY KEY,
  tier text NOT NULL,
  stage text NOT NULL,
  knight text NOT NULL,
  knight_id text,
  wallet text,
  created_at bigint NOT NULL,
  starting_balance double precision NOT NULL,
  status text NOT NULL,
  lifecycle text NOT NULL,
  last_activity_at bigint NOT NULL,
  dormant_since bigint,
  archived_at bigint,
  breach_at bigint,
  revive_of text,
  revived_by text,
  revive_fee_usd double precision,
  payment_ref text,
  balance double precision NOT NULL,
  state jsonb NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX challenges_wallet_idx ON challenges (wallet);
CREATE INDEX challenges_knight_idx ON challenges (knight_id);
CREATE INDEX challenges_status_idx ON challenges (status);

CREATE TABLE orders (
  challenge_id text NOT NULL,
  id text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  type text NOT NULL,
  size double precision NOT NULL,
  remaining double precision NOT NULL,
  limit_price double precision,
  reduce_only boolean NOT NULL,
  post_only boolean NOT NULL,
  status text NOT NULL,
  reject_reason text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (challenge_id, id)
);

CREATE TABLE fills (
  challenge_id text NOT NULL,
  seq integer NOT NULL,
  id text NOT NULL,
  order_id text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  price double precision NOT NULL,
  size double precision NOT NULL,
  notional double precision NOT NULL,
  fee double precision NOT NULL,
  liquidity text NOT NULL,
  realized_pnl double precision NOT NULL,
  closed_size double precision NOT NULL,
  closed_direction text,
  position_after double precision NOT NULL,
  forced boolean NOT NULL,
  ts bigint NOT NULL,
  PRIMARY KEY (challenge_id, seq)
);

CREATE TABLE funding_payments (
  challenge_id text NOT NULL,
  seq integer NOT NULL,
  symbol text NOT NULL,
  amount double precision NOT NULL,
  rate_hourly double precision NOT NULL,
  mark_price double precision NOT NULL,
  position_size double precision NOT NULL,
  ts bigint NOT NULL,
  PRIMARY KEY (challenge_id, seq)
);

CREATE TABLE risk_events (
  challenge_id text NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  ts bigint NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (challenge_id, seq)
);

CREATE TABLE combat_log (
  challenge_id text NOT NULL,
  seq integer NOT NULL,
  kind text NOT NULL,
  ts bigint NOT NULL,
  amount double precision,
  text text NOT NULL,
  PRIMARY KEY (challenge_id, seq)
);
