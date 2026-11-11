-- Funded scaling (rulebook section 16). Every funded account has a funded level within its tier; the knight's onchain
-- `level` attribute mirrors it. `starting_balance` keeps meaning the account's CURRENT size: a level-up writes a
-- `level_up` balance adjustment (append-only, kind level_up) for the size step and moves starting_balance to the new
-- size, so replaying the ledger from (starting_balance - level_up steps) rebuilds the balance exactly.
-- Existing funded accounts become Lv.1 of their tier (their size is the tier's Lv.1 size already).

ALTER TABLE challenges ADD COLUMN funded_level integer;
UPDATE challenges SET funded_level = 1 WHERE stage = 'funded';
