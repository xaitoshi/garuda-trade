-- A take-profit attached to an entry order. When the entry fills (now or later, in part or in full) the service places a
-- reduce-only limit at this price for the filled size. Lets a resting limit entry carry its TP.
ALTER TABLE orders ADD COLUMN take_profit numeric;
