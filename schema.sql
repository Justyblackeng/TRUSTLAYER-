-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run

create table if not exists public.score_drafts (
  id             uuid primary key default gen_random_uuid(),
  subject_id     text not null,          -- hashed bank account or wallet id (never the raw account number)
  id_type        text not null check (id_type in ('bank','wallet')),
  issuer_key     text not null,
  wallet_address text,
  score          int  not null check (score between 300 and 850),
  loan_ngn       bigint not null,
  score_hash     text not null,
  minting        boolean not null default false,
  minted         boolean not null default false,
  tx_hash        text,
  created_at     timestamptz not null default now()
);

create table if not exists public.credential_events (
  id         bigint generated always as identity primary key,
  subject_id text not null,
  issuer_key text not null,
  score      int  not null,
  tx_hash    text not null,
  created_at timestamptz not null default now()
);

-- Lock both tables down. Only the backend (service_role key) can read or write them;
-- the public anon key gets nothing because no policies exist.
alter table public.score_drafts      enable row level security;
alter table public.credential_events enable row level security;

create index if not exists score_drafts_created_idx on public.score_drafts (created_at);

-- Optional: delete old drafts daily (enable the pg_cron extension first)
-- select cron.schedule('clean-drafts','0 3 * * *',$$delete from public.score_drafts where created_at < now() - interval '1 day'$$);

-- Fee payments (NGN 200 / about USD 0.13 per mint or verification)
create table if not exists public.payments (
  reference    text primary key,
  purpose      text not null check (purpose in ('mint','verify')),
  currency     text not null check (currency in ('NGN','USD')),
  amount_minor bigint not null,          -- kobo for NGN, cents for USD
  status       text not null default 'pending',
  used         boolean not null default false,
  subject_id   text,                     -- hashed account the fee is debited from
  challenge_id text,
  attempts     int not null default 0,
  payee_key    text,                     -- who receives the fee: always 'platform'
  bank_key     text,                     -- the customer's bank, for reporting
  meta         jsonb,                    -- wallet fee: the typed data the holder signs (+ tx hash)
  created_at   timestamptz not null default now()
);
-- if you already created the payments table earlier, these add the new columns:
alter table public.payments add column if not exists subject_id text;
alter table public.payments add column if not exists challenge_id text;
alter table public.payments add column if not exists attempts int not null default 0;
alter table public.payments add column if not exists meta jsonb;
alter table public.payments add column if not exists payee_key text;   -- always 'platform'
alter table public.payments add column if not exists bank_key text;    -- the customer's bank (for reporting)
create index if not exists payments_subject_idx on public.payments (subject_id, created_at);
alter table public.payments drop constraint if exists payments_purpose_check;
alter table public.payments add constraint payments_purpose_check check (purpose in ('mint','verify','consent'));
alter table public.payments enable row level security;
