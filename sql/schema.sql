-- Lost and Found schema (PostgreSQL). Safe to re-run: everything is IF NOT EXISTS.
-- Identifiers are unquoted, so Postgres stores them lowercase (itemid, requestid...).

CREATE TABLE IF NOT EXISTS roles (
  roleId   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  userRole VARCHAR(100) NOT NULL UNIQUE CHECK (userRole IN ('admin','moderator'))
);

CREATE TABLE IF NOT EXISTS users (
  userId            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              VARCHAR(50)  NOT NULL UNIQUE,
  roleId            INT NOT NULL REFERENCES roles(roleId),
  password_hash     VARCHAR(255) NOT NULL,            -- bcrypt, one-way
  contact_encrypted BYTEA NOT NULL,                   -- AES-256-CBC
  contact_iv        BYTEA NOT NULL UNIQUE
);

-- 'claimed' is added to the PDF's three statuses so an approved claim has somewhere to go.
CREATE TABLE IF NOT EXISTS items (
  itemId      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  description VARCHAR(255) NOT NULL,
  status      VARCHAR(20)  NOT NULL CHECK (status IN ('lost','found','forgotten','claimed')),
  reportedAt  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- code is NOT unique (the PDF's UNIQUE would allow only one 'found' row for the whole system).
CREATE TABLE IF NOT EXISTS log (
  id        INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  itemId    INT NOT NULL REFERENCES items(itemId),
  code      VARCHAR(20) NOT NULL,
  changedAt TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claim_requests (
  requestId                 INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  itemId                    INT NOT NULL REFERENCES items(itemId),
  claimantName_encrypted    BYTEA NOT NULL,
  claimantName_iv           BYTEA NOT NULL UNIQUE,
  claimantContact_encrypted BYTEA NOT NULL,
  claimantContact_iv        BYTEA NOT NULL UNIQUE,
  proposedSchedule          TIMESTAMPTZ NOT NULL,
  status                    VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submittedAt               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS item_transactions (
  transactionId           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  itemId                  INT NOT NULL REFERENCES items(itemId),
  requestId               INT REFERENCES claim_requests(requestId),
  type                    VARCHAR(20) NOT NULL CHECK (type IN ('deposit','claim')),
  personName_encrypted    BYTEA NOT NULL,
  personName_iv           BYTEA NOT NULL UNIQUE,
  personContact_encrypted BYTEA NOT NULL,
  personContact_iv        BYTEA NOT NULL UNIQUE,
  handledBy               INT NOT NULL REFERENCES users(userId),
  timestamp               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No secondary indexes on purpose: the Demo tab creates/drops them to show EXPLAIN before/after.
