-- Hall Pilot 1.15 / Phase 1: additive schema only
-- NOT APPLIED TO PRODUCTION. Run against an isolated development database first.
-- No existing rows, room settings, calendar entries, PINs, or pass histories are changed.

alter table public.school_settings
  add column if not exists room_scheduling_enabled boolean not null default false;

-- Maps an individual room to a named master schedule for a SPECIAL day type.
-- A room's normal/primary schedule remains in room_settings.schedule_mode.
create table if not exists public.room_schedule_assignments (
  room_id uuid not null references public.rooms(id) on delete cascade,
  day_type text not null check (length(trim(day_type)) between 1 and 80 and lower(trim(day_type)) <> 'regular'),
  schedule_name text not null check (length(trim(schedule_name)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (room_id, day_type)
);

create index if not exists room_schedule_assignments_schedule_idx
  on public.room_schedule_assignments (schedule_name);

-- This is intentionally separate from the existing school_calendar: while
-- the feature flag is OFF, ALL legacy calendar behavior remains unchanged.
create table if not exists public.school_day_exceptions (
  school_id uuid not null references public.schools(id) on delete cascade,
  calendar_date date not null,
  day_type text not null check (length(trim(day_type)) between 1 and 80 and lower(trim(day_type)) <> 'regular'),
  note text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (school_id, calendar_date)
);

create index if not exists school_day_exceptions_by_type_idx
  on public.school_day_exceptions (school_id, day_type, calendar_date);

-- Both tables are service-role-only: the browser goes through hallpass-staff.
alter table public.room_schedule_assignments enable row level security;
alter table public.school_day_exceptions enable row level security;
revoke all on table public.room_schedule_assignments from public, anon, authenticated;
revoke all on table public.school_day_exceptions from public, anon, authenticated;

comment on column public.school_settings.room_scheduling_enabled is
  'Hall Pilot 1.15 feature flag. FALSE retains the existing school-wide calendar resolver.';

comment on table public.room_schedule_assignments is
  'Room -> master schedule mappings for exceptions such as Minimum, Rally, or Testing.';
comment on table public.school_day_exceptions is
  'School-wide exception dates used only when room_scheduling_enabled is TRUE.';
