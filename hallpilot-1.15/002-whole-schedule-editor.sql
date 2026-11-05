-- DEV ONLY: Hall Pilot 1.15 whole-schedule editor.
-- All periods and every live schedule reference change in ONE PostgreSQL transaction.
-- Only the service_role used by the authenticated staff Edge Function can execute.
create or replace function public.hp_manage_master_schedule(
  p_school_id uuid,
  p_original_name text,
  p_name text,
  p_periods jsonb,
  p_delete boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_old text := btrim(coalesce(p_original_name, ''));
  v_name text := btrim(coalesce(p_name, ''));
  v_item jsonb;
  v_period text;
  v_start text;
  v_end text;
  v_periods text[] := '{}'::text[];
  v_rows jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_previous_end time;
  v_refcount integer := 0;
begin
  -- A school-row lock serializes competing whole-schedule changes for one school.
  perform 1 from public.schools where id=p_school_id for update;
  if not found then raise exception 'School not found.'; end if;

  if length(v_old)>80 then raise exception 'Original schedule name is too long.'; end if;
  if v_old<>'' and not exists (
     select 1 from public.master_schedules m
     where m.school_id=p_school_id and lower(btrim(m.schedule_name))=lower(v_old)
  ) then raise exception 'This schedule no longer exists. Refresh and try again.'; end if;

  if v_old<>'' then
    -- Editing definitions while requests/passes are active risks closing a live period.
    if exists (select 1 from public.passes p join public.rooms r on r.id=p.room_id
               where r.school_id=p_school_id and p.return_at is null)
       or exists (select 1 from public.waiting_requests w join public.rooms r on r.id=w.room_id
                  where r.school_id=p_school_id and w.status='WAITING')
    then raise exception 'Wait until students have returned and waiting lists are empty before changing bell schedules.'; end if;
  end if;

  if coalesce(p_delete,false) then
    if v_old='' then raise exception 'Choose a schedule to delete.'; end if;
    if exists(select 1 from public.room_settings rs join public.rooms r on r.id=rs.room_id
              where r.school_id=p_school_id and (
                lower(btrim(rs.schedule_mode))=lower(v_old) or
                lower(btrim(coalesce(rs.schedule_override_name,'')))=lower(v_old)))
       or exists(select 1 from public.school_calendar sc where sc.school_id=p_school_id
                 and lower(btrim(sc.schedule_name))=lower(v_old))
       or exists(select 1 from public.room_schedule_assignments ra join public.rooms r on r.id=ra.room_id
                 where r.school_id=p_school_id and lower(btrim(ra.schedule_name))=lower(v_old))
    then raise exception 'This schedule is assigned to a room or calendar date. Reassign it before deleting.'; end if;
    delete from public.master_schedules
    where school_id=p_school_id and lower(btrim(schedule_name))=lower(v_old);
    return jsonb_build_object('success',true,'message','Schedule deleted.');
  end if;

  if length(v_name)<1 or length(v_name)>80 then
    raise exception 'Schedule name must be 1–80 characters.';
  end if;
  if v_name='__UNASSIGNED_SPECIAL_DAY__' then raise exception 'This schedule name is reserved.'; end if;
  if exists (select 1 from public.master_schedules m
             where m.school_id=p_school_id
               and lower(btrim(m.schedule_name))=lower(v_name)
               and (v_old='' or lower(btrim(m.schedule_name))<>lower(v_old)))
  then raise exception 'Another schedule already uses that name.'; end if;

  if p_periods is null or jsonb_typeof(p_periods)<>'array'
     or jsonb_array_length(p_periods) not between 1 and 50 then
    raise exception 'Include between 1 and 50 periods.';
  end if;
  for v_item in select value from jsonb_array_elements(p_periods) loop
    if jsonb_typeof(v_item)<>'object' then raise exception 'Invalid period.'; end if;
    v_period := btrim(coalesce(v_item->>'period',''));
    v_start := coalesce(v_item->>'startTime','');
    v_end := coalesce(v_item->>'endTime','');
    if length(v_period)<1 or length(v_period)>40 then raise exception 'Every period needs a name (maximum 40 characters).'; end if;
    if lower(v_period)=any(v_periods) then raise exception 'Period names must be unique within one schedule.'; end if;
    if v_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or v_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or v_end::time<=v_start::time
    then raise exception 'Every period needs a valid start and end time.'; end if;
    v_periods := array_append(v_periods,lower(v_period));
    v_rows := v_rows || jsonb_build_array(
      jsonb_build_object('period',v_period,'startTime',v_start,'endTime',v_end)
    );
    v_count := v_count + 1;
  end loop;
  -- The UI sorts rows before saving; server also rejects overlaps independently.
  for v_item in select value from jsonb_array_elements(v_rows)
     order by (value->>'startTime')::time,(value->>'endTime')::time loop
    if v_previous_end is not null and (v_item->>'startTime')::time<v_previous_end then
      raise exception 'Periods overlap. Adjust the start/end times before saving.';
    end if;
    v_previous_end := (v_item->>'endTime')::time;
  end loop;

  if v_old<>'' then
    -- Keep every current assignment intact when a schedule is renamed.
    update public.room_settings rs set schedule_mode=v_name,updated_at=now()
    from public.rooms r where r.id=rs.room_id and r.school_id=p_school_id
      and lower(btrim(rs.schedule_mode))=lower(v_old);
    update public.room_settings rs set schedule_override_name=v_name,updated_at=now()
    from public.rooms r where r.id=rs.room_id and r.school_id=p_school_id
      and lower(btrim(coalesce(rs.schedule_override_name,'')))=lower(v_old);
    update public.school_calendar set schedule_name=v_name,updated_at=now()
    where school_id=p_school_id and lower(btrim(schedule_name))=lower(v_old);
    update public.room_schedule_assignments ra set schedule_name=v_name,updated_at=now()
    from public.rooms r where r.id=ra.room_id and r.school_id=p_school_id
      and lower(btrim(ra.schedule_name))=lower(v_old);
    delete from public.master_schedules where school_id=p_school_id
      and lower(btrim(schedule_name))=lower(v_old);
  end if;

  insert into public.master_schedules(school_id,schedule_name,period,start_time,end_time)
  select p_school_id,v_name,item->>'period',(item->>'startTime')::time,(item->>'endTime')::time
  from jsonb_array_elements(v_rows) item;

  -- Historical pass and completed waiting-request records intentionally keep their original labels.
  return jsonb_build_object('success',true,'periodCount',v_count,
    'message',case when v_old='' then 'Schedule created.'
                   when v_old<>v_name then 'Schedule renamed and saved; room/calendar assignments updated.'
                   else 'Entire schedule saved.' end);
end
$function$;

revoke all on function public.hp_manage_master_schedule(uuid,text,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.hp_manage_master_schedule(uuid,text,text,jsonb,boolean) to service_role;
