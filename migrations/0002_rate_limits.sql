-- Sliding-window counters for Email OTP send/verify rate limits (per email and per IP).
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
