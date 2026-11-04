-- pg-only
-- The payout ledger and the balance adjustments are append-only at the database level, like the trading ledger
-- (004_append_only.sql). `payouts` stays mutable: it is a projection that can be rebuilt from `payout_ledger`.

CREATE TRIGGER payout_ledger_append_only BEFORE UPDATE OR DELETE ON payout_ledger
  FOR EACH ROW EXECUTE FUNCTION garuda_reject_mutation();
CREATE TRIGGER balance_adjustments_append_only BEFORE UPDATE OR DELETE ON balance_adjustments
  FOR EACH ROW EXECUTE FUNCTION garuda_reject_mutation();
