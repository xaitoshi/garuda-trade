-- pg-only
-- Make the ledger append-only at the database level: UPDATE and DELETE on ledger tables raise.
-- (Skipped for the in-memory pg-mem test database, which has no trigger support.)

CREATE FUNCTION garuda_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fills_append_only BEFORE UPDATE OR DELETE ON fills
  FOR EACH ROW EXECUTE FUNCTION garuda_reject_mutation();
CREATE TRIGGER funding_payments_append_only BEFORE UPDATE OR DELETE ON funding_payments
  FOR EACH ROW EXECUTE FUNCTION garuda_reject_mutation();
CREATE TRIGGER risk_events_append_only BEFORE UPDATE OR DELETE ON risk_events
  FOR EACH ROW EXECUTE FUNCTION garuda_reject_mutation();
CREATE TRIGGER combat_log_append_only BEFORE UPDATE OR DELETE ON combat_log
  FOR EACH ROW EXECUTE FUNCTION garuda_reject_mutation();
