-- Durable outbox for Kapso handoff notifications in the SAME Supabase project.
-- No direct browser access; used by authenticated backend with service_role.
begin;
create table if not exists public.crm_handoff_outbox(
  business_id uuid not null,
  event_key text not null,
  state text not null default 'pending' check(state in ('pending','sending','sent','failed')),
  attempts integer not null default 0 check(attempts>=0),
  provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(business_id,event_key),
  foreign key(business_id,event_key) references public.crm_handoffs(business_id,event_key) on delete cascade
);
create index if not exists crm_handoff_pending_idx on public.crm_handoff_outbox(business_id,state,updated_at);
alter table public.crm_handoff_outbox enable row level security;
revoke all on public.crm_handoff_outbox from public,anon,authenticated;
commit;
