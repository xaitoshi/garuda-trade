-- Sign-In-With-Solana style wallet auth: single-use nonces and opaque session tokens (only the sha256 is stored).

CREATE TABLE auth_nonces (
  nonce text PRIMARY KEY,
  wallet text NOT NULL,
  message text NOT NULL,
  issued_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  used_at bigint
);
CREATE INDEX auth_nonces_wallet_idx ON auth_nonces (wallet);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  wallet text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at bigint
);
CREATE INDEX sessions_wallet_idx ON sessions (wallet);
