-- Stop orders (stop-market): the mark price that triggers them, and a stop-loss attached to an entry order (placed as a
-- reduce-only stop for each fill, like take_profit).
ALTER TABLE orders ADD COLUMN trigger_price numeric;
ALTER TABLE orders ADD COLUMN stop_loss numeric;
