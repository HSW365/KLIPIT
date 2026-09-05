-- Klipit schema. Apply to the HSW365 Supabase project.
-- Storage: also create a PUBLIC bucket named "klipit-clips".

create table if not exists public.klipit_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  stripe_customer_id text unique,
  tier text not null default 'starter',
  status text not null default 'inactive',        -- active | canceled | past_due | inactive
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists klipit_subscribers_email_idx on public.klipit_subscribers (lower(email));

create table if not exists public.klipit_jobs (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  tier text not null,
  source_url text not null,
  status text not null default 'queued',           -- queued | processing | done | failed
  progress text,
  error text,
  clips jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists klipit_jobs_email_idx on public.klipit_jobs (lower(email));

-- The backend uses the service-role key, which bypasses RLS.
-- Enable RLS so nothing is exposed to the public anon key.
alter table public.klipit_subscribers enable row level security;
alter table public.klipit_jobs enable row level security;
