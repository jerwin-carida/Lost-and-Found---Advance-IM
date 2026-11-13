-- Data warehouse (schema dw). Built from the operational lostandfound tables. Safe to re-run.
CREATE SCHEMA IF NOT EXISTS dw;

-- Convert a timestamp to a Manila date key (YYYYMMDD) and minute-of-day key.
CREATE OR REPLACE FUNCTION dw.date_key(ts timestamptz) RETURNS int LANGUAGE sql IMMUTABLE AS
$$ SELECT to_char(ts AT TIME ZONE 'Asia/Manila', 'YYYYMMDD')::int $$;

CREATE OR REPLACE FUNCTION dw.time_key(ts timestamptz) RETURNS int LANGUAGE sql IMMUTABLE AS
$$ SELECT (EXTRACT(HOUR FROM ts AT TIME ZONE 'Asia/Manila') * 60 + EXTRACT(MINUTE FROM ts AT TIME ZONE 'Asia/Manila'))::int $$;

-- ===================== DIMENSIONS =====================
CREATE TABLE IF NOT EXISTS dw.dim_date (
  date_key    INT PRIMARY KEY,                 -- YYYYMMDD
  full_date   DATE NOT NULL,
  day_of_week VARCHAR(10),
  week_no     INT,
  month_no    INT,
  month_name  VARCHAR(10),
  quarter_no  INT,
  year_no     INT,
  semester    VARCHAR(20),
  is_weekend  BOOLEAN
);

CREATE TABLE IF NOT EXISTS dw.dim_time (
  time_key INT PRIMARY KEY,                    -- minute of day (0-1439)
  hour24   INT NOT NULL,
  minute   INT NOT NULL,
  day_part VARCHAR(10)
);

