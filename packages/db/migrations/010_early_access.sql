-- Garuda Beta Access (/early). One row per claim. status:
--   waitlist          minting was off when they signed up (no payment taken)
--   awaiting_payment  quoted: the buyer must send amount_base_units USDC to the treasury with `reference` attached
--   paid              payment verified, NFT not minted yet (a retry or POST /admin/early/mint-pending finishes it)
--   minted            asset + mint_signature set
--   refund_due        paid after the supply cap was reached: refund by hand from the treasury
-- One NFT per wallet and per email: both are UNIQUE (email is stored lowercased). A payment signature can pay once.
CREATE TABLE early_claims (
  id text PRIMARY KEY,
  wallet text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  status text NOT NULL,
  reference text UNIQUE,
  amount_base_units text,
  payer text,
  payment_signature text UNIQUE,
  asset text,
  mint_signature text,
  error text,
  ip_hash text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  expires_at bigint,
  paid_at bigint,
  minted_at bigint
);
CREATE INDEX early_claims_status_idx ON early_claims (status, created_at);
