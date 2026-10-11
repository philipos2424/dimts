-- Apply before deploying number quarantine. NULL means never released (fresh
-- stock), which can be assigned at once; release sets a cooling-off date.
-- No blanket hold on existing stock: it would leave new paying customers
-- without a number. Numbers released from now on wait NUMBER_QUARANTINE_DAYS.
ALTER TABLE agent_number_pool ADD COLUMN IF NOT EXISTS available_after TIMESTAMPTZ;