CREATE TABLE IF NOT EXISTS dw.dim_item (
  item_key    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     INT UNIQUE NOT NULL,             -- operational itemId, used for upserts
  description VARCHAR(255),
  category    VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS dw.dim_status (
  status_key  INT PRIMARY KEY,
  status_code VARCHAR(20) UNIQUE NOT NULL      -- lost, found, forgotten, claimed
);

CREATE TABLE IF NOT EXISTS dw.dim_staff (
  staff_key INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id   INT UNIQUE NOT NULL,               -- operational userId
  name      VARCHAR(50),
  role      VARCHAR(20)
);

CREATE TABLE IF NOT EXISTS dw.dim_person (
  person_key  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_hash CHAR(64) UNIQUE NOT NULL         -- HMAC-SHA256 of the normalised contact
);

CREATE TABLE IF NOT EXISTS dw.dim_transaction_type (
  type_key  INT PRIMARY KEY,
  type_code VARCHAR(20) UNIQUE NOT NULL        -- deposit, claim
);

-- ===================== FACTS =====================
-- One row per handover (deposit or claim).
CREATE TABLE IF NOT EXISTS dw.fact_item_transaction (
  transaction_key          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_transaction_id    INT UNIQUE NOT NULL,   -- operational transactionId; makes reloads idempotent
  date_key                 INT REFERENCES dw.dim_date(date_key),
  time_key                 INT REFERENCES dw.dim_time(time_key),
  item_key                 INT REFERENCES dw.dim_item(item_key),
  staff_key                INT REFERENCES dw.dim_staff(staff_key),
  person_key               INT REFERENCES dw.dim_person(person_key),   -- NULL if the contact could not be decrypted
  type_key                 INT REFERENCES dw.dim_transaction_type(type_key),
  claim_submit_date_key    INT REFERENCES dw.dim_date(date_key),
  proposed_pickup_date_key INT REFERENCES dw.dim_date(date_key),
  claim_requested          INT NOT NULL DEFAULT 0,  -- 1 if the handover came from a claim request
  days_to_handover         INT,                     -- claim submitted -> handed over, in days
  pickup_delay_hours       NUMERIC(10,2),           -- proposed pickup -> actual handover, in hours
  etl_batch_id             INT NOT NULL
);

-- One row per item: its current state and how long it took.
CREATE TABLE IF NOT EXISTS dw.fact_item_lifecycle (
  item_key             INT PRIMARY KEY REFERENCES dw.dim_item(item_key),
  reported_date_key    INT REFERENCES dw.dim_date(date_key),
  resolved_date_key    INT REFERENCES dw.dim_date(date_key),   -- date of the 'claimed' log entry
  current_status_key   INT REFERENCES dw.dim_status(status_key),
  claim_requests_cnt   INT NOT NULL DEFAULT 0,
  rejected_claims_cnt  INT NOT NULL DEFAULT 0,
  days_to_resolve      INT,
  days_unclaimed       INT,
  is_returned          BOOLEAN NOT NULL DEFAULT FALSE,
  etl_batch_id         INT NOT NULL
);

-- One row per status period of an item, taken from the operational log.
CREATE TABLE IF NOT EXISTS dw.fact_status_history (
  history_key       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_log_id     INT UNIQUE NOT NULL,           -- the log row that started this period
  item_key          INT REFERENCES dw.dim_item(item_key),
  status_key        INT REFERENCES dw.dim_status(status_key),
  entered_date_key  INT REFERENCES dw.dim_date(date_key),
  entered_time_key  INT REFERENCES dw.dim_time(time_key),
  exited_date_key   INT REFERENCES dw.dim_date(date_key),   -- NULL while the status is current
  exited_time_key   INT REFERENCES dw.dim_time(time_key),
  hours_in_status   NUMERIC(10,2),
  etl_batch_id      INT NOT NULL
);

-- ===================== ETL CONTROL =====================
-- The watermark: everything up to loaded_until is already in the warehouse.
CREATE TABLE IF NOT EXISTS dw.etl_watermark (
  id           INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  loaded_until TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z'
);
INSERT INTO dw.etl_watermark (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS dw.etl_batch (
  batch_id     INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  window_start TIMESTAMPTZ,
  window_end   TIMESTAMPTZ,
  rows_loaded  INT,
  status       VARCHAR(20) NOT NULL DEFAULT 'running',   -- running, success, failed
  error        TEXT
);

-- ===================== STATIC DATA =====================
INSERT INTO dw.dim_status (status_key, status_code) VALUES
  (1,'lost'), (2,'found'), (3,'forgotten'), (4,'claimed')
ON CONFLICT DO NOTHING;

INSERT INTO dw.dim_transaction_type (type_key, type_code) VALUES (1,'deposit'), (2,'claim')
ON CONFLICT DO NOTHING;

INSERT INTO dw.dim_time (time_key, hour24, minute, day_part)
SELECT m, m / 60, m % 60,
  CASE WHEN m / 60 BETWEEN 5 AND 11  THEN 'Morning'
       WHEN m / 60 BETWEEN 12 AND 16 THEN 'Afternoon'
       WHEN m / 60 BETWEEN 17 AND 20 THEN 'Evening'
       ELSE 'Night' END
FROM generate_series(0, 1439) AS m
ON CONFLICT DO NOTHING;

-- Semester boundaries are an assumption (Aug-Dec, Jan-May, Jun-Jul). Confirm with PLV.
INSERT INTO dw.dim_date (date_key, full_date, day_of_week, week_no, month_no, month_name, quarter_no, year_no, semester, is_weekend)
SELECT to_char(d, 'YYYYMMDD')::int, d::date, trim(to_char(d, 'Day')),
       extract(week FROM d)::int, extract(month FROM d)::int, trim(to_char(d, 'Month')),
       extract(quarter FROM d)::int, extract(year FROM d)::int,
       CASE WHEN extract(month FROM d) BETWEEN 8 AND 12 THEN 'Sem 1 (Aug-Dec)'
            WHEN extract(month FROM d) BETWEEN 1 AND 5  THEN 'Sem 2 (Jan-May)'
            ELSE 'Summer (Jun-Jul)' END,
       extract(isodow FROM d) IN (6, 7)
FROM generate_series('2025-01-01'::timestamp, '2030-12-31'::timestamp, interval '1 day') AS d
ON CONFLICT DO NOTHING;
