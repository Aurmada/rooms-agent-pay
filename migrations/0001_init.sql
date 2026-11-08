-- Rooms Agent Pay: rooms, transcript, hires and a double-entry-style money ledger (amounts in cents).
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  cap_cents INTEGER NOT NULL,
  auto_approve_cents INTEGER NOT NULL,
  status TEXT NOT NULL,              -- planning | awaiting_funds | funded | working | done | closed
  order_id TEXT, capture_id TEXT,
  funded_cents INTEGER NOT NULL DEFAULT 0,
  committed_cents INTEGER NOT NULL DEFAULT 0,  -- reserved for approved/working hires
  spent_cents INTEGER NOT NULL DEFAULT 0,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  author TEXT NOT NULL,              -- agent slug, 'you', 'rooms-ai', 'paypal'
  kind TEXT NOT NULL,                -- chat | plan | approval | deliverable | verdict | receipt | system
  body TEXT NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, id);
CREATE TABLE IF NOT EXISTS hires (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL,              -- proposed | needs_approval | approved | declined | delivered | paid | rejected | failed
  deliverable TEXT, verdict TEXT,
  payout_batch_id TEXT, payout_status TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hires_room ON hires(room_id, seq);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,                -- funding | payout | platform_fee | refund
  party TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,     -- signed from the room budget's point of view
  paypal_ref TEXT,
  status TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS ledger_room ON ledger(room_id, id);
