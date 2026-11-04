-- M4: USDC checkout orders. One row per purchase (challenge or revive). The unique signature index is the replay
-- guard: a transfer can pay for exactly one order. `data` holds the full order JSON; the columns are what we query.

CREATE TABLE payment_orders (
  id text PRIMARY KEY,
  wallet text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  reference text NOT NULL UNIQUE,
  signature text UNIQUE,
  data text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX payment_orders_wallet_idx ON payment_orders (wallet, created_at);
CREATE INDEX payment_orders_status_idx ON payment_orders (status);
