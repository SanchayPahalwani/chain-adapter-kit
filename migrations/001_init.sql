create table withdrawals (
  id               uuid primary key default gen_random_uuid(),
  user_id          text not null,
  idempotency_key  text not null,
  chain            text not null,
  asset            text not null,
  to_address       text not null,
  amount           numeric(78,0) not null check (amount > 0),
  state            text not null check (state in
    ('REJECTED','AWAITING_APPROVAL','APPROVED','RESERVED','SIGNED','BROADCAST','SETTLED','FAILED')),
  reject_reason    text,
  fee              jsonb,
  reservation      jsonb,
  settled_txid     text,
  lease_owner      text,
  lease_expires_at timestamptz,
  next_run_at      timestamptz not null default now(),
  error_count      integer not null default 0,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index withdrawals_due on withdrawals (next_run_at)
  where state in ('APPROVED','RESERVED','SIGNED','BROADCAST');

create table approvals (
  withdrawal_id uuid not null references withdrawals (id),
  approver_id   text not null,
  decision      text not null check (decision in ('approve','reject')),
  created_at    timestamptz not null default now(),
  primary key (withdrawal_id, approver_id)
);

create table allowlist (
  user_id text not null,
  chain   text not null,
  address text not null,
  primary key (user_id, chain, address)
);

create table tx_attempts (
  withdrawal_id uuid not null references withdrawals (id),
  attempt_no    integer not null,
  txid          text not null unique,
  raw           text not null,
  unsigned      jsonb not null,
  fee           jsonb not null,
  created_at    timestamptz not null default now(),
  broadcast_at  timestamptz,
  seen_block    text,
  primary key (withdrawal_id, attempt_no)
);

create table withdrawal_events (
  id            bigserial primary key,
  withdrawal_id uuid not null references withdrawals (id),
  created_at    timestamptz not null default now(),
  kind          text not null,
  data          jsonb not null default '{}'
);

create table ledger_accounts (
  name        text primary key,
  asset       text not null,
  normal_side text not null check (normal_side in ('debit','credit')),
  balance     numeric(78,0) not null default 0 check (balance >= 0)
);
create table ledger_txs (
  id         bigserial primary key,
  ref        text not null unique,
  kind       text not null,
  created_at timestamptz not null default now()
);
create table ledger_entries (
  id      bigserial primary key,
  tx_id   bigint not null references ledger_txs (id),
  account text not null references ledger_accounts (name),
  side    text not null check (side in ('debit','credit')),
  amount  numeric(78,0) not null check (amount > 0)
);

create table chain_sequences (
  key  text primary key,
  next numeric(78,0) not null
);
create table chain_coins (
  id          text primary key,
  owner       text not null,
  amount      numeric(78,0) not null,
  data        jsonb not null,
  reserved_by text
);
