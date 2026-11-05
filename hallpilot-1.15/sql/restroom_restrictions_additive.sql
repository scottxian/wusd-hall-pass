-- Hall Pilot DEV 1.15: classroom restroom exceptions. Back up and dry-run before applying to production.
-- Only changes exception data; no student/pass history is replaced.
create table if not exists public.student_restroom_restrictions (
 room_id uuid not null references public.rooms(id) on delete cascade,
 student_id uuid not null references public.students(id) on delete cascade,
 restriction_type text not null check (restriction_type in ('Period','Day','Week','Month','Blocked')),
 pass_limit integer,
 updated_by uuid references public.teachers(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key (room_id,student_id),
 constraint hp_student_restriction_valid check (
    (restriction_type='Blocked' and pass_limit is null)
    or (restriction_type in ('Period','Day','Week','Month') and pass_limit between 1 and 100)
 )
);
create index if not exists hp_restroom_restriction_student on public.student_restroom_restrictions(student_id,room_id);
create index if not exists hp_restroom_restriction_updated_by on public.student_restroom_restrictions(updated_by) where updated_by is not null;
alter table public.student_restroom_restrictions enable row level security;
revoke all on public.student_restroom_restrictions from public,anon,authenticated;
grant select,insert,update,delete on public.student_restroom_restrictions to service_role;
-- Convert existing room-only blocks. Default roster membership is deliberately NOT copied.
insert into public.student_restroom_restrictions(room_id,student_id,restriction_type,pass_limit)
 select room_id,student_id,'Blocked',null from public.room_students
 where restroom_allowed=false and active is distinct from false
 on conflict(room_id,student_id) do nothing;
create schema if not exists hallpilot_private;
revoke all on schema hallpilot_private from public,anon,authenticated;
grant usage on schema hallpilot_private to service_role;

CREATE OR REPLACE FUNCTION hallpilot_private.restroom_status(p_room_id uuid, p_student_id uuid, p_period text, p_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
 v_room public.rooms%rowtype;
 v_settings public.room_settings%rowtype;
 v_student public.students%rowtype;
 v_restr public.student_restroom_restrictions%rowtype;
 v_legacy boolean;
 v_mode text;
 v_limit integer;
 v_used integer := 0;
 v_block_source text := '';
begin
 select * into v_room from public.rooms where id=p_room_id;
 select * into v_student from public.students where id=p_student_id;
 if v_room.id is null or v_student.id is null or v_student.school_id is distinct from v_room.school_id
   then return jsonb_build_object('blocked',true,'source','Invalid scope','reached',true); end if;
 select * into v_settings from public.room_settings where room_id=p_room_id;
 if not coalesce(v_student.restroom_allowed,true) then
   return jsonb_build_object('blocked',true,'source','Schoolwide','reached',true);
 end if;
 select * into v_restr from public.student_restroom_restrictions
  where room_id=p_room_id and student_id=p_student_id;
 if v_restr.restriction_type='Blocked' then
   return jsonb_build_object('blocked',true,'source','Room','reached',true);
 end if;
 select rs.restroom_allowed into v_legacy from public.room_students rs
  where rs.room_id=p_room_id and rs.student_id=p_student_id and rs.active is distinct from false;
 if v_legacy=false then
   return jsonb_build_object('blocked',true,'source','Room','reached',true);
 end if;
 v_mode := coalesce(v_restr.restriction_type,v_settings.restroom_limit_period,'Day');
 v_limit := coalesce(v_restr.pass_limit,v_settings.restroom_pass_limit,0);
 if v_limit<=0 then
   return jsonb_build_object('blocked',false,'reached',false,'mode',v_mode,'limit',0,'used',0);
 end if;
 select count(*) into v_used from public.passes p
 where p.room_id=p_room_id and p.student_id=p_student_id and lower(p.destination_name)='restroom'
   and not p.test_data and (
      (v_mode='Period' and p.period is not distinct from nullif(p_period,'')
         and (p.leave_at at time zone v_room.timezone)::date=(p_at at time zone v_room.timezone)::date)
      or (v_mode='Day' and (p.leave_at at time zone v_room.timezone)::date=(p_at at time zone v_room.timezone)::date)
      or (v_mode='Week' and date_trunc('week',p.leave_at at time zone v_room.timezone)=date_trunc('week',p_at at time zone v_room.timezone))
      or (v_mode='Month' and date_trunc('month',p.leave_at at time zone v_room.timezone)=date_trunc('month',p_at at time zone v_room.timezone))
   );
 return jsonb_build_object('blocked',false,'reached',v_used>=v_limit,
   'source',case when v_restr.room_id is null then 'Room Default' else 'Room Restriction' end,
   'mode',v_mode,'limit',v_limit,'used',v_used);
end
$function$
;

CREATE OR REPLACE FUNCTION public.hp_request_pass_v2(p_room_id uuid, p_student_number text, p_destination_name text, p_schedule_name text, p_period text, p_window_open boolean, p_end_of_class boolean, p_test_data boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_room public.rooms%rowtype;
  v_settings public.room_settings%rowtype;
  v_student public.students%rowtype;
  v_dest public.destinations%rowtype;
  v_now timestamptz := now();
  v_count integer := 0;
  v_pass_id uuid;
  v_request_id uuid;
  v_reason text;
  v_room_restroom_allowed boolean := true;
  v_policy jsonb;
begin
  select * into v_room from public.rooms where id=p_room_id and active;
  if not found then return jsonb_build_object('success',false,'message','This hall-pass link is not assigned to an active room.'); end if;

  select * into v_settings from public.room_settings where room_id=v_room.id;
  if not found then return jsonb_build_object('success',false,'message','Room settings are missing.'); end if;

  if v_room.emergency_lock then
    return jsonb_build_object('success',false,'message','Hall passes are temporarily closed by the teacher.');
  end if;

  select * into v_student from public.students where school_id=v_room.school_id and student_number=trim(p_student_number) and active;
  if not found then return jsonb_build_object('success',false,'message','Student not found.'); end if;

  perform pg_advisory_xact_lock(hashtextextended(v_student.id::text, 11));
  perform pg_advisory_xact_lock(hashtextextended(v_room.id::text, 12));

  if exists(select 1 from public.waiting_requests where student_id=v_student.id and status='WAITING') then
    return jsonb_build_object('success',false,'message','You are already on the waiting list.');
  end if;
  if exists(select 1 from public.passes where student_id=v_student.id and return_at is null) then
    return jsonb_build_object('success',false,'message','You already have an active pass.');
  end if;

  select * into v_dest from public.destinations
   where room_id=v_room.id and lower(name)=lower(trim(p_destination_name)) and enabled;
  if not found then return jsonb_build_object('success',false,'message','That destination is not available.'); end if;

  if lower(v_dest.name)='restroom' then
    v_policy := hallpilot_private.restroom_status(v_room.id,v_student.id,p_period,v_now);
    if coalesce((v_policy->>'blocked')::boolean,false) then
      return jsonb_build_object('success',false,'message','Restroom passes are restricted for this student. Please ask your teacher.');
    end if;
    if coalesce((v_policy->>'reached')::boolean,false) then
      return jsonb_build_object('success',false,'message','Restroom pass limit reached: '||
        (v_policy->>'limit')||' per '||lower(v_policy->>'mode')||'.');
    end if;
  elsif lower(v_dest.name) <> 'restroom' and v_dest.max_per_day > 0 then
    select count(*) into v_count from public.passes p
     where p.student_id=v_student.id and p.destination_id=v_dest.id and not p.test_data
       and (p.leave_at at time zone v_room.timezone)::date = (v_now at time zone v_room.timezone)::date;
    if v_count >= v_dest.max_per_day then
      return jsonb_build_object('success',false,'message','Daily limit reached for '||v_dest.name||'.');
    end if;
  end if;

  select count(*) into v_count from public.passes p
   where p.room_id=v_room.id and p.destination_id=v_dest.id and p.return_at is null;

  if (not v_dest.counts_as_hall_pass or p_window_open)
     and (v_dest.max_out <= 0 or v_count < v_dest.max_out)
     and not v_dest.teacher_approval then
    insert into public.passes(room_id,student_id,destination_id,destination_name,requested_at,leave_at,
      schedule_name,period,wait_seconds,status_note,test_data,counts_as_hall_pass)
    values(v_room.id,v_student.id,v_dest.id,v_dest.name,v_now,v_now,p_schedule_name,p_period,0,
      case when p_test_data then 'TEST DATA' else 'Normal' end,p_test_data,v_dest.counts_as_hall_pass)
    returning id into v_pass_id;
    return jsonb_build_object('success',true,'action','STARTED','passId',v_pass_id::text,
      'leaveTime',v_now,'student',jsonb_build_object('id',v_student.student_number,'name',v_student.name),
      'destination',v_dest.name,'message','Pass started. You may go.');
  end if;

  if v_dest.counts_as_hall_pass and p_end_of_class and not p_test_data then
    return jsonb_build_object('success',false,'message','The hall pass window is closed for the rest of this period.');
  end if;

  if not v_settings.waiting_list_enabled then
    if v_dest.counts_as_hall_pass and not p_window_open then v_reason := 'Passes are currently closed.';
    elsif v_dest.max_out > 0 and v_count >= v_dest.max_out then v_reason := v_dest.name||' is currently full.';
    elsif v_dest.teacher_approval then v_reason := 'Teacher approval is required.';
    else v_reason := 'Pass cannot be started right now.'; end if;
    return jsonb_build_object('success',false,'message',v_reason);
  end if;

  insert into public.waiting_requests(room_id,student_id,destination_id,requested_at,schedule_name,period,status,test_data)
  values(v_room.id,v_student.id,v_dest.id,v_now,p_schedule_name,p_period,'WAITING',p_test_data)
  returning id into v_request_id;

  if v_dest.teacher_approval then v_reason := 'Teacher approval is required. Added to waiting list.';
  elsif p_window_open and v_dest.max_out > 0 and v_count >= v_dest.max_out then v_reason := v_dest.name||' is currently in use. Added to waiting list.';
  else v_reason := 'Added to waiting list.'; end if;

  return jsonb_build_object('success',true,'action','WAITING','waitingEntry',jsonb_build_object(
    'requestId',v_request_id::text,'studentId',v_student.student_number,'name',v_student.name,
    'destination',v_dest.name,'requested',v_now,'teacherApproval',v_dest.teacher_approval),'message',v_reason);
exception when unique_violation then
  return jsonb_build_object('success',false,'message','You already have an active pass or waiting request.');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.hp_start_pass_v2(p_room_id uuid, p_request_id uuid, p_teacher_authorized boolean, p_allow_time_override boolean, p_allow_limit_override boolean, p_schedule_name text, p_period text, p_window_open boolean, p_has_active_period boolean, p_test_data boolean, p_teacher_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_room public.rooms%rowtype;
  v_settings public.room_settings%rowtype;
  v_req public.waiting_requests%rowtype;
  v_student public.students%rowtype;
  v_dest public.destinations%rowtype;
  v_count integer := 0;
  v_position integer := 0;
  v_limit_reached boolean := false;
  v_time_override boolean := false;
  v_limit_override boolean := false;
  v_now timestamptz := now();
  v_pass_id uuid;
  v_note text := '';
  v_room_restroom_allowed boolean := true;
  v_policy jsonb;
begin
  select * into v_room from public.rooms where id=p_room_id and active;
  if not found then return jsonb_build_object('success',false,'message','Room not found.'); end if;
  select * into v_settings from public.room_settings where room_id=v_room.id;
  if v_room.emergency_lock then return jsonb_build_object('success',false,'message','Hall passes are temporarily closed by the teacher.'); end if;

  perform pg_advisory_xact_lock(hashtextextended(v_room.id::text, 12));
  select * into v_req from public.waiting_requests where id=p_request_id and room_id=v_room.id for update;
  if not found then return jsonb_build_object('success',false,'message','Waiting-list request not found.'); end if;
  if v_req.status <> 'WAITING' then return jsonb_build_object('success',false,'message','This request is no longer active.'); end if;

  select * into v_student from public.students where id=v_req.student_id;
  perform pg_advisory_xact_lock(hashtextextended(v_student.id::text, 11));
  select * into v_dest from public.destinations where id=v_req.destination_id and room_id=v_room.id and enabled;
  if not found then return jsonb_build_object('success',false,'message','That destination is not available.'); end if;

  if not p_teacher_authorized then
    select count(*) into v_position from public.waiting_requests w
      where w.room_id=v_room.id and w.destination_id=v_dest.id and w.status='WAITING'
        and (w.queue_order < v_req.queue_order or (w.queue_order=v_req.queue_order and w.requested_at < v_req.requested_at));
    if v_position > 0 then
      return jsonb_build_object('success',false,'message','It is not your turn yet. You are #'||(v_position+1)||' in line for '||v_dest.name||'.');
    end if;
  end if;

  if v_dest.counts_as_hall_pass and not p_window_open then
    if not p_allow_time_override then return jsonb_build_object('success',false,'message','Passes are currently closed.'); end if;
    if not p_teacher_authorized then return jsonb_build_object('success',false,'message','Teacher PIN required for a time override.'); end if;
    if not p_has_active_period and not p_test_data then return jsonb_build_object('success',false,'message','There is no active class period to override.'); end if;
    v_time_override := true;
  end if;

  if v_dest.teacher_approval and not p_teacher_authorized then
    return jsonb_build_object('success',false,'needsTeacherPin',true,'message','Teacher approval required.');
  end if;
  if exists(select 1 from public.passes where student_id=v_student.id and return_at is null) then
    return jsonb_build_object('success',false,'message','This student already has an active pass.');
  end if;
  if lower(v_dest.name)='restroom' then
    v_policy := hallpilot_private.restroom_status(v_room.id,v_student.id,p_period,v_now);
    if coalesce((v_policy->>'blocked')::boolean,false) then
      return jsonb_build_object('success',false,'message','Restroom access restricted. Use Teacher Override Pass for an authorized exception.');
    end if;
    v_limit_reached := coalesce((v_policy->>'reached')::boolean,false);
  elsif lower(v_dest.name)<>'restroom' and v_dest.max_per_day>0 then
    select count(*) into v_count from public.passes p where p.student_id=v_student.id and p.destination_id=v_dest.id and not p.test_data
      and (p.leave_at at time zone v_room.timezone)::date=(v_now at time zone v_room.timezone)::date;
    v_limit_reached := v_count >= v_dest.max_per_day;
  end if;

  if v_limit_reached then
    if not (p_allow_limit_override and p_teacher_authorized) then
      if p_teacher_authorized then return jsonb_build_object('success',false,'needsLimitOverride',true,'message',
        case when lower(v_dest.name)='restroom' then 'Restroom pass limit reached.' else 'Daily limit reached for '||v_dest.name||'.' end);
      end if;
      return jsonb_build_object('success',false,'message',case when lower(v_dest.name)='restroom' then 'Restroom pass limit reached.' else 'Daily limit reached for '||v_dest.name||'.' end);
    end if;
    v_limit_override := true;
  end if;

  select count(*) into v_count from public.passes p where p.room_id=v_room.id and p.destination_id=v_dest.id and p.return_at is null;
  if v_dest.max_out>0 and v_count>=v_dest.max_out then return jsonb_build_object('success',false,'message',v_dest.name||' is currently at capacity.'); end if;

  if v_time_override then v_note := 'TIME'; end if;
  if v_limit_override then v_note := case when v_note='' then 'PASS LIMIT' else v_note||' + PASS LIMIT' end; end if;
  if v_note<>'' then v_note := 'TEACHER '||v_note||' OVERRIDE'; else v_note := case when p_test_data then 'TEST DATA' else 'Normal' end; end if;

  insert into public.passes(room_id,student_id,destination_id,destination_name,requested_at,leave_at,schedule_name,period,
    wait_seconds,status_note,test_data,counts_as_hall_pass,teacher_override,created_by_teacher_id)
  values(v_room.id,v_student.id,v_dest.id,v_dest.name,v_req.requested_at,v_now,p_schedule_name,p_period,
    greatest(0,extract(epoch from (v_now-v_req.requested_at))::integer),v_note,p_test_data,v_dest.counts_as_hall_pass,
    (v_time_override or v_limit_override or v_dest.teacher_approval),p_teacher_id)
  returning id into v_pass_id;

  update public.waiting_requests set status='LEFT',leave_at=v_now,pass_id=v_pass_id where id=v_req.id;
  return jsonb_build_object('success',true,'passId',v_pass_id::text,'leaveTime',v_now,
    'student',jsonb_build_object('id',v_student.student_number,'name',v_student.name),'destination',v_dest.name,
    'timeOverride',v_time_override,'limitOverride',v_limit_override,
    'message',case when v_time_override or v_limit_override then 'Teacher override pass started.' else 'Pass started. You may go.' end);
exception when unique_violation then
  return jsonb_build_object('success',false,'message','This student already has an active pass.');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.hp_teacher_override_v2(p_room_id uuid, p_student_number text, p_destination_name text, p_override_limit boolean, p_override_note text, p_schedule_name text, p_period text, p_window_open boolean, p_has_active_period boolean, p_test_data boolean, p_teacher_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_room public.rooms%rowtype; v_settings public.room_settings%rowtype; v_student public.students%rowtype; v_dest public.destinations%rowtype;
  v_req public.waiting_requests%rowtype; v_count integer:=0; v_limit boolean:=false; v_now timestamptz:=now(); v_pass_id uuid;
  v_time_override boolean:=false; v_restroom_override boolean:=false; v_limit_override boolean:=false; v_note text:='TEACHER OVERRIDE'; v_room_restroom_allowed boolean:=true; v_policy jsonb;
begin
  select * into v_room from public.rooms where id=p_room_id and active;
  if not found then return jsonb_build_object('success',false,'message','Room not found.'); end if;
  select * into v_settings from public.room_settings where room_id=v_room.id;
  if v_room.emergency_lock then return jsonb_build_object('success',false,'message','Emergency Lock is active. Turn it off before starting a new pass.'); end if;
  if not p_has_active_period and not p_test_data then return jsonb_build_object('success',false,'message','There is no active class period to override.'); end if;
  select * into v_student from public.students where school_id=v_room.school_id and student_number=trim(p_student_number) and active;
  if not found then return jsonb_build_object('success',false,'message','Student not found.'); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_student.id::text,11)); perform pg_advisory_xact_lock(hashtextextended(v_room.id::text,12));
  if exists(select 1 from public.passes where student_id=v_student.id and return_at is null) then return jsonb_build_object('success',false,'message','This student already has an active pass.'); end if;
  select * into v_dest from public.destinations where room_id=v_room.id and lower(name)=lower(trim(p_destination_name)) and enabled;
  if not found then return jsonb_build_object('success',false,'message','That destination is not available.'); end if;

  if lower(v_dest.name)='restroom' then
    v_policy := hallpilot_private.restroom_status(v_room.id,v_student.id,p_period,v_now);
    if v_policy->>'source'='Schoolwide' then
      return jsonb_build_object('success',false,'message','Schoolwide restroom restrictions require an administrator.');
    end if;
    v_limit := coalesce((v_policy->>'reached')::boolean,false) and not coalesce((v_policy->>'blocked')::boolean,false);
  elsif lower(v_dest.name)<>'restroom' and v_dest.max_per_day>0 then
    select count(*) into v_count from public.passes p where p.student_id=v_student.id and p.destination_id=v_dest.id and not p.test_data
      and (p.leave_at at time zone v_room.timezone)::date=(v_now at time zone v_room.timezone)::date;
    v_limit := v_count>=v_dest.max_per_day;
  end if;
  if v_limit and not p_override_limit then return jsonb_build_object('success',false,'message',case when lower(v_dest.name)='restroom' then 'Restroom pass limit reached.' else 'Daily limit reached for '||v_dest.name||'.' end); end if;
  v_limit_override := v_limit and p_override_limit;
  v_restroom_override := lower(v_dest.name)='restroom'
    and coalesce((v_policy->>'blocked')::boolean,false);
  v_time_override := v_dest.counts_as_hall_pass and not p_window_open;

  select count(*) into v_count from public.passes p where p.room_id=v_room.id and p.destination_id=v_dest.id and p.return_at is null;
  if v_dest.max_out>0 and v_count>=v_dest.max_out then return jsonb_build_object('success',false,'message',v_dest.name||' is currently at capacity.'); end if;

  select * into v_req from public.waiting_requests where student_id=v_student.id and room_id=v_room.id and status='WAITING' order by requested_at limit 1 for update;
  if found then null; else v_req.requested_at:=v_now; end if;

  v_note := 'TEACHER ' || trim(both ' + ' from concat_ws(' + ',
    case when v_time_override then 'TIME' end,
    case when v_limit_override then 'PASS LIMIT' end,
    case when v_restroom_override then 'RESTROOM ACCESS' end)) || ' OVERRIDE';
  if v_note='TEACHER  OVERRIDE' then v_note:='TEACHER OVERRIDE'; end if;
  if trim(coalesce(p_override_note,''))<>'' then v_note:=v_note||' - '||left(regexp_replace(trim(p_override_note),'\s+',' ','g'),250); end if;

  insert into public.passes(room_id,student_id,destination_id,destination_name,requested_at,leave_at,schedule_name,period,wait_seconds,
    status_note,test_data,counts_as_hall_pass,teacher_override,override_note,created_by_teacher_id)
  values(v_room.id,v_student.id,v_dest.id,v_dest.name,coalesce(v_req.requested_at,v_now),v_now,p_schedule_name,p_period,
    greatest(0,extract(epoch from(v_now-coalesce(v_req.requested_at,v_now)))::integer),v_note,p_test_data,v_dest.counts_as_hall_pass,true,left(p_override_note,250),p_teacher_id)
  returning id into v_pass_id;
  if v_req.id is not null then update public.waiting_requests set status='LEFT',leave_at=v_now,pass_id=v_pass_id where id=v_req.id; end if;
  return jsonb_build_object('success',true,'passId',v_pass_id::text,'leaveTime',v_now,'student',jsonb_build_object('id',v_student.student_number,'name',v_student.name),
    'destination',v_dest.name,'message','Teacher override started for '||v_student.name||'.');
exception when unique_violation then return jsonb_build_object('success',false,'message','This student already has an active pass.');
end;
$function$
;

revoke all on function hallpilot_private.restroom_status(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function hallpilot_private.restroom_status(uuid,uuid,text,timestamptz) to service_role;
-- End of additive migration. Existing historical passes remain unchanged.
