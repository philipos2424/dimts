/**
 * Plan seconds a call counts against its owner's monthly minutes. A pending
 * call holds its reservation; a finished one never counts more than it lasted.
 */
export const PLAN_SECONDS_SQL = `CASE WHEN duration_sec IS NULL THEN COALESCE(plan_seconds, max_duration_sec)
  ELSE LEAST(COALESCE(plan_seconds, duration_sec), duration_sec) END`;
