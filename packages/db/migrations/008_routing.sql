-- Phase 2 Phoenix order routing (packages/router). Nothing writes here while ROUTING_ENABLED is false.
-- routing_traders: admin-selected funded accounts eligible for A-book routing (per-trader opt-in).
-- routing_orders: append-style audit log, one row per intended, sent, failed or skipped mirror order, with its A/B label.
-- routing_positions: the router's view of the firm position per (mode, funded account, market). dry_run and live are
-- tracked separately so switching from DRY_RUN to live starts from a flat book.
-- routing_state: small key/value flags (admin halt, daily loss halt, daily PnL).

CREATE TABLE routing_traders (
  challenge_id text PRIMARY KEY,
  wallet text,
  enabled boolean NOT NULL,
  multiplier double precision,
  note text,
  updated_at bigint NOT NULL,
  updated_by text NOT NULL
);

CREATE TABLE routing_orders (
  id text PRIMARY KEY,
  ts bigint NOT NULL,
  mode text NOT NULL,
  challenge_id text NOT NULL,
  wallet text,
  symbol text NOT NULL,
  side text,
  size double precision NOT NULL,
  notional double precision NOT NULL,
  ref_price double precision,
  limit_price double precision,
  book text NOT NULL,
  action text NOT NULL,
  reason text,
  status text NOT NULL,
  signature text,
  error text,
  trigger_fill_id text,
  updated_at bigint NOT NULL
);
CREATE INDEX routing_orders_ts_idx ON routing_orders (ts);
CREATE INDEX routing_orders_challenge_idx ON routing_orders (challenge_id, ts);

CREATE TABLE routing_positions (
  mode text NOT NULL,
  challenge_id text NOT NULL,
  symbol text NOT NULL,
  size double precision NOT NULL,
  avg_price double precision NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (mode, challenge_id, symbol)
);

CREATE TABLE routing_state (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at bigint NOT NULL
);
