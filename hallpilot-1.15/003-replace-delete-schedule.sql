-- Hall Pilot 1.15 DEVELOPMENT ONLY. Atomic replace/delete for an assigned master bell schedule.
-- The authenticated Admin Edge Function selects the school scope. Service role only.
create or replace function public.hp_replace_delete_master_schedule(
  p_school_id uuid,
  p_old_name text,
  p_replacement_name text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_old text := btrim(coalesce(p_old_name, ''));
  v_next text := btrim(coalesce(p_replacement_name, ''));
  v_defaults integer := 0;
  v_overrides integer := 0;
  v_calendar integer := 0;
  v_special integer := 0;
begin
  if length(v_old) not between 1 and 80 or length(v_next) not between 1 and 80
     or lower(v_old)=lower(v_next) then
     raise exception 'Choose a different existing replacement schedule.';
  end if;
  -- Serialize whole-schedule edits within one school.
  perform 1 from public.schools where id=p_school_id for update;
  if not found then raise exception 'School not found.'; end if;
  if not exists(select 1 from public.master_schedules where school_id=p_school_id and lower(btrim(schedule_name))=lower(v_old)) then
     raise exception 'Original schedule not found. Refresh and try again.';
  end if;
  select schedule_name into v_next
  from public.master_schedules where school_id=p_school_id and lower(btrim(schedule_name))=lower(v_next)
  order by id limit 1;
  if v_next is null then raise exception 'Replacement schedule not found in this school.'; end if;

  if exists(select 1 from public.passes p join public.rooms r on r.id=p.room_id
            where r.school_id=p_school_id and p.return_at is null)
    or exists(select 1 from public.waiting_requests w join public.rooms r on r.id=w.room_id
              where r.school_id=p_school_id and w.status='WAITING') then
    raise exception 'Return all students and clear waiting requests before replacing a schedule.';
  end if;

  update public.room_settings rs set schedule_mode=v_next,updated_at=now()
  from public.rooms r
  where r.id=rs.room_id and r.school_id=p_school_id and lower(btrim(rs.schedule_mode))=lower(v_old);
  get diagnostics v_defaults = row_count;

  update public.room_settings rs set schedule_override_name=v_next,updated_at=now()
  from public.rooms r
  where r.id=rs.room_id and r.school_id=p_school_id
    and lower(btrim(coalesce(rs.schedule_override_name,'')))=lower(v_old);
  get diagnostics v_overrides = row_count;

  update public.school_calendar
  set schedule_name=v_next,updated_at=now()
  where school_id=p_school_id and lower(btrim(schedule_name))=lower(v_old);
  get diagnostics v_calendar = row_count;

  update public.room_schedule_assignments ra set schedule_name=v_next,updated_at=now()
  from public.rooms r
  where r.id=ra.room_id and r.school_id=p_school_id and lower(btrim(ra.schedule_name))=lower(v_old);
  get diagnostics v_special = row_count;

  -- The existing routine rejects any lingering references; a failure rolls back everything.
  perform public.hp_manage_master_schedule(p_school_id,v_old,'','[]'::jsonb,true);

  return jsonb_build_object('success',true,'message',
    'Schedule replaced by '||v_next||' and deleted. Classroom and calendar assignments updated.',
    'replacement',v_next,'roomDefaultsUpdated',v_defaults,'teacherOverridesUpdated',v_overrides,
    'calendarDatesUpdated',v_calendar,'specialAssignmentsUpdated',v_special);
end
$function$;

revoke all on function public.hp_replace_delete_master_schedule(uuid,text,text) from public,anon,authenticated;
grant execute on function public.hp_replace_delete_master_schedule(uuid,text,text) to service_role;