// Hall Pilot 1.15 DEVELOPMENT — public Edge Function (not deployed)
import { withSupabase } from 'npm:@supabase/server@^1'


function fail(message, extra = {}) {
  return { success: false, message, ...extra }
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase()
}

function cleanRoomKey(value) {
  return normalize(value)
}

function cleanSchoolKey(value) {
  return normalize(value)
}

function cleanOrgKey(value) {
  return normalize(value)
}

function boolYes(value) {
  return value === true || normalize(value) === 'yes'
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function parseClock(value) {
  const m = String(value ?? '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3] || 0) / 60
}

function formatClock(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0)) % 1440
  const h = Math.floor(total / 60)
  const m = total % 60
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short'
  }).formatToParts(date)
  const out = {}
  for (const p of parts) if (p.type !== 'literal') out[p.type] = p.value
  return out
}

function localDateKey(date, timeZone) {
  const p = zonedParts(date, timeZone)
  return `${p.year}-${p.month}-${p.day}`
}

function localMinutes(date, timeZone) {
  const p = zonedParts(date, timeZone)
  return Number(p.hour) * 60 + Number(p.minute) + Number(p.second) / 60
}

function isoAtMinutesToday(now, timeZone, targetMinutes) {
  const current = localMinutes(now, timeZone)
  return new Date(now.getTime() + (Number(targetMinutes) - current) * 60000).toISOString()
}

function publicDisplayName(value) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const parts = clean.split(' ')
  if (parts.length === 1) return parts[0]
  // Roster names may be "Last, First" or "First Last". Preserve the first-name cue
  // while limiting public disclosure to first name + last initial.
  if (clean.includes(',')) {
    const [last, rest] = clean.split(',', 2)
    const first = String(rest || '').trim().split(' ')[0] || ''
    return first ? `${first} ${String(last || '').trim().charAt(0).toUpperCase()}.` : `${String(last || '').trim().charAt(0).toUpperCase()}.`
  }
  const first = parts[0]
  const last = parts[parts.length - 1]
  return `${first} ${last.charAt(0).toUpperCase()}.`
}

async function getSchoolSettings(admin, schoolId) {
  // Public service only needs this school's emergency-lock bit.
  const { data, error } = await admin.from('school_settings').select('campus_emergency_lock,auto_scheduling_enabled,room_scheduling_enabled').eq('school_id', schoolId).maybeSingle()
  if (error) throw error
  return data || { campus_emergency_lock: false, auto_scheduling_enabled: true, room_scheduling_enabled: false }
}


/* Hall Pilot 1.15 room-default / exception-only scheduling.
 * Identical resolver in public and staff Edge Functions; do not change one alone.
 * Feature flag OFF leaves the existing school-calendar resolution unchanged.
 */
async function resolveRoomSchedule(admin, room, settings, system, legacyCalendar, today) {
  let effectiveSchedule = 'Regular'
  let source = 'School Default'
  let calendarNote = legacyCalendar?.note || ''
  let dayType = 'Regular'

  if (system.room_scheduling_enabled === true) {
    effectiveSchedule = String(settings.schedule_mode || 'Regular')
    source = 'Room Default'
    calendarNote = ''
    if (system.auto_scheduling_enabled !== false) {
      const { data: exception, error: exceptionError } = await admin
        .from('school_day_exceptions')
        .select('day_type,note')
        .eq('school_id', room.school_id)
        .eq('calendar_date', today)
        .eq('active', true)
        .maybeSingle()
      if (exceptionError) throw exceptionError
      if (exception?.day_type) {
        dayType = exception.day_type
        calendarNote = exception.note || ''
        const { data: maps, error: mapError } = await admin
          .from('room_schedule_assignments')
          .select('schedule_name')
          .eq('room_id', room.id)
          .ilike('day_type', exception.day_type)
          .limit(1)
        if (mapError) throw mapError
        if (maps?.[0]?.schedule_name) {
          effectiveSchedule = maps[0].schedule_name
          source = 'School Day Exception'
        } else {
          // Fail closed, not open on the wrong bell times.
          effectiveSchedule = '__UNASSIGNED_SPECIAL_DAY__'
          source = 'Missing Room Schedule'
        }
      }
    }
  } else if (system.auto_scheduling_enabled !== false && legacyCalendar?.schedule_name) {
    effectiveSchedule = legacyCalendar.schedule_name
    source = 'School Calendar'
  }
  if (settings.schedule_override_date === today && settings.schedule_override_name) {
    effectiveSchedule = settings.schedule_override_name
    source = 'Teacher Override'
  }
  return { effectiveSchedule, source, calendarNote, date: today, dayType }
}

async function getCalendarSchedule(admin, schoolId, dateKey) {
  const { data, error } = await admin
    .from('school_calendar')
    .select('calendar_date,schedule_name,note,active')
    .eq('school_id', schoolId)
    .eq('calendar_date', dateKey)
    .eq('active', true)
    .maybeSingle()
  if (error) throw error
  return data || null
}

async function getRoom(admin, orgKey, schoolKey, roomKey) {
  orgKey = cleanOrgKey(orgKey)
  schoolKey = cleanSchoolKey(schoolKey)
  roomKey = cleanRoomKey(roomKey)
  if (!roomKey) return null

  const { data, error } = await admin.rpc('hp_resolve_room_scope', {
    p_organization_key: orgKey || null,
    p_school_key: schoolKey || null,
    p_room_key: roomKey
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null

  return {
    id: row.room_id,
    room_key: row.room_key,
    room_name: row.room_name,
    timezone: row.room_timezone,
    emergency_lock: Boolean(row.room_emergency_lock),
    school_id: row.school_id,
    resolved_from_legacy_alias: Boolean(row.resolved_from_legacy_alias),
    school: {
      id: row.school_id,
      organization_id: row.organization_id,
      school_key: row.school_key,
      name: row.school_name,
      timezone: row.school_timezone,
      active: true
    },
    organization: {
      id: row.organization_id,
      organization_key: row.organization_key,
      name: row.organization_name,
      active: true
    }
  }
}

function roomScopePayload(room) {
  return {
    key: room.room_key,
    room: room.room_name,
    schoolKey: room.school?.school_key || '',
    school: room.school?.name || '',
    organizationKey: room.organization?.organization_key || '',
    organization: room.organization?.name || '',
    legacyAlias: Boolean(room.resolved_from_legacy_alias)
  }
}

async function getSettings(admin, roomId) {
  const { data, error } = await admin.from('room_settings').select('*').eq('room_id', roomId).maybeSingle()
  if (error) throw error
  return data || null
}

async function getDestinations(admin, roomId) {
  const { data, error } = await admin.from('destinations').select('*').eq('room_id', roomId).order('sort_order').order('name')
  if (error) throw error
  return (data || []).map(d => ({
    id: d.id,
    name: d.name,
    enabled: Boolean(d.enabled),
    maxOut: Number(d.max_out || 0),
    maxPerDay: Number(d.max_per_day || 0),
    teacherApproval: Boolean(d.teacher_approval),
    countsAsHallPass: Boolean(d.counts_as_hall_pass),
    sortOrder: Number(d.sort_order || 0)
  }))
}

async function getSchedules(admin, schoolId) {
  const { data, error } = await admin.from('master_schedules').select('*').eq('school_id', schoolId).order('schedule_name').order('start_time')
  if (error) throw error
  return (data || []).map(s => ({
    sheetRow: Number(s.id),
    schedule: s.schedule_name,
    period: String(s.period),
    startTime: String(s.start_time || '').slice(0, 5),
    endTime: String(s.end_time || '').slice(0, 5),
    _startMinutes: parseClock(s.start_time),
    _endMinutes: parseClock(s.end_time)
  }))
}

async function lookupStudentForRoom(admin, schoolId, studentNumber) {
  // Student IDs are school-wide, not organization-wide.
  const { data, error } = await admin
    .from('students')
    .select('id,student_number,name,active')
    .eq('school_id', schoolId)
    .eq('student_number', String(studentNumber || '').trim())
    .eq('active', true)
    .maybeSingle()
  if (error) throw error
  return data || null
}

function publicSettings(room, settings, scheduleMeta = {}) {
  return {
    "Today's Schedule": scheduleMeta.effectiveSchedule || settings.schedule_mode,
    "Schedule Source": scheduleMeta.source || 'Room Default',
    'Passes Open After Start (Minutes)': settings.passes_open_after_start,
    'Passes Close Before End (Minutes)': settings.passes_close_before_end,
    'Long Pass Warning': settings.long_pass_warning,
    'Very Long Pass Warning': settings.very_long_pass_warning,
    'Buzzer Enabled': settings.buzzer_enabled ? 'Yes' : 'No',
    'Waiting List Enabled': settings.waiting_list_enabled ? 'Yes' : 'No',
    'Clear Queue at Period End': settings.clear_queue_at_period_end ? 'Yes' : 'No',
    'Test Mode': settings.test_mode ? 'Yes' : 'No',
    'Emergency Lock': room.emergency_lock ? 'Yes' : 'No',
    'Restroom Limit Period': settings.restroom_limit_period,
    'Restroom Pass Limit': settings.restroom_pass_limit
  }
}

function computeScheduleState(room, settings, schedules, scheduleMeta = {}, campusLocked = false) {
  const now = new Date()
  const tz = room.timezone || 'America/Los_Angeles'
  const nowMinutes = localMinutes(now, tz)
  const scheduleName = scheduleMeta.effectiveSchedule || settings.schedule_mode || 'Regular'
  const testMode = Boolean(settings.test_mode)
  const rows = schedules
    .filter(r => r.schedule === scheduleName)
    .filter(r => Number.isFinite(r._startMinutes) && Number.isFinite(r._endMinutes))
    .sort((a, b) => a._startMinutes - b._startMinutes)

  if (testMode) {
    return {
      schedule: scheduleName,
      period: rows.find(r => nowMinutes >= r._startMinutes && nowMinutes < r._endMinutes)?.period || null,
      isOpen: !(room.emergency_lock || campusLocked),
      status: (room.emergency_lock || campusLocked) ? 'CLOSED' : 'OPEN',
      reason: campusLocked ? 'Campus Emergency Lock' : (room.emergency_lock ? 'Teacher Emergency Lock' : 'Test Mode'),
      nextChange: null,
      start: null,
      end: null,
      openTime: null,
      closeTime: null,
      testMode: true,
      isTestSchedule: scheduleName === 'Test',
      emergencyLock: Boolean(room.emergency_lock || campusLocked),
      campusEmergencyLock: Boolean(campusLocked)
    }
  }

  const active = rows.find(r => nowMinutes >= r._startMinutes && nowMinutes < r._endMinutes)
  if (!active) {
    const next = rows.find(r => r._startMinutes > nowMinutes)
    return {
      schedule: scheduleName,
      period: null,
      isOpen: false,
      status: 'CLOSED',
      reason: campusLocked ? 'Campus Emergency Lock' : (room.emergency_lock ? 'Teacher Emergency Lock' : 'Between classes'),
      nextChange: (room.emergency_lock || campusLocked) || !next ? null : isoAtMinutesToday(now, tz, next._startMinutes),
      start: null,
      end: null,
      openTime: null,
      closeTime: null,
      testMode: false,
      isTestSchedule: scheduleName === 'Test',
      emergencyLock: Boolean(room.emergency_lock || campusLocked),
      campusEmergencyLock: Boolean(campusLocked)
    }
  }

  const openMinutes = active._startMinutes + Number(settings.passes_open_after_start || 0)
  const closeMinutes = active._endMinutes - Number(settings.passes_close_before_end || 0)
  let isOpen = nowMinutes >= openMinutes && nowMinutes < closeMinutes
  let reason = 'Passes open'
  let nextChange = isoAtMinutesToday(now, tz, closeMinutes)
  if (nowMinutes < openMinutes) {
    isOpen = false
    reason = 'Beginning of class'
    nextChange = isoAtMinutesToday(now, tz, openMinutes)
  } else if (nowMinutes >= closeMinutes) {
    isOpen = false
    reason = 'End of class'
    nextChange = isoAtMinutesToday(now, tz, active._endMinutes)
  }
  if (room.emergency_lock || campusLocked) {
    isOpen = false
    reason = campusLocked ? 'Campus Emergency Lock' : 'Teacher Emergency Lock'
    nextChange = null
  }

  return {
    schedule: scheduleName,
    period: active.period,
    isOpen,
    status: isOpen ? 'OPEN' : 'CLOSED',
    reason,
    nextChange,
    start: isoAtMinutesToday(now, tz, active._startMinutes),
    end: isoAtMinutesToday(now, tz, active._endMinutes),
    openTime: isoAtMinutesToday(now, tz, openMinutes),
    closeTime: isoAtMinutesToday(now, tz, closeMinutes),
    testMode: false,
    isTestSchedule: scheduleName === 'Test',
    emergencyLock: Boolean(room.emergency_lock || campusLocked),
    campusEmergencyLock: Boolean(campusLocked),
    scheduleSource: scheduleMeta.source || 'Room Default'
  }
}

async function expireWaiting(admin, room, settings, state) {
  if (!settings.clear_queue_at_period_end || state.testMode) return
  const { data, error } = await admin.from('waiting_requests').select('id,schedule_name,period').eq('room_id', room.id).eq('status', 'WAITING')
  if (error) throw error
  const expireIds = (data || []).filter(row => !(state.period !== null && String(row.schedule_name) === String(state.schedule) && String(row.period ?? '') === String(state.period ?? ''))).map(row => row.id)
  if (!expireIds.length) return
  const { error: updateError } = await admin.from('waiting_requests').update({ status: 'EXPIRED', cancelled_by: 'System', cancelled_at: new Date().toISOString() }).in('id', expireIds)
  if (updateError) throw updateError
}

async function getWaiting(admin, roomId) {
  const { data, error } = await admin
    .from('waiting_requests')
    .select('id,requested_at,queue_order,students!inner(student_number,name),destinations!inner(name,teacher_approval)')
    .eq('room_id', roomId)
    .eq('status', 'WAITING')
    .order('queue_order')
  if (error) throw error
  return (data || []).map(row => ({
    requestId: row.id,
    studentId: String(row.students.student_number),
    name: row.students.name,
    destination: row.destinations.name,
    requested: row.requested_at,
    queueOrder: Number(row.queue_order || 0),
    teacherApproval: Boolean(row.destinations.teacher_approval)
  }))
}

async function getOut(admin, roomId) {
  const { data, error } = await admin
    .from('passes')
    .select('id,leave_at,destination_name,students!inner(student_number,name)')
    .eq('room_id', roomId)
    .is('return_at', null)
    .order('leave_at')
  if (error) throw error
  return (data || []).map(row => ({
    passId: row.id,
    studentId: String(row.students.student_number),
    name: row.students.name,
    destination: row.destination_name,
    leaveTime: row.leave_at
  }))
}

async function loadContext(admin, orgKey, schoolKey, roomKey) {
  const room = await getRoom(admin, orgKey, schoolKey, roomKey)
  if (!room) return null
  const [settings, destinations, schedules, system] = await Promise.all([
    getSettings(admin, room.id), getDestinations(admin, room.id), getSchedules(admin, room.school_id), getSchoolSettings(admin, room.school_id)
  ])
  if (!settings) throw new Error('Room settings are missing.')
  const today = localDateKey(new Date(), room.timezone || room.school?.timezone || 'America/Los_Angeles')
  const calendar = system.room_scheduling_enabled === true ? null : await getCalendarSchedule(admin, room.school_id, today)
  const scheduleMeta = await resolveRoomSchedule(admin, room, settings, system, calendar, today)
  const schedule = computeScheduleState(room, settings, schedules, scheduleMeta, Boolean(system.campus_emergency_lock))
  await expireWaiting(admin, room, settings, schedule)
  const [waiting, out] = await Promise.all([
    getWaiting(admin, room.id), getOut(admin, room.id)
  ])
  return { room, settings, destinations, schedules, schedule, scheduleMeta, system, waiting, out }
}

async function pageState(admin, orgKey, schoolKey, roomKey) {
  const ctx = await loadContext(admin, orgKey, schoolKey, roomKey)
  if (!ctx) return fail('This hall-pass link is not assigned to an active room.')
  return {
    success: true,
    room: roomScopePayload(ctx.room),
    settings: publicSettings(ctx.room, ctx.settings, ctx.scheduleMeta),
    schedule: ctx.schedule,
    destinations: ctx.destinations,
    waiting: ctx.waiting.map(x => ({ ...x, name: publicDisplayName(x.name), studentId: undefined })),
    out: ctx.out.map(x => ({ ...x, name: publicDisplayName(x.name), studentId: undefined }))
  }
}

async function handlePublicAction(admin, body) {
  const action = String(body.action || '')
  const args = Array.isArray(body.args) ? body.args : []
  const orgKey = cleanOrgKey(body.orgKey)
  const schoolKey = cleanSchoolKey(body.schoolKey)
  const roomKey = cleanRoomKey(body.roomKey)

  if (action === 'getRoomDisplayMetadata') {
    const room = await getRoom(admin, orgKey, schoolKey, roomKey)
    if (!room) return fail('Room not found.')
    // Only publicly display assigned staff surnames, never PINs or email addresses.
    const { data, error } = await admin
      .from('teacher_rooms')
      .select('teachers(name,active)')
      .eq('room_id', room.id)
    if (error) throw error
    const surnames = [...new Set((data || []).map(link => {
      const record = Array.isArray(link.teachers) ? link.teachers[0] : link.teachers
      if (!record || record.active === false) return ''
      const fullName = String(record.name || '').trim()
      if (!fullName) return ''
      // Support both "First Last" and "Last, First" staff-name formats.
      return fullName.includes(',') ? fullName.split(',')[0].trim() : fullName.split(/\s+/).pop()
    }).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    return { success: true, room: { ...roomScopePayload(room), teacherNames: surnames.join(' / ') } }
  }

  if (action === 'getPageState' || action === 'getLiveState') {
    return pageState(admin, orgKey, schoolKey, roomKey)
  }

  if (action === 'lookupStudent') {
    const room = await getRoom(admin, orgKey, schoolKey, roomKey)
    if (!room) return fail('Room not found.')
    const student = await lookupStudentForRoom(admin, room.school_id, args[0])
    return student
      ? { success: true, student: { id: String(student.student_number), name: student.name } }
      : fail('Student ID not found.')
  }

  if (action === 'requestPass') {
    const ctx = await loadContext(admin, orgKey, schoolKey, roomKey)
    if (!ctx) return fail('Room not found.')
    if (ctx.system?.campus_emergency_lock) return fail('Hall passes are temporarily closed campus-wide.')
    if (!ctx.schedule.period && !ctx.schedule.testMode) return fail('Hall passes are not available right now.')
    const { data, error } = await admin.rpc('hp_request_pass_v2', {
      p_room_id: ctx.room.id,
      p_student_number: String(args[0] || '').trim(),
      p_destination_name: String(args[1] || '').trim(),
      p_schedule_name: ctx.schedule.schedule,
      p_period: ctx.schedule.period,
      p_window_open: Boolean(ctx.schedule.isOpen),
      p_end_of_class: ctx.schedule.reason === 'End of class',
      p_test_data: Boolean(ctx.schedule.testMode || ctx.schedule.isTestSchedule)
    })
    if (error) throw error
    return data
  }

  // Anonymous START is intentionally limited to the non-teacher path.
  // Teacher approval/overrides are routed to hallpass-staff by api-shim.js.
  if (action === 'startPass') {
    if (String(args[1] || '').trim()) {
      return fail('Teacher-authorized pass starts must use the staff service.')
    }
    const ctx = await loadContext(admin, orgKey, schoolKey, roomKey)
    if (!ctx) return fail('Room not found.')
    if (ctx.system?.campus_emergency_lock) return fail('Campus Emergency Lock is active. New passes cannot be started.')
    const { data, error } = await admin.rpc('hp_start_pass_v2', {
      p_room_id: ctx.room.id,
      p_request_id: String(args[0] || ''),
      p_teacher_authorized: false,
      p_allow_time_override: false,
      p_allow_limit_override: false,
      p_schedule_name: ctx.schedule.schedule,
      p_period: ctx.schedule.period,
      p_window_open: Boolean(ctx.schedule.isOpen),
      p_has_active_period: Boolean(ctx.schedule.period || ctx.schedule.testMode),
      p_test_data: Boolean(ctx.schedule.testMode || ctx.schedule.isTestSchedule),
      p_teacher_id: null
    })
    if (error) throw error
    return data
  }

  if (action === 'cancelStudentRequest') {
    const room = await getRoom(admin, orgKey, schoolKey, roomKey)
    if (!room) return fail('Room not found.')
    const { data, error } = await admin.rpc('hp_cancel_student_request_v2', {
      p_room_id: room.id,
      p_request_id: String(args[0] || ''),
      p_student_number: String(args[1] || '').trim()
    })
    if (error) throw error
    return data
  }

  if (action === 'returnStudent') {
    const room = await getRoom(admin, orgKey, schoolKey, roomKey)
    if (!room) return fail('Room not found.')
    const { data, error } = await admin.rpc('hp_return_pass_v2', {
      p_room_id: room.id,
      p_pass_id: String(args[0] || '')
    })
    if (error) throw error
    return data
  }

  return fail(`Action is not available on the public Hall Pass service: ${action}`)
}

export default {
  fetch: withSupabase({ auth: 'none' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return Response.json({ success: false, message: 'POST required.' }, { status: 405 })
    }
    try {
      const body = await req.json()
      const result = await handlePublicAction(ctx.supabaseAdmin, body)
      return Response.json(result)
    } catch (error) {
      console.error(error)
      return Response.json({ success: false, message: error?.message || 'Server error.' }, { status: 500 })
    }
  })
}
