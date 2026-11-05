// Hall Pilot 1.15 DEVELOPMENT — staff Edge Function (not deployed)
import { withSupabase } from 'npm:@supabase/server@^1'

const TEACHER_SESSION_HOURS = 8
const ADMIN_SESSION_HOURS = 2

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

async function sha256(text) {
  const data = new TextEncoder().encode(String(text))
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function randomToken() {
  return crypto.randomUUID() + crypto.randomUUID().replaceAll('-', '')
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

function requestFingerprintSource(req) {
  const forwarded = String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
  const ip = String(req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || forwarded || '').trim()
  const ua = String(req.headers.get('user-agent') || '').slice(0, 300)
  const lang = String(req.headers.get('accept-language') || '').slice(0, 120)
  return ip ? `ip:${ip}|ua:${ua}` : `ua:${ua}|lang:${lang}`
}

async function requestFingerprint(req) {
  return sha256(requestFingerprintSource(req))
}


async function getOrganizationSettings(admin, organizationId) {
  const { data, error } = await admin
    .from('organization_settings')
    .select('*')
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) throw error
  return data || {
    organization_id: organizationId,
    pin_max_failures: 5,
    pin_window_minutes: 15,
    pin_lock_minutes: 15
  }
}

async function getSchoolSettings(admin, schoolId) {
  const { data, error } = await admin.from('school_settings').select('*').eq('school_id', schoolId).maybeSingle()
  if (error) throw error
  return data || { school_id: schoolId, campus_emergency_lock: false, auto_scheduling_enabled: true, room_scheduling_enabled: false }
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
  // The old calendar assumes a master schedule named Regular. If an Admin
  // deliberately replaces/deletes that legacy schedule, fall back to the
  // room's assigned Primary rather than closing all normal-day passes.
  if (system.room_scheduling_enabled !== true && source === 'School Default'
      && normalize(settings.schedule_mode) !== 'regular') {
    const {data: regular, error: regularError} = await admin.from('master_schedules')
      .select('id').eq('school_id',room.school_id).ilike('schedule_name','Regular').limit(1)
    if (regularError) throw regularError
    if (!regular?.length) {
      effectiveSchedule = String(settings.schedule_mode)
      source = 'Room Primary (Legacy Fallback)'
    }
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

async function pinLimitStatus(admin, scope, fingerprintHash, security) {
  const { data, error } = await admin
    .from('auth_rate_limits')
    .select('failure_count,window_started_at,locked_until')
    .eq('scope', scope)
    .eq('fingerprint_hash', fingerprintHash)
    .maybeSingle()
  if (error) throw error
  if (!data) return { locked: false, retryMinutes: 0 }
  const now = Date.now()
  const lockedUntil = data.locked_until ? new Date(data.locked_until).getTime() : 0
  if (lockedUntil > now) {
    return { locked: true, retryMinutes: Math.max(1, Math.ceil((lockedUntil - now) / 60000)) }
  }
  return { locked: false, retryMinutes: 0 }
}

async function recordPinFailure(admin, scope, fingerprintHash, security) {
  const now = new Date()
  const { data, error } = await admin
    .from('auth_rate_limits')
    .select('failure_count,window_started_at')
    .eq('scope', scope)
    .eq('fingerprint_hash', fingerprintHash)
    .maybeSingle()
  if (error) throw error

  let count = 1
  let windowStartedAt = now.toISOString()
  if (data) {
    const ageMs = now.getTime() - new Date(data.window_started_at).getTime()
    if (ageMs <= Number(security.pin_window_minutes || 15) * 60000) {
      count = Number(data.failure_count || 0) + 1
      windowStartedAt = data.window_started_at
    }
  }
  const lockedUntil = count >= Number(security.pin_max_failures || 5)
    ? new Date(now.getTime() + Number(security.pin_lock_minutes || 15) * 60000).toISOString()
    : null
  const { error: upsertError } = await admin.from('auth_rate_limits').upsert({
    scope,
    fingerprint_hash: fingerprintHash,
    failure_count: count,
    window_started_at: windowStartedAt,
    locked_until: lockedUntil,
    updated_at: now.toISOString()
  }, { onConflict: 'scope,fingerprint_hash' })
  if (upsertError) throw upsertError
  return { locked: Boolean(lockedUntil), retryMinutes: lockedUntil ? Number(security.pin_lock_minutes || 15) : 0 }
}

async function clearPinFailures(admin, scope, fingerprintHash) {
  const { error } = await admin.from('auth_rate_limits').delete().eq('scope', scope).eq('fingerprint_hash', fingerprintHash)
  if (error) throw error
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

async function getDestinations(admin, roomId, schoolId) {
  const [roomQ, catalogQ] = await Promise.all([
    admin.from('destinations').select('id,catalog_id,room_enabled,max_out_override,enabled,max_out,name,teacher_approval,counts_as_hall_pass,sort_order').eq('room_id', roomId).order('sort_order').order('name'),
    admin.from('destination_catalog').select('id,name,enabled_schoolwide,default_max_out,teacher_approval,counts_as_hall_pass,sort_order').eq('school_id', schoolId)
  ])
  if (roomQ.error) throw roomQ.error
  if (catalogQ.error) throw catalogQ.error
  const catalog = new Map((catalogQ.data || []).map(c => [String(c.id), c]))
  return (roomQ.data || []).map(d => {
    const c = catalog.get(String(d.catalog_id)) || {}
    return {
      id: d.id,
      catalogId: d.catalog_id,
      name: c.name || d.name,
      enabled: Boolean(d.enabled && d.room_enabled !== false && c.enabled_schoolwide !== false),
      roomEnabled: d.room_enabled !== false,
      schoolwideEnabled: c.enabled_schoolwide !== false,
      maxOut: Number(d.max_out || 0),
      defaultMaxOut: Number(c.default_max_out || 0),
      maxOutOverride: d.max_out_override == null ? null : Number(d.max_out_override),
      teacherApproval: Boolean(c.teacher_approval ?? d.teacher_approval),
      countsAsHallPass: Boolean(c.counts_as_hall_pass ?? d.counts_as_hall_pass),
      sortOrder: Number(c.sort_order ?? d.sort_order ?? 0)
    }
  })
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

async function getRoomStudents(admin, roomId, schoolId) {
  // Every room can use the school-wide master student list.
  // room_students is now treated as a per-room override layer (for example,
  // restroom access), not as a gate that determines whether a student exists.
  const [studentsQ, overridesQ] = await Promise.all([
    admin.from('students').select('id,student_number,name,active,restroom_allowed').eq('school_id', schoolId).eq('active', true).order('name'),
    admin.from('room_students').select('student_id,restroom_allowed,active').eq('room_id', roomId)
  ])
  if (studentsQ.error) throw studentsQ.error
  if (overridesQ.error) throw overridesQ.error
  const overrideMap = new Map((overridesQ.data || []).map(row => [String(row.student_id), row]))
  return (studentsQ.data || []).map(student => {
    const override = overrideMap.get(String(student.id))
    return {
      _uuid: student.id,
      id: String(student.student_number),
      name: student.name,
      restroomAllowed: override && override.active !== false
        ? override.restroom_allowed !== false
        : student.restroom_allowed !== false
    }
  })
}

async function lookupStudentForRoom(admin, schoolId, studentNumber) {
  // Student IDs are school-wide. Any active student may request from any active room.
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

async function todayStats(admin, room) {
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString()
  const { data, error } = await admin.from('passes').select('leave_at,return_at,destination_name,test_data').eq('room_id', room.id).gte('leave_at', since)
  if (error) throw error
  const today = localDateKey(new Date(), room.timezone)
  const rows = (data || []).filter(p => !p.test_data && localDateKey(new Date(p.leave_at), room.timezone) === today)
  const completed = rows.filter(p => p.return_at)
  const durations = completed.map(p => (new Date(p.return_at).getTime() - new Date(p.leave_at).getTime()) / 60000).filter(Number.isFinite)
  return {
    passesToday: rows.length,
    restroomToday: rows.filter(p => normalize(p.destination_name) === 'restroom').length,
    completedPasses: completed.length,
    averageMinutes: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    longestMinutes: durations.length ? Math.max(...durations) : 0
  }
}

async function loadContext(admin, orgKey, schoolKey, roomKey, includeStudents = false) {
  const room = await getRoom(admin, orgKey, schoolKey, roomKey)
  if (!room) return null
  const [settings, destinations, schedules, system] = await Promise.all([
    getSettings(admin, room.id), getDestinations(admin, room.id, room.school_id), getSchedules(admin, room.school_id), getSchoolSettings(admin, room.school_id)
  ])
  if (!settings) throw new Error('Room settings are missing.')
  const today = localDateKey(new Date(), room.timezone || room.school?.timezone || 'America/Los_Angeles')
  const calendar = system.room_scheduling_enabled === true ? null : await getCalendarSchedule(admin, room.school_id, today)
  const scheduleMeta = await resolveRoomSchedule(admin, room, settings, system, calendar, today)
  const schedule = computeScheduleState(room, settings, schedules, scheduleMeta, Boolean(system.campus_emergency_lock))
  await expireWaiting(admin, room, settings, schedule)
  const [waiting, out, students] = await Promise.all([
    getWaiting(admin, room.id), getOut(admin, room.id), includeStudents ? getRoomStudents(admin, room.id, room.school_id) : Promise.resolve(null)
  ])
  return { room, settings, destinations, schedules, schedule, scheduleMeta, system, waiting, out, students }
}

async function issueStaffSession(admin, teacherId, role, adminSession = false) {
  const raw = randomToken()
  const tokenHash = await sha256(raw)
  const hours = adminSession || role === 'admin' ? ADMIN_SESSION_HOURS : TEACHER_SESSION_HOURS
  const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString()
  const { error } = await admin.from('teacher_sessions').insert({ teacher_id: teacherId, token_hash: tokenHash, expires_at: expires })
  if (error) throw error
  return raw
}

async function teacherFromSession(admin, rawToken, room, adminContext = false) {
  if (!rawToken) return null
  const tokenHash = await sha256(rawToken)
  const { data: session, error } = await admin.from('teacher_sessions').select('id,teacher_id,created_at,expires_at').eq('token_hash', tokenHash).maybeSingle()
  if (error) throw error
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null
  const { data: teacher, error: teacherError } = await admin.from('teachers').select('id,name,role,active,organization_id').eq('id', session.teacher_id).maybeSingle()
  if (teacherError) throw teacherError
  if (!teacher || !teacher.active) return null

  const sessionHours = adminContext || teacher.role === 'admin' ? ADMIN_SESSION_HOURS : TEACHER_SESSION_HOURS
  const createdAtMs = new Date(session.created_at).getTime()
  const roleExpiresAtMs = createdAtMs + sessionHours * 3600 * 1000
  if (!Number.isFinite(createdAtMs) || roleExpiresAtMs <= Date.now()) {
    await admin.from('teacher_sessions').delete().eq('id', session.id)
    return null
  }

  if (room) {
    if (String(teacher.organization_id) !== String(room.organization?.id || room.school?.organization_id || '')) return null
    if (teacher.role !== 'admin') {
      const [roomLinkQ, schoolAdminQ] = await Promise.all([
        admin.from('teacher_rooms').select('teacher_id').eq('teacher_id', teacher.id).eq('room_id', room.id).maybeSingle(),
        admin.from('teacher_schools').select('teacher_id').eq('teacher_id', teacher.id).eq('school_id', room.school_id).eq('access_level', 'school_admin').maybeSingle()
      ])
      if (roomLinkQ.error) throw roomLinkQ.error
      if (schoolAdminQ.error) throw schoolAdminQ.error
      if (!roomLinkQ.data && !schoolAdminQ.data) return null
    }
  }
  await admin.from('teacher_sessions').update({ last_used_at: new Date().toISOString() }).eq('id', session.id)
  return teacher
}

async function getAdminAccess(admin, teacher) {
  if (!teacher) return null
  const { data: organization, error: orgError } = await admin.from('organizations').select('id,organization_key,name,active').eq('id', teacher.organization_id).maybeSingle()
  if (orgError) throw orgError
  if (!organization || organization.active === false) return null

  let schoolsQuery = admin.from('schools').select('id,organization_id,school_key,name,timezone,active').eq('organization_id', organization.id).eq('active', true).order('name')
  if (teacher.role === 'admin') {
    const { data: schools, error } = await schoolsQuery
    if (error) throw error
    return { organization, schools: schools || [], organizationAdmin: true }
  }

  const { data: memberships, error: membershipError } = await admin.from('teacher_schools').select('school_id').eq('teacher_id', teacher.id).eq('access_level', 'school_admin')
  if (membershipError) throw membershipError
  const schoolIds = (memberships || []).map(x => x.school_id)
  if (!schoolIds.length) return null
  const { data: schools, error } = await schoolsQuery.in('id', schoolIds)
  if (error) throw error
  if (!(schools || []).length) return null
  return { organization, schools: schools || [], organizationAdmin: false }
}

function chooseAdminSchool(access, requestedSchoolKey) {
  const key = cleanSchoolKey(requestedSchoolKey)
  const schools = access?.schools || []
  if (!schools.length) return null
  if (key) return schools.find(s => normalize(s.school_key) === key) || null
  return schools[0]
}

async function verifyTeacher(admin, room, pin, sessionToken, fingerprintHash) {
  const fromSession = await teacherFromSession(admin, sessionToken, room)
  if (fromSession) return { teacher: fromSession, newToken: null, locked: false }
  if (!pin) return { teacher: null, newToken: null, locked: false }
  const scope = `teacher:${room.organization?.organization_key || 'org'}:${room.school?.school_key || 'school'}:${room.room_key}`
  const security = await getOrganizationSettings(admin, room.organization.id)
  const limit = await pinLimitStatus(admin, scope, fingerprintHash, security)
  if (limit.locked) return { teacher: null, newToken: null, locked: true, retryMinutes: limit.retryMinutes }
  const { data, error } = await admin.rpc('hp_verify_teacher_pin_v2', { p_room_id: room.id, p_pin: String(pin).trim() })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : null
  if (!row) {
    const failure = await recordPinFailure(admin, scope, fingerprintHash, security)
    return { teacher: null, newToken: null, locked: failure.locked, retryMinutes: failure.retryMinutes }
  }
  await clearPinFailures(admin, scope, fingerprintHash)
  const teacher = { id: row.teacher_id, name: row.teacher_name, role: row.teacher_role }
  const newToken = await issueStaffSession(admin, teacher.id, teacher.role, false)
  return { teacher, newToken, locked: false }
}

async function verifyTeacherOnce(admin, room, pin, fingerprintHash) {
  if (!pin) return { teacher: null, locked: false }
  const scope = `teacher:${room.organization?.organization_key || 'org'}:${room.school?.school_key || 'school'}:${room.room_key}`
  const security = await getOrganizationSettings(admin, room.organization.id)
  const limit = await pinLimitStatus(admin, scope, fingerprintHash, security)
  if (limit.locked) return { teacher: null, locked: true, retryMinutes: limit.retryMinutes }

  const { data, error } = await admin.rpc('hp_verify_teacher_pin_v2', {
    p_room_id: room.id,
    p_pin: String(pin).trim()
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : null
  if (!row) {
    const failure = await recordPinFailure(admin, scope, fingerprintHash, security)
    return { teacher: null, locked: failure.locked, retryMinutes: failure.retryMinutes }
  }

  await clearPinFailures(admin, scope, fingerprintHash)
  return {
    teacher: { id: row.teacher_id, name: row.teacher_name, role: row.teacher_role },
    locked: false
  }
}

async function resolveAdminOrganizationKey(admin, orgKey) {
  const requested = cleanOrgKey(orgKey)
  if (requested) return requested

  // Backward compatibility for the current single-organization rollout.
  // Once more than one organization exists, Admin links must name the org.
  const { data, error } = await admin
    .from('organizations')
    .select('organization_key')
    .eq('active', true)
    .order('organization_key')
    .limit(2)
  if (error) throw error
  if ((data || []).length === 1) return cleanOrgKey(data[0].organization_key)
  return ''
}

async function verifyAdmin(admin, orgKey, schoolKey, pin, sessionToken, fingerprintHash) {
  const effectiveOrgKey = await resolveAdminOrganizationKey(admin, orgKey)
  if (!effectiveOrgKey) {
    return {
      teacher: null,
      access: null,
      newToken: null,
      locked: false,
      message: 'This Admin link must include an organization because more than one organization exists.'
    }
  }

  const fromSession = await teacherFromSession(admin, sessionToken, null, true)
  if (fromSession) {
    const access = await getAdminAccess(admin, fromSession)
    if (access && normalize(access.organization?.organization_key) === effectiveOrgKey) {
      return { teacher: fromSession, access, newToken: null, locked: false, organizationKey: effectiveOrgKey }
    }
    if (access) {
      return { teacher: null, access: null, newToken: null, locked: false, message: 'This Admin session belongs to a different organization.' }
    }
  }

  if (!pin) return { teacher: null, access: null, newToken: null, locked: false, organizationKey: effectiveOrgKey }
  const { data: organization, error: organizationError } = await admin
    .from('organizations')
    .select('id,organization_key')
    .eq('organization_key', effectiveOrgKey)
    .eq('active', true)
    .maybeSingle()
  if (organizationError) throw organizationError
  if (!organization) return { teacher: null, access: null, newToken: null, locked: false, organizationKey: effectiveOrgKey, message: 'Organization not found.' }
  const scope = `admin:${effectiveOrgKey}`
  const security = await getOrganizationSettings(admin, organization.id)
  const limit = await pinLimitStatus(admin, scope, fingerprintHash, security)
  if (limit.locked) return { teacher: null, access: null, newToken: null, locked: true, retryMinutes: limit.retryMinutes, organizationKey: effectiveOrgKey }
  const { data, error } = await admin.rpc('hp_verify_admin_pin_v2', { p_organization_key: effectiveOrgKey, p_school_key: cleanSchoolKey(schoolKey) || null, p_pin: String(pin).trim() })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : null
  if (!row) {
    const failure = await recordPinFailure(admin, scope, fingerprintHash, security)
    return { teacher: null, access: null, newToken: null, locked: failure.locked, retryMinutes: failure.retryMinutes, organizationKey: effectiveOrgKey }
  }
  await clearPinFailures(admin, scope, fingerprintHash)
  const teacher = { id: row.teacher_id, name: row.teacher_name, role: row.teacher_role, organization_id: row.organization_id }
  const access = await getAdminAccess(admin, teacher)
  if (!access) return { teacher: null, access: null, newToken: null, locked: false, organizationKey: effectiveOrgKey }
  const newToken = await issueStaffSession(admin, teacher.id, teacher.role, true)
  return { teacher, access, newToken, locked: false, organizationKey: effectiveOrgKey }
}

function teacherStatePayload(ctx, stats, includeControls, token) {
  const payload = {
    success: true,
    room: roomScopePayload(ctx.room),
    settings: publicSettings(ctx.room, ctx.settings, ctx.scheduleMeta),
    schedule: ctx.schedule,
    destinations: ctx.destinations,
    waiting: ctx.waiting,
    out: ctx.out,
    stats,
    scheduleMeta: ctx.scheduleMeta
  }
  if (includeControls) {
    payload.schedules = ctx.schedules.map(({ _startMinutes, _endMinutes, ...row }) => row)
    payload.students = ctx.students || []
  }
  if (token) payload._teacherSessionToken = token
  return payload
}

async function pageState(admin, orgKey, schoolKey, roomKey) {
  const ctx = await loadContext(admin, orgKey, schoolKey, roomKey, false)
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

async function teacherDashboard(admin, orgKey, schoolKey, roomKey, pin, sessionToken, includeControls, fingerprintHash) {
  const ctx = await loadContext(admin, orgKey, schoolKey, roomKey, includeControls)
  if (!ctx) return fail('Room not found.')
  const auth = await verifyTeacher(admin, ctx.room, pin, sessionToken, fingerprintHash)
  if (!auth.teacher) return auth.locked ? fail(`Too many incorrect PIN attempts. Try again in ${auth.retryMinutes} minute${auth.retryMinutes === 1 ? '' : 's'}.`) : fail('Incorrect Teacher PIN.')
  const stats = await todayStats(admin, ctx.room)
  return teacherStatePayload(ctx, stats, includeControls, auth.newToken)
}

async function reportData(admin, room, options) {
  options = options || {}
  const type = normalize(options.type) === 'individual' ? 'individual' : 'all'
  const includeTestData = options.includeTestData === true
  const period = String(options.period || '').trim()
  const today = localDateKey(new Date(), room.timezone)
  let startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.startDate || '')) ? String(options.startDate) : today
  let endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.endDate || '')) ? String(options.endDate) : today
  if (startDate > endDate) [startDate, endDate] = [endDate, startDate]

  const broadStart = new Date(startDate + 'T00:00:00Z'); broadStart.setUTCDate(broadStart.getUTCDate() - 1)
  const broadEnd = new Date(endDate + 'T23:59:59Z'); broadEnd.setUTCDate(broadEnd.getUTCDate() + 1)
  let query = admin.from('passes').select('*,students!inner(student_number,name)').eq('room_id', room.id).gte('leave_at', broadStart.toISOString()).lte('leave_at', broadEnd.toISOString())
  const { data, error } = await query
  if (error) throw error
  const rows = (data || []).filter(p => {
    if (!includeTestData && p.test_data) return false
    if (period && normalize(p.period) !== normalize(period)) return false
    const key = localDateKey(new Date(p.leave_at), room.timezone)
    return key >= startDate && key <= endDate
  }).map(p => {
    const completed = Boolean(p.return_at)
    const durationMinutes = completed ? (new Date(p.return_at).getTime() - new Date(p.leave_at).getTime()) / 60000 : null
    return {
      passId: p.id,
      studentId: String(p.students.student_number),
      studentName: p.students.name,
      leaveDate: localDateKey(new Date(p.leave_at), room.timezone),
      leaveTimestampMs: new Date(p.leave_at).getTime(),
      schedule: p.schedule_name,
      period: p.period || '',
      destination: p.destination_name,
      requested: p.requested_at,
      left: p.leave_at,
      returned: p.return_at || '',
      durationMinutes,
      completed,
      teacherOverride: Boolean(p.teacher_override),
      overrideDisplay: p.teacher_override ? p.status_note : '',
      testData: Boolean(p.test_data)
    }
  })

  const students = await getRoomStudents(admin, room.id, room.school_id)
  const rosterMap = Object.fromEntries(students.map(s => [String(s.id), s.name]))

  if (type === 'individual') {
    const studentId = String(options.studentId || '').trim()
    if (!studentId) return fail('Choose a student.')
    const studentPasses = rows.filter(p => p.studentId === studentId).sort((a, b) => b.leaveTimestampMs - a.leaveTimestampMs)
    const completed = studentPasses.filter(p => p.completed && Number.isFinite(p.durationMinutes))
    const totalMinutes = completed.reduce((sum, p) => sum + p.durationMinutes, 0)
    const longestMinutes = completed.reduce((m, p) => Math.max(m, p.durationMinutes), 0)
    return {
      success: true, type: 'individual', startDate, endDate, includeTestData, period,
      studentId, studentName: rosterMap[studentId] || studentPasses[0]?.studentName || studentId,
      summary: {
        totalPasses: studentPasses.length,
        restroomPasses: studentPasses.filter(p => normalize(p.destination) === 'restroom').length,
        completedPasses: completed.length,
        averageMinutes: completed.length ? totalMinutes / completed.length : 0,
        longestMinutes, totalMinutes,
        overrides: studentPasses.filter(p => p.teacherOverride).length
      },
      detailRows: studentPasses.map(p => ({
        passId: p.passId, date: p.leaveDate, schedule: p.schedule, period: p.period, destination: p.destination,
        requested: p.requested, left: p.left, returned: p.returned, durationMinutes: p.durationMinutes,
        completed: p.completed, override: p.overrideDisplay || '', testData: p.testData
      }))
    }
  }

  const summary = {}
  for (const s of students) summary[String(s.id)] = { studentId: String(s.id), studentName: s.name, totalPasses: 0, restroomPasses: 0, completedPasses: 0, totalMinutes: 0, longestMinutes: 0, overrides: 0 }
  for (const p of rows) {
    const id = p.studentId
    if (!summary[id]) summary[id] = { studentId: id, studentName: p.studentName || id, totalPasses: 0, restroomPasses: 0, completedPasses: 0, totalMinutes: 0, longestMinutes: 0, overrides: 0 }
    const x = summary[id]
    x.totalPasses++
    if (normalize(p.destination) === 'restroom') x.restroomPasses++
    if (p.teacherOverride) x.overrides++
    if (p.completed && Number.isFinite(p.durationMinutes)) { x.completedPasses++; x.totalMinutes += p.durationMinutes; x.longestMinutes = Math.max(x.longestMinutes, p.durationMinutes) }
  }
  return {
    success: true, type: 'all', startDate, endDate, includeTestData, period,
    summaryRows: Object.values(summary).map(x => ({ ...x, averageMinutes: x.completedPasses ? x.totalMinutes / x.completedPasses : 0 })).sort((a, b) => a.studentName.localeCompare(b.studentName))
  }
}

async function handleAction(admin, body, fingerprintHash) {
  const action = String(body.action || '')
  const args = Array.isArray(body.args) ? body.args : []
  const orgKey = cleanOrgKey(body.orgKey)
  const schoolKey = cleanSchoolKey(body.schoolKey)
  const roomKey = cleanRoomKey(body.roomKey)
  const sessionToken = String(body.sessionToken || '')

  // Public kiosk operations belong to hallpass-public. Keeping this guard here
  // prevents callers from using the privileged endpoint as an alternate public API.
  if (['getPageState','getLiveState','lookupStudent','requestPass','cancelStudentRequest'].includes(action)) {
    return fail(`Action is not available on the staff Hall Pass service: ${action}`)
  }

  if (action === 'getTeacherDashboardState' || action === 'getTeacherLiveState') {
    return teacherDashboard(admin, orgKey, schoolKey, roomKey, args[0], sessionToken, action === 'getTeacherDashboardState', fingerprintHash)
  }

  const room = await getRoom(admin, orgKey, schoolKey, roomKey)
  if (!room) return fail('Room not found.')

  // startPass is shared by the student UI and teacher UI. api-shim.js routes it
  // here only when a Teacher PIN is supplied. Staff service always requires a
  // valid teacher session/PIN for this action.
  if (action === 'startPass') {
    // Teacher dashboard already has a staff session. A PIN entered on the
    // student kiosk is verified for this one action only and does NOT mint a
    // 12-hour teacher session in the kiosk browser.
    let teacher = await teacherFromSession(admin, sessionToken, room)
    let oneUseAuth = null
    if (!teacher) {
      oneUseAuth = await verifyTeacherOnce(admin, room, args[1], fingerprintHash)
      teacher = oneUseAuth.teacher
    }
    if (!teacher) {
      return oneUseAuth?.locked
        ? fail(`Too many incorrect PIN attempts. Try again in ${oneUseAuth.retryMinutes} minute${oneUseAuth.retryMinutes === 1 ? '' : 's'}.`)
        : fail('Incorrect Teacher PIN.')
    }
    const ctx = await loadContext(admin, orgKey, schoolKey, roomKey, false)
    if (ctx?.system?.campus_emergency_lock) return fail('Campus Emergency Lock is active. New passes cannot be started.')
    const { data, error } = await admin.rpc('hp_start_pass_v2', {
      p_room_id: room.id,
      p_request_id: String(args[0] || ''),
      p_teacher_authorized: true,
      p_allow_time_override: args[2] === true,
      p_allow_limit_override: args[3] === true,
      p_schedule_name: ctx.schedule.schedule,
      p_period: ctx.schedule.period,
      p_window_open: Boolean(ctx.schedule.isOpen),
      p_has_active_period: Boolean(ctx.schedule.period || ctx.schedule.testMode),
      p_test_data: Boolean(ctx.schedule.testMode || ctx.schedule.isTestSchedule),
      p_teacher_id: teacher.id
    })
    if (error) throw error
    return data
  }

  // Returning a student is intentionally left on hallpass-public because the
  // kiosk supports self-return. Staff should use that same constrained route.
  if (action === 'returnStudent') {
    return fail('Student returns use the public Hall Pass service.')
  }

  const pinCandidate = ['cancelRequest'].includes(action) ? null : args[0]
  const auth = await verifyTeacher(admin, room, pinCandidate, sessionToken, fingerprintHash)
  if (!auth.teacher) {
    return auth.locked
      ? fail(`Too many incorrect PIN attempts. Try again in ${auth.retryMinutes} minute${auth.retryMinutes === 1 ? '' : 's'}.`)
      : fail('Incorrect Teacher PIN.')
  }

  if (action === 'startTeacherOverridePass') {
    const ctx = await loadContext(admin, orgKey, schoolKey, roomKey, false)
    if (ctx?.system?.campus_emergency_lock) return fail('Campus Emergency Lock is active. New passes cannot be started.')
    const { data, error } = await admin.rpc('hp_teacher_override_v2', {
      p_room_id: room.id,
      p_student_number: String(args[1] || '').trim(),
      p_destination_name: String(args[2] || '').trim(),
      p_override_limit: args[3] === true,
      p_override_note: String(args[4] || ''),
      p_schedule_name: ctx.schedule.schedule,
      p_period: ctx.schedule.period,
      p_window_open: Boolean(ctx.schedule.isOpen),
      p_has_active_period: Boolean(ctx.schedule.period || ctx.schedule.testMode),
      p_test_data: Boolean(ctx.schedule.testMode || ctx.schedule.isTestSchedule),
      p_teacher_id: auth.teacher.id
    })
    if (error) throw error
    return data
  }

  if (action === 'cancelRequest') {
    const { data, error } = await admin.rpc('hp_cancel_teacher_request_v2', {
      p_room_id: room.id,
      p_request_id: String(args[0] || '')
    })
    if (error) throw error
    return data
  }

  // Room-specific exceptions only: no full roster is returned for restriction management.
  if (action === 'getTeacherRestrictions') {
    const { data: entries, error } = await admin.from('student_restroom_restrictions')
      .select('student_id,restriction_type,pass_limit,updated_at').eq('room_id',room.id).order('updated_at',{ascending:false})
    if (error) throw error
    if (!entries?.length) return {success:true,rows:[]}
    const ids=entries.map(x=>x.student_id)
    const {data:students,error:studentsError}=await admin.from('students')
      .select('id,student_number,name').eq('school_id',room.school_id).in('id',ids)
    if(studentsError)throw studentsError
    const byId=new Map((students||[]).map(x=>[String(x.id),x]))
    return {success:true,rows:entries.filter(x=>byId.has(String(x.student_id))).map(x=>({
      studentNumber:byId.get(String(x.student_id)).student_number,
      name:byId.get(String(x.student_id)).name,
      type:x.restriction_type,
      limit:x.pass_limit,
      updatedAt:x.updated_at
    }))}
  }

  if (action === 'searchTeacherRestrictionStudents') {
    const q=String(args[1]||'').trim().replace(/[%_,()]/g,'').slice(0,80)
    if(q.length<2)return {success:true,rows:[]}
    const query=admin.from('students').select('student_number,name,restroom_allowed')
      .eq('school_id',room.school_id).eq('active',true)
      .or('name.ilike.%'+q+'%,student_number.ilike.%'+q+'%').order('name').limit(12)
    const {data,error}=await query
    if(error)throw error
    return {success:true,rows:(data||[]).map(x=>({
      studentNumber:x.student_number,name:x.name,
      schoolBlocked:x.restroom_allowed===false
    }))}
  }

  if (action === 'saveTeacherRestriction') {
    const studentNumber=String(args[1]||'').trim()
    const type=String(args[2]||'').trim()
    const rawLimit=args[3]
    if(!['Period','Day','Week','Month','Blocked'].includes(type))
      return fail('Choose Per Period, Day, Week, Month, or No Restroom Passes.')
    const limit=type==='Blocked'?null:Number(rawLimit)
    if(type!=='Blocked'&&(!Number.isInteger(limit)||limit<1||limit>100))
      return fail('Enter an allowed pass count between 1 and 100.')
    const {data:student,error:studentError}=await admin.from('students')
      .select('id,name,restroom_allowed').eq('school_id',room.school_id).eq('student_number',studentNumber)
      .eq('active',true).maybeSingle()
    if(studentError)throw studentError
    if(!student)return fail('Student not found in this school.')
    if(student.restroom_allowed===false)return fail('Schoolwide restroom restrictions are managed by Admin.')
    const {error}=await admin.from('student_restroom_restrictions').upsert({
      room_id:room.id,student_id:student.id,restriction_type:type,pass_limit:limit,
      updated_by:auth.teacher.id,updated_at:new Date().toISOString()
    },{onConflict:'room_id,student_id'})
    if(error)throw error
    // Clear the obsolete room-level boolean so the new numerical rule takes precedence.
    const legacy=await admin.from('room_students').update({restroom_allowed:true})
      .eq('room_id',room.id).eq('student_id',student.id)
    if(legacy.error)throw legacy.error
    await writeAudit(admin,auth.teacher.id,'student_restroom_restriction_saved',room.id,
      {studentId:student.id,type,limit},room.school_id)
    return {success:true,message:'Restriction saved for '+student.name+'.'}
  }

  if (action === 'removeTeacherRestriction') {
    const studentNumber=String(args[1]||'').trim()
    const {data:student,error:studentError}=await admin.from('students')
      .select('id,name').eq('school_id',room.school_id).eq('student_number',studentNumber).maybeSingle()
    if(studentError)throw studentError
    if(!student)return fail('Student not found.')
    const {error}=await admin.from('student_restroom_restrictions').delete()
      .eq('room_id',room.id).eq('student_id',student.id)
    if(error)throw error
    const legacy=await admin.from('room_students').update({restroom_allowed:true})
      .eq('room_id',room.id).eq('student_id',student.id)
    if(legacy.error)throw legacy.error
    await writeAudit(admin,auth.teacher.id,'student_restroom_restriction_removed',room.id,
      {studentId:student.id},room.school_id)
    return {success:true,message:student.name+' returned to the room default.'}
  }

  if (action === 'updateStudentRestroomAccessFromDashboard') {
    return fail('Individual restroom settings now use Student Restrictions.')
  }

  if (action === 'updateSettingsFromDashboard') {
    const changes = args[1] || {}
    const allowedKeys=new Set(["Today's Schedule",'Waiting List Enabled'])
    if(Object.keys(changes).some(key=>!allowedKeys.has(key)))
      return fail('These settings are managed by the campus administrator.')
    const patch = {}
    if (Object.hasOwn(changes, "Today's Schedule")) {
      const requested = String(changes["Today's Schedule"] || '').trim()
      const today = localDateKey(new Date(), room.timezone || 'America/Los_Angeles')
      if (requested === '__AUTO__') {
        patch.schedule_override_name = null
        patch.schedule_override_date = null
      } else {
        if (!requested) return fail('Choose a schedule.')
        const { data: scheduleRows, error: scheduleError } = await admin.from('master_schedules').select('schedule_name').eq('school_id', room.school_id).ilike('schedule_name', requested).limit(1)
        if (scheduleError) throw scheduleError
        if (!scheduleRows?.length) return fail('That master schedule does not exist.')
        patch.schedule_override_name = scheduleRows[0].schedule_name
        patch.schedule_override_date = today
      }
    }
    if (Object.hasOwn(changes, 'Waiting List Enabled'))
      patch.waiting_list_enabled=boolYes(changes['Waiting List Enabled'])
    if (Object.keys(patch).length) {
      const { error } = await admin.from('room_settings').update(patch).eq('room_id', room.id)
      if (error) throw error
    }
    return { success: true, message: 'Settings updated.' }
  }

  if (action === 'updateDestinationFromDashboard') {
    const name=String(args[1]||'').trim();
    const changes=args[2]||{};
    if(name.toLowerCase()!=='restroom'||Object.keys(changes).length!==1||typeof changes.enabled!=='boolean')
      return fail('Teachers may only open or close Restroom requests for their room.');
    const roomDestinations=await getDestinations(admin,room.id,room.school_id);
    const current=roomDestinations.find(d=>normalize(d.name)==='restroom');
    if(!current)return fail('Restroom destination is not configured.');
    if(changes.enabled&&current.schoolwideEnabled===false)
      return fail('Restroom is closed schoolwide by Admin.');
    if(changes.enabled){
      const {data:databaseRow,error:dbError}=await admin.from('destinations')
        .select('enabled').eq('id',current.id).maybeSingle();
      if(dbError)throw dbError;
      if(databaseRow?.enabled===false)
        return fail('Restroom is unavailable at the school level. Ask Admin to enable it.');
    }
    const {error}=await admin.from('destinations').update({room_enabled:changes.enabled})
      .eq('id',current.id).eq('room_id',room.id);
    if(error)throw error;
    await writeAudit(admin,auth.teacher.id,'teacher_restroom_toggle',room.id,
      {enabled:changes.enabled},room.school_id);
    return {success:true,message:changes.enabled?'Restroom requests are open.':'Restroom requests are closed.'};
  }

  if (action === 'addDestinationFromDashboard') {
    return fail('Destinations are created by Campus Admin. Teachers can only enable them for this room or set a Max Out override.')
  }

  if (action === 'saveScheduleRowFromDashboard' || action === 'deleteScheduleRowFromDashboard') {
    return fail('Master bell schedules are managed from the Campus Admin page.')
  }

  if (action === 'clearWaitingListFromDashboard') {
    return fail('This action is available to campus administrators only.')
  }

  if (action === 'setEmergencyLockFromDashboard') {
    return fail('This action is available to campus administrators only.')
  }

  if (action === 'backupPassLogFromDashboard') {
    return fail('This action is available to campus administrators only.')
  }

  if (action === 'generatePassReport') return reportData(admin, room, args[1] || {})

  return fail(`Unknown staff action: ${action}`)
}


function cleanEmail(value) {
  const email = String(value ?? '').trim().toLowerCase()
  if (!email) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.')
  return email
}

function cleanTeacherRole(value) {
  return normalize(value) === 'admin' ? 'admin' : 'teacher'
}

async function writeAudit(admin, teacherId, action, roomId = null, details = {}, schoolId = null) {
  let effectiveSchoolId = schoolId || null
  if (!effectiveSchoolId && roomId) {
    const { data: room } = await admin.from('rooms').select('school_id').eq('id', roomId).maybeSingle()
    effectiveSchoolId = room?.school_id || null
  }
  const { error } = await admin.from('audit_log').insert({
    room_id: roomId,
    school_id: effectiveSchoolId,
    teacher_id: teacherId,
    action,
    details
  })
  if (error) console.error('Audit log error:', error)
}

async function replaceTeacherRooms(admin, teacherId, roomIds, school) {
  const cleanIds = [...new Set((Array.isArray(roomIds) ? roomIds : []).map(x => String(x || '').trim()).filter(Boolean))]
  const { data: schoolRooms, error: roomError } = await admin.from('rooms').select('id').eq('school_id', school.id)
  if (roomError) throw roomError
  const validIds = new Set((schoolRooms || []).map(x => String(x.id)))
  if (cleanIds.some(id => !validIds.has(id))) throw new Error('One or more selected rooms do not belong to this school.')

  const currentSchoolRoomIds = [...validIds]
  if (currentSchoolRoomIds.length) {
    const del = await admin.from('teacher_rooms').delete().eq('teacher_id', teacherId).in('room_id', currentSchoolRoomIds)
    if (del.error) throw del.error
  }
  if (cleanIds.length) {
    const rows = cleanIds.map(room_id => ({ teacher_id: teacherId, room_id }))
    const ins = await admin.from('teacher_rooms').insert(rows)
    if (ins.error) throw ins.error
  }
  const membership = await admin.from('teacher_schools').upsert({ teacher_id: teacherId, school_id: school.id, access_level: 'teacher' }, { onConflict: 'teacher_id,school_id', ignoreDuplicates: true })
  if (membership.error) throw membership.error
}

async function ensureRoomDestinations(admin, roomId, schoolId) {
  const [catalogQ, existingQ] = await Promise.all([
    admin.from('destination_catalog').select('*').eq('school_id', schoolId).order('sort_order').order('name'),
    admin.from('destinations').select('catalog_id').eq('room_id', roomId)
  ])
  if (catalogQ.error) throw catalogQ.error
  if (existingQ.error) throw existingQ.error
  const existing = new Set((existingQ.data || []).map(x => String(x.catalog_id)))
  const missing = (catalogQ.data || []).filter(c => !existing.has(String(c.id)))
  if (!missing.length) return
  const rows = missing.map(c => ({
    room_id: roomId,
    catalog_id: c.id,
    room_enabled: true,
    max_out_override: null,
    name: c.name,
    enabled: c.enabled_schoolwide !== false,
    max_out: Number(c.default_max_out || 0),
    max_per_day: 0,
    teacher_approval: c.teacher_approval === true,
    counts_as_hall_pass: c.counts_as_hall_pass !== false,
    sort_order: Number(c.sort_order || 0)
  }))
  const ins = await admin.from('destinations').insert(rows)
  if (ins.error) throw ins.error
}

async function cloneRoomConfiguration(admin, sourceRoomId, targetRoomId, schoolId) {
  if (!sourceRoomId || sourceRoomId === targetRoomId) return
  const [settingsQ, sourceDestQ, sourceSchedulesQ] = await Promise.all([
    admin.from('room_settings').select('*').eq('room_id', sourceRoomId).maybeSingle(),
    admin.from('destinations').select('catalog_id,room_enabled,max_out_override').eq('room_id', sourceRoomId),
    admin.from('room_schedule_assignments').select('day_type,schedule_name').eq('room_id', sourceRoomId)
  ])
  if (settingsQ.error) throw settingsQ.error
  if (sourceDestQ.error) throw sourceDestQ.error
  if (sourceSchedulesQ.error) throw sourceSchedulesQ.error

  if (settingsQ.data) {
    const x = settingsQ.data
    const row = {
      room_id: targetRoomId,
      schedule_mode: x.schedule_mode,
      passes_open_after_start: x.passes_open_after_start,
      passes_close_before_end: x.passes_close_before_end,
      long_pass_warning: x.long_pass_warning,
      very_long_pass_warning: x.very_long_pass_warning,
      buzzer_enabled: x.buzzer_enabled,
      waiting_list_enabled: x.waiting_list_enabled,
      clear_queue_at_period_end: x.clear_queue_at_period_end,
      test_mode: false,
      restroom_limit_period: x.restroom_limit_period,
      restroom_pass_limit: x.restroom_pass_limit
    }
    const q = await admin.from('room_settings').upsert(row, { onConflict: 'room_id' })
    if (q.error) throw q.error
  }

  // Clone room mapping references, not the master bell times themselves.
  const clearMaps = await admin.from('room_schedule_assignments').delete().eq('room_id', targetRoomId)
  if (clearMaps.error) throw clearMaps.error
  if (sourceSchedulesQ.data?.length) {
    const scheduleCopy = await admin.from('room_schedule_assignments').insert(
      sourceSchedulesQ.data.map(x => ({ room_id: targetRoomId, day_type: x.day_type, schedule_name: x.schedule_name }))
    )
    if (scheduleCopy.error) throw scheduleCopy.error
  }
  await ensureRoomDestinations(admin, targetRoomId, schoolId)

  // Reset target room destination choices to master defaults, then copy only the
  // two room-level fields from the source room.
  const reset = await admin.from('destinations').update({ room_enabled: true, max_out_override: null }).eq('room_id', targetRoomId)
  if (reset.error) throw reset.error

  for (const source of (sourceDestQ.data || [])) {
    const q = await admin.from('destinations')
      .update({ room_enabled: source.room_enabled !== false, max_out_override: source.max_out_override ?? null })
      .eq('room_id', targetRoomId)
      .eq('catalog_id', source.catalog_id)
    if (q.error) throw q.error
  }
}

async function ensureDefaultRoomSettings(admin, roomId) {
  const q = await admin.from('room_settings').upsert({ room_id: roomId }, { onConflict: 'room_id', ignoreDuplicates: true })
  if (q.error) throw q.error
}

async function adminManagementState(admin, school, access) {
  const [roomsQ, teachersQ, linksQ, schedulesQ, organizationSettingsQ, schoolSettingsQ, membershipsQ, roomSettingsQ] = await Promise.all([
    admin.from('rooms').select('id,room_key,room_name,timezone,active,emergency_lock,created_at').eq('school_id', school.id).order('room_name'),
    admin.from('teachers').select('id,name,email,role,active,created_at,organization_id').eq('organization_id', access.organization.id).order('name'),
    admin.from('teacher_rooms').select('teacher_id,room_id'),
    admin.from('master_schedules').select('id,schedule_name,period,start_time,end_time').eq('school_id', school.id).order('schedule_name').order('start_time'),
    admin.from('organization_settings').select('*').eq('organization_id',access.organization.id).maybeSingle(),
    admin.from('school_settings').select('*').eq('school_id',school.id).maybeSingle(),
    admin.from('teacher_schools').select('teacher_id,school_id,access_level').eq('school_id',school.id),
    admin.from('room_settings').select('room_id,restroom_pass_limit,restroom_limit_period')
  ])
  for (const q of [roomsQ,teachersQ,linksQ,schedulesQ,organizationSettingsQ,schoolSettingsQ,membershipsQ,roomSettingsQ]) if (q.error) throw q.error
  const roomIds = new Set((roomsQ.data || []).map(r=>String(r.id)))
  const links = (linksQ.data || []).filter(x=>roomIds.has(String(x.room_id)))
  const membershipMap = new Map((membershipsQ.data || []).map(x=>[String(x.teacher_id),x.access_level]))
  const schoolTeacherIds = new Set([
    ...membershipMap.keys(),
    ...links.map(x => String(x.teacher_id))
  ])
  const visibleTeachers = (teachersQ.data || []).filter(t => schoolTeacherIds.has(String(t.id)))
  const organizationTeachers = access.organizationAdmin === true ? (teachersQ.data || []) : visibleTeachers
  return {
    success: true,
    organization: { id: access.organization.id, key: access.organization.organization_key, name: access.organization.name },
    school: { id: school.id, key: school.school_key, name: school.name, timezone: school.timezone },
    organizationAdmin: access.organizationAdmin === true,
    rooms: (roomsQ.data || []).map(r => ({
      id: r.id, key: r.room_key, room: r.room_name, timezone: r.timezone,
      active: r.active, emergencyLock: r.emergency_lock, createdAt: r.created_at,
      restroomLimit:roomSettingsQ.data?.find(x=>x.room_id===r.id)?.restroom_pass_limit??0,
      restroomPeriod:roomSettingsQ.data?.find(x=>x.room_id===r.id)?.restroom_limit_period||'Day',
      teacherIds: links.filter(x => x.room_id === r.id).map(x => x.teacher_id)
    })),
    teachers: visibleTeachers.map(t => ({
      id: t.id, name: t.name, email: t.email || '', role: t.role,
      schoolAdmin: membershipMap.get(String(t.id)) === 'school_admin',
      active: t.active, createdAt: t.created_at,
      roomIds: links.filter(x => x.teacher_id === t.id).map(x => x.room_id)
    })),
    organizationTeachers: organizationTeachers.map(t => ({
      id: t.id, name: t.name, email: t.email || '', role: t.role,
      schoolAdmin: membershipMap.get(String(t.id)) === 'school_admin',
      attachedToSchool: schoolTeacherIds.has(String(t.id)),
      active: t.active,
      roomIds: links.filter(x => x.teacher_id === t.id).map(x => x.room_id)
    })),
    organizationSettings: organizationSettingsQ.data || null,
    schoolSettings: schoolSettingsQ.data || null,
    masterSchedules: (schedulesQ.data || []).map(x => ({
      id: Number(x.id), schedule: x.schedule_name, period: String(x.period),
      startTime: String(x.start_time || '').slice(0,5), endTime: String(x.end_time || '').slice(0,5)
    }))
  }
}


async function adminOnboardingDestinationDefaults(admin, school, sourceRoomId) {
  sourceRoomId = String(sourceRoomId || '').trim()

  const { data: catalogRows, error: catalogError } = await admin
    .from('destination_catalog')
    .select('id,name,enabled_schoolwide,default_max_out,sort_order')
    .eq('school_id', school.id)
    .order('sort_order')
    .order('name')
  if (catalogError) throw catalogError

  let sourceMap = new Map()
  let sourceRoom = null

  if (sourceRoomId) {
    const { data: room, error: roomError } = await admin
      .from('rooms')
      .select('id,room_key,room_name,active,school_id')
      .eq('id', sourceRoomId)
      .eq('school_id', school.id)
      .maybeSingle()
    if (roomError) throw roomError
    if (!room) return fail('Source room not found.')
    sourceRoom = room

    const { data: sourceRows, error: sourceError } = await admin
      .from('destinations')
      .select('catalog_id,room_enabled,max_out_override')
      .eq('room_id', sourceRoomId)
    if (sourceError) throw sourceError
    sourceMap = new Map((sourceRows || []).map(x => [String(x.catalog_id), x]))
  }

  return {
    success: true,
    sourceRoom: sourceRoom ? {
      id: sourceRoom.id,
      key: sourceRoom.room_key,
      room: sourceRoom.room_name,
      active: sourceRoom.active !== false
    } : null,
    rows: (catalogRows || []).map(c => {
      const source = sourceMap.get(String(c.id))
      const override = source && source.max_out_override != null ? Number(source.max_out_override) : null
      return {
        catalogId: c.id,
        name: c.name,
        schoolwideEnabled: c.enabled_schoolwide !== false,
        defaultMaxOut: Number(c.default_max_out || 0),
        sortOrder: Number(c.sort_order || 0),
        enabled: source ? source.room_enabled !== false : true,
        maxOutOverride: override
      }
    })
  }
}

async function adminOnboardRoom(admin, authTeacher, school, data) {
  data = data || {}
  const roomData = data.room || {}
  const teacherData = data.teacher || {}
  const roomKey = cleanRoomKey(roomData.key)
  const roomName = String(roomData.room || '').trim()
  const timezone = String(roomData.timezone || 'America/Los_Angeles').trim() || 'America/Los_Angeles'
  const cloneFromRoomId = String(data.cloneFromRoomId || '').trim()

  if (!roomKey || !/^[a-z0-9_-]+$/.test(roomKey)) {
    return fail('Room key may use lowercase letters, numbers, underscores, and hyphens only.')
  }
  if (!roomName) return fail('Room name is required.')

  if (cloneFromRoomId) {
    const { data: sourceRoom, error: sourceRoomError } = await admin
      .from('rooms')
      .select('id')
      .eq('id', cloneFromRoomId)
      .eq('school_id', school.id)
      .maybeSingle()
    if (sourceRoomError) throw sourceRoomError
    if (!sourceRoom) return fail('The room selected for cloning no longer exists.')
  }

  const teacherMode = normalize(teacherData.mode) === 'existing' ? 'existing' : 'new'
  let existingTeacher = null
  let newTeacherName = ''
  let newTeacherEmail = null
  const requestedPin = String(teacherData.pin || '').trim()

  if (teacherMode === 'existing') {
    const teacherId = String(teacherData.teacherId || '').trim()
    if (!teacherId) return fail('Choose an existing teacher.')
    const { data: teacher, error: teacherError } = await admin
      .from('teachers')
      .select('id,name,email,role,active,organization_id')
      .eq('id', teacherId)
      .eq('organization_id', school.organization_id)
      .maybeSingle()
    if (teacherError) throw teacherError
    if (!teacher) return fail('Teacher not found.')
    if (teacher.active === false) return fail('Choose an active teacher.')
    if (authTeacher.role !== 'admin') {
      if (teacher.role === 'admin') return fail('Only an Organization Admin can assign an Organization Admin account.')
      const membershipQ = await admin.from('teacher_schools').select('teacher_id').eq('teacher_id', teacher.id).eq('school_id', school.id).maybeSingle()
      if (membershipQ.error) throw membershipQ.error
      if (!membershipQ.data) return fail('A School Admin can only assign teachers already attached to this school.')
    }
    if (requestedPin && !/^\d{4,10}$/.test(requestedPin)) return fail('PIN must be 4–10 digits.')
    existingTeacher = teacher
  } else {
    newTeacherName = String(teacherData.name || '').trim()
    if (!newTeacherName) return fail('Teacher name is required.')
    try {
      newTeacherEmail = cleanEmail(teacherData.email)
    } catch (error) {
      return fail(error.message || 'Enter a valid email address.')
    }
    if (!/^\d{4,10}$/.test(requestedPin)) return fail('PIN must be 4–10 digits.')
  }

  const destinationChoices = Array.isArray(data.destinations) ? data.destinations : []
  const roomInsert = await admin
    .from('rooms')
    .insert({
      school_id: school.id,
      room_key: roomKey,
      room_name: roomName,
      timezone,
      active: true
    })
    .select('id,room_key,room_name')
    .single()

  if (roomInsert.error) {
    if (roomInsert.error.code === '23505') return fail('That room key already exists in this school.')
    throw roomInsert.error
  }

  const room = roomInsert.data
  let createdTeacherId = null
  let teacherResult = existingTeacher

  try {
    if (cloneFromRoomId) await cloneRoomConfiguration(admin, cloneFromRoomId, room.id, school.id)
    else {
      await ensureDefaultRoomSettings(admin, room.id)
      await ensureRoomDestinations(admin, room.id, school.id)
    }

    await ensureRoomDestinations(admin, room.id, school.id)

    for (const choice of destinationChoices) {
      const catalogId = String(choice?.catalogId || '').trim()
      if (!catalogId) continue
      let maxOutOverride = null
      if (choice?.maxOutOverride !== null && String(choice?.maxOutOverride ?? '').trim() !== '') {
        const raw = Number(choice.maxOutOverride)
        if (!Number.isFinite(raw) || raw < 0) throw new Error('Destination Max Out overrides must be 0 or greater.')
        maxOutOverride = Math.round(raw)
      }
      const { error: destinationError } = await admin
        .from('destinations')
        .update({
          room_enabled: choice.enabled === true,
          max_out_override: maxOutOverride
        })
        .eq('room_id', room.id)
        .eq('catalog_id', catalogId)
      if (destinationError) throw destinationError
    }

    if (teacherMode === 'new') {
      const teacherInsert = await admin
        .from('teachers')
        .insert({
          organization_id: school.organization_id,
          name: newTeacherName,
          email: newTeacherEmail,
          role: 'teacher',
          active: true
        })
        .select('id,name,email,role,active')
        .single()
      if (teacherInsert.error) {
        if (teacherInsert.error.code === '23505') throw new Error('That email address is already assigned to a teacher.')
        throw teacherInsert.error
      }
      createdTeacherId = teacherInsert.data.id
      teacherResult = teacherInsert.data

      const pinQ = await admin.rpc('hp_set_teacher_pin', {
        p_teacher_id: createdTeacherId,
        p_pin: requestedPin
      })
      if (pinQ.error) throw pinQ.error

      const linkQ = await admin
        .from('teacher_rooms')
        .insert({ teacher_id: createdTeacherId, room_id: room.id })
      if (linkQ.error) throw linkQ.error
    } else {
      const linkQ = await admin
        .from('teacher_rooms')
        .insert({ teacher_id: existingTeacher.id, room_id: room.id })
      if (linkQ.error && linkQ.error.code !== '23505') throw linkQ.error

      // Reset an existing teacher's PIN only after the rest of onboarding has
      // succeeded, so a rollback cannot leave a surprise PIN change behind.
      if (requestedPin) {
        const pinQ = await admin.rpc('hp_set_teacher_pin', {
          p_teacher_id: existingTeacher.id,
          p_pin: requestedPin
        })
        if (pinQ.error) throw pinQ.error
        const sessionQ = await admin.from('teacher_sessions').delete().eq('teacher_id', existingTeacher.id)
        if (sessionQ.error) console.error('Existing teacher session cleanup error:', sessionQ.error)
      }
    }

    const membershipTeacherId = teacherResult?.id || createdTeacherId
    if (membershipTeacherId) {
      const membershipQ = await admin.from('teacher_schools').upsert({ teacher_id: membershipTeacherId, school_id: school.id, access_level: 'teacher' }, { onConflict: 'teacher_id,school_id', ignoreDuplicates: true })
      if (membershipQ.error) throw membershipQ.error
    }

    await writeAudit(admin, authTeacher.id, 'ADMIN_ONBOARD_ROOM', room.id, {
      roomKey,
      roomName,
      teacherId: teacherResult?.id || null,
      teacherName: teacherResult?.name || null,
      teacherMode,
      pinReset: teacherMode === 'existing' && Boolean(requestedPin),
      cloneFromRoomId: cloneFromRoomId || null,
      destinationChoices: destinationChoices.map(x => ({
        catalogId: x?.catalogId || null,
        enabled: x?.enabled === true,
        maxOutOverride: x?.maxOutOverride === '' ? null : (x?.maxOutOverride ?? null)
      }))
    }, school.id)

    return {
      success: true,
      room: { id: room.id, key: room.room_key, room: room.room_name, schoolKey: school.school_key },
      teacher: teacherResult ? { id: teacherResult.id, name: teacherResult.name } : null,
      message: `${roomName} is ready for ${teacherResult?.name || 'the assigned teacher'}.`
    }
  } catch (error) {
    if (createdTeacherId) {
      const cleanupTeacher = await admin.from('teachers').delete().eq('id', createdTeacherId)
      if (cleanupTeacher.error) console.error('Onboarding teacher rollback error:', cleanupTeacher.error)
    }
    const cleanupRoom = await admin.from('rooms').delete().eq('id', room.id)
    if (cleanupRoom.error) console.error('Onboarding room rollback error:', cleanupRoom.error)
    return fail(error?.message || 'Room onboarding failed.')
  }
}

async function adminCreateRoom(admin, authTeacher, school, data) {
  data = data || {}
  const roomKey = cleanRoomKey(data.key)
  const roomName = String(data.room || '').trim()
  const timezone = String(data.timezone || 'America/Los_Angeles').trim() || 'America/Los_Angeles'
  if (!roomKey || !/^[a-z0-9_-]+$/.test(roomKey)) return fail('Room key may use lowercase letters, numbers, underscores, and hyphens only.')
  if (!roomName) return fail('Room name is required.')

  const insert = await admin.from('rooms').insert({ school_id: school.id, room_key: roomKey, room_name: roomName, timezone, active: data.active !== false }).select('id,room_key,room_name').single()
  if (insert.error) {
    if (insert.error.code === '23505') return fail('That room key already exists in this school.')
    throw insert.error
  }
  const room = insert.data
  try {
    const sourceRoomId = String(data.cloneFromRoomId || '').trim()
    if (sourceRoomId) {
      const sourceQ = await admin.from('rooms').select('id').eq('id', sourceRoomId).eq('school_id', school.id).maybeSingle()
      if (sourceQ.error) throw sourceQ.error
      if (!sourceQ.data) throw new Error('The room selected for cloning does not belong to this school.')
      await cloneRoomConfiguration(admin, sourceRoomId, room.id, school.id)
    } else {
      await ensureDefaultRoomSettings(admin, room.id)
      await ensureRoomDestinations(admin, room.id, school.id)
    }

    if(Object.hasOwn(data,'restroomLimit')||Object.hasOwn(data,'restroomPeriod')){
      const limit=Number(data.restroomLimit);
      const period=String(data.restroomPeriod||'Day');
      if(!Number.isInteger(limit)||limit<0||limit>100||!['Day','Week','Month'].includes(period))
        throw new Error('Restroom default must be 0–100 passes per day, week, or month.');
      const {error:settingsError}=await admin.from('room_settings').update({
        restroom_pass_limit:limit,restroom_limit_period:period
      }).eq('room_id',room.id)
      if(settingsError)throw settingsError
    }

    const teacherIds = Array.isArray(data.teacherIds) ? data.teacherIds : []
    for (const teacherId of [...new Set(teacherIds.map(x => String(x || '').trim()).filter(Boolean))]) {
      const teacherQ = await admin.from('teachers').select('id,organization_id,role').eq('id', teacherId).eq('organization_id', school.organization_id).maybeSingle()
      if (teacherQ.error) throw teacherQ.error
      if (!teacherQ.data) throw new Error('One or more selected teachers do not belong to this organization.')
      if (authTeacher.role !== 'admin') {
        if (teacherQ.data.role === 'admin') throw new Error('Only an Organization Admin can assign an Organization Admin account.')
        const membershipQ = await admin.from('teacher_schools').select('teacher_id').eq('teacher_id', teacherId).eq('school_id', school.id).maybeSingle()
        if (membershipQ.error) throw membershipQ.error
        if (!membershipQ.data) throw new Error('A School Admin can only assign teachers already attached to this school.')
      }
      const q = await admin.from('teacher_rooms').insert({ teacher_id: teacherId, room_id: room.id })
      if (q.error && q.error.code !== '23505') throw q.error
      const membershipQ = await admin.from('teacher_schools').upsert({ teacher_id: teacherId, school_id: school.id, access_level: 'teacher' }, { onConflict: 'teacher_id,school_id', ignoreDuplicates: true })
      if (membershipQ.error) throw membershipQ.error
    }
    await writeAudit(admin, authTeacher.id, 'ADMIN_CREATE_ROOM', room.id, { roomKey, roomName, cloneFromRoomId: sourceRoomId || null }, school.id)
    return { success: true, room: { id: room.id, key: room.room_key, room: room.room_name, schoolKey: school.school_key }, message: `${roomName} created.` }
  } catch (error) {
    await admin.from('rooms').delete().eq('id', room.id)
    throw error
  }
}

async function adminDeleteRoom(admin, authTeacher, school, roomId) {
  roomId = String(roomId || '').trim()
  if (!roomId) return fail('Room is required.')

  const { data: room, error: roomError } = await admin.from('rooms').select('id,room_key,room_name').eq('id', roomId).eq('school_id', school.id).maybeSingle()
  if (roomError) throw roomError
  if (!room) return fail('Room not found.')

  const [passesQ, waitingQ] = await Promise.all([
    admin.from('passes').select('id', { count: 'exact', head: true }).eq('room_id', roomId),
    admin.from('waiting_requests').select('id', { count: 'exact', head: true }).eq('room_id', roomId)
  ])
  if (passesQ.error) throw passesQ.error
  if (waitingQ.error) throw waitingQ.error
  const passCount = Number(passesQ.count || 0)
  const waitingCount = Number(waitingQ.count || 0)
  if (passCount > 0 || waitingCount > 0) {
    return fail(`This room has hall-pass history (${passCount} pass${passCount === 1 ? '' : 'es'}, ${waitingCount} waiting record${waitingCount === 1 ? '' : 's'}). Disable it instead of deleting it.`)
  }

  const { error: deleteError } = await admin.from('rooms').delete().eq('id', roomId)
  if (deleteError) throw deleteError
  await writeAudit(admin, authTeacher.id, 'ADMIN_DELETE_ROOM', null, { roomId, roomKey: room.room_key, roomName: room.room_name }, school.id)
  return { success: true, message: `${room.room_name} deleted.` }
}

async function adminUpdateRoom(admin, authTeacher, school, roomId, data) {
  roomId = String(roomId || '').trim(); data = data || {}
  if (!roomId) return fail('Room is required.')

  const existingQ = await admin.from('rooms').select('id,room_key,room_name').eq('id', roomId).eq('school_id', school.id).maybeSingle()
  if (existingQ.error) throw existingQ.error
  if (!existingQ.data) return fail('Room not found.')

  const patch = {}
  if (Object.hasOwn(data, 'key')) {
    const key = cleanRoomKey(data.key)
    if (!key || !/^[a-z0-9_-]+$/.test(key)) return fail('Room key may use lowercase letters, numbers, underscores, and hyphens only.')
    if (key !== cleanRoomKey(existingQ.data.room_key)) return fail('Room key is a permanent URL identifier. Change the room name instead of the room key.')
  }
  if (Object.hasOwn(data, 'room')) {
    const name = String(data.room || '').trim(); if (!name) return fail('Room name is required.'); patch.room_name = name
  }
  if (Object.hasOwn(data, 'timezone')) patch.timezone = String(data.timezone || 'America/Los_Angeles').trim() || 'America/Los_Angeles'
  if (Object.hasOwn(data, 'active')) patch.active = data.active === true
  const q = await admin.from('rooms').update(patch).eq('id', roomId).eq('school_id', school.id).select('id,room_key,room_name').maybeSingle()
  if (q.error) {
    if (q.error.code === '23505') return fail('That room key already exists in this school.')
    throw q.error
  }
  if (!q.data) return fail('Room not found.')
  if(Object.hasOwn(data,'restroomLimit')||Object.hasOwn(data,'restroomPeriod')){
    const limit=Number(data.restroomLimit);
    const period=String(data.restroomPeriod||'Day');
    if(!Number.isInteger(limit)||limit<0||limit>100||!['Day','Week','Month'].includes(period))
      return fail('Restroom default must be 0–100 passes per day, week, or month.')
    const {error:settingsError}=await admin.from('room_settings').update({
      restroom_pass_limit:limit,restroom_limit_period:period
    }).eq('room_id',roomId)
    if(settingsError)throw settingsError
    await writeAudit(admin,authTeacher.id,'ADMIN_UPDATE_ROOM_RESTROOM_DEFAULT',roomId,{limit,period},school.id)
  }
  if (Array.isArray(data.teacherIds)) {
    let ids = [...new Set(data.teacherIds.map(x => String(x || '').trim()).filter(Boolean))]
    const currentLinksQ = await admin.from('teacher_rooms').select('teacher_id').eq('room_id', roomId)
    if (currentLinksQ.error) throw currentLinksQ.error
    const currentIds = [...new Set((currentLinksQ.data || []).map(x => String(x.teacher_id)))]
    let existingOrgAdminIds = []
    if (currentIds.length) {
      const currentTeachersQ = await admin.from('teachers').select('id,role').eq('organization_id', school.organization_id).in('id', currentIds)
      if (currentTeachersQ.error) throw currentTeachersQ.error
      existingOrgAdminIds = (currentTeachersQ.data || []).filter(t => t.role === 'admin').map(t => String(t.id))
    }
    if (ids.length) {
      const teachersQ = await admin.from('teachers').select('id,role').eq('organization_id', school.organization_id).in('id', ids)
      if (teachersQ.error) throw teachersQ.error
      if ((teachersQ.data || []).length !== ids.length) return fail('One or more selected teachers do not belong to this organization.')
      if (authTeacher.role !== 'admin') {
        const addedOrgAdmin = (teachersQ.data || []).some(t => t.role === 'admin' && !currentIds.includes(String(t.id)))
        if (addedOrgAdmin) return fail('Only an Organization Admin can assign an Organization Admin account.')
        const nonOrgAdminIds = (teachersQ.data || []).filter(t => t.role !== 'admin').map(t => String(t.id))
        if (nonOrgAdminIds.length) {
          const memberQ = await admin.from('teacher_schools').select('teacher_id').eq('school_id', school.id).in('teacher_id', nonOrgAdminIds)
          if (memberQ.error) throw memberQ.error
          if ((memberQ.data || []).length !== nonOrgAdminIds.length) return fail('A School Admin can only assign teachers already attached to this school.')
        }
        ids = [...new Set([...ids, ...existingOrgAdminIds])]
      }
    } else if (authTeacher.role !== 'admin' && existingOrgAdminIds.length) {
      ids = existingOrgAdminIds
    }
    const del = await admin.from('teacher_rooms').delete().eq('room_id', roomId)
    if (del.error) throw del.error
    if (ids.length) {
      const ins = await admin.from('teacher_rooms').insert(ids.map(teacher_id => ({ teacher_id, room_id: roomId })))
      if (ins.error) throw ins.error
      for (const teacherId of ids) {
        const membershipQ = await admin.from('teacher_schools').upsert({ teacher_id: teacherId, school_id: school.id, access_level: 'teacher' }, { onConflict: 'teacher_id,school_id', ignoreDuplicates: true })
        if (membershipQ.error) throw membershipQ.error
      }
    }
  }
  await writeAudit(admin, authTeacher.id, 'ADMIN_UPDATE_ROOM', roomId, { patch, teacherIds: data.teacherIds }, school.id)
  return { success: true, message: `${q.data.room_name} updated.` }
}

async function adminCloneRoomConfig(admin, authTeacher, school, targetRoomId, sourceRoomId) {
  targetRoomId = String(targetRoomId || '').trim(); sourceRoomId = String(sourceRoomId || '').trim()
  if (!targetRoomId || !sourceRoomId) return fail('Choose both a source and target room.')
  if (targetRoomId === sourceRoomId) return fail('Choose a different source room.')
  const { data: rooms, error: roomsError } = await admin.from('rooms').select('id').eq('school_id', school.id).in('id',[targetRoomId,sourceRoomId])
  if (roomsError) throw roomsError
  if ((rooms || []).length !== 2) return fail('Both rooms must belong to the current school.')
  await cloneRoomConfiguration(admin, sourceRoomId, targetRoomId, school.id)
  await writeAudit(admin, authTeacher.id, 'ADMIN_CLONE_ROOM_CONFIG', targetRoomId, { sourceRoomId }, school.id)
  return { success: true, message: 'Room settings and destinations copied.' }
}

async function schoolRoomIds(admin, schoolId) {
  const { data, error } = await admin.from('rooms').select('id').eq('school_id', schoolId)
  if (error) throw error
  return (data || []).map(x => x.id)
}

// Whole-schedule editing is atomic in PostgreSQL. The RPC is service-role only;
// this action is reachable only after verified Admin login and school authorization.
// Preview references before removing a master schedule, without changing anything.
async function adminScheduleUsage(admin, school, scheduleName) {
  const name = String(scheduleName || '').trim()
  if (!name || name.length > 80) return fail('Choose a schedule.')
  const [roomsQ, calendarQ, settings] = await Promise.all([
    admin.from('rooms').select('id,room_name,room_key').eq('school_id', school.id),
    admin.from('school_calendar').select('calendar_date,schedule_name').eq('school_id', school.id).limit(1000),
    getSchoolSettings(admin, school.id)
  ])
  if (roomsQ.error) throw roomsQ.error
  if (calendarQ.error) throw calendarQ.error
  const rooms = roomsQ.data || []
  const ids = rooms.map(r => r.id)
  const [defaultsQ, specialsQ] = await Promise.all([
    ids.length ? admin.from('room_settings').select('room_id,schedule_mode,schedule_override_name').in('room_id',ids) : Promise.resolve({data:[],error:null}),
    ids.length ? admin.from('room_schedule_assignments').select('room_id,day_type,schedule_name').in('room_id',ids) : Promise.resolve({data:[],error:null})
  ])
  if (defaultsQ.error) throw defaultsQ.error
  if (specialsQ.error) throw specialsQ.error
  const same = value => normalize(value) === normalize(name)
  const lookup = new Map(rooms.map(r=>[String(r.id),r.room_name || r.room_key]))
  const defaultRooms = (defaultsQ.data || []).filter(x=>same(x.schedule_mode)).map(x=>lookup.get(String(x.room_id))).filter(Boolean)
  const overrideRooms = (defaultsQ.data || []).filter(x=>same(x.schedule_override_name)).map(x=>lookup.get(String(x.room_id))).filter(Boolean)
  const calendarDates = (calendarQ.data || []).filter(x=>same(x.schedule_name)).map(x=>x.calendar_date)
  const specialRooms = (specialsQ.data || []).filter(x=>same(x.schedule_name)).map(x=>({room:lookup.get(String(x.room_id)) || 'Room',dayType:x.day_type}))
  return {success:true, name, defaultRooms, overrideRooms, calendarDates, specialRooms,
    legacyRegularFallback: normalize(name)==='regular' && settings.room_scheduling_enabled !== true}
}

// The SQL RPC updates EVERY reference and deletes the old definition atomically.
async function adminReplaceDeleteSchedule(admin, authTeacher, school, data = {}) {
  const oldName = String(data.originalName || '').trim()
  const replacement = String(data.replacementName || '').trim()
  if (!oldName || !replacement || normalize(oldName)===normalize(replacement))
    return fail('Choose a different existing replacement schedule.')
  const {data: result,error} = await admin.rpc('hp_replace_delete_master_schedule',{
    p_school_id:school.id,p_old_name:oldName,p_replacement_name:replacement
  })
  if (error) return fail(error.message || 'Unable to replace and delete the schedule.')
  if (!result?.success) return fail(result?.message || 'Unable to replace and delete the schedule.')
  await writeAudit(admin,authTeacher.id,'ADMIN_REPLACE_DELETE_MASTER_SCHEDULE',null,
    {oldName,replacement,...result},school.id)
  return result
}

async function adminManageWholeSchedule(admin, authTeacher, school, data = {}) {
  const oldName = String(data.originalName || '').trim()
  const newName = String(data.name || '').trim()
  const removing = data.delete === true
  const periods = Array.isArray(data.periods) ? data.periods : []
  if (!removing && (!newName || newName.length > 80 || !periods.length || periods.length > 50))
    return fail('Enter a schedule name and 1–50 complete periods.')
  if (oldName.length > 80 || (removing && !oldName)) return fail('Choose an existing schedule.')
  const clean = removing ? [] : periods.map(p => ({
    period: String(p.period || '').trim(),
    startTime: String(p.startTime || ''),
    endTime: String(p.endTime || '')
  }))
  const { data: result, error } = await admin.rpc('hp_manage_master_schedule', {
    p_school_id: school.id,
    p_original_name: oldName,
    p_name: newName,
    p_periods: clean,
    p_delete: removing
  })
  if (error) return fail(error.message || 'Could not save the schedule.')
  if (!result?.success) return fail(result?.message || 'Could not save the schedule.')
  await writeAudit(admin, authTeacher.id,
    removing ? 'ADMIN_DELETE_WHOLE_SCHEDULE' : 'ADMIN_SAVE_WHOLE_SCHEDULE',
    null, { oldName, newName, periodCount: clean.length }, school.id)
  return result
}

async function adminSaveMasterSchedule(admin, authTeacher, school, data) {
  data = data || {}
  const id = Number(data.id)
  const schedule = String(data.schedule || '').replace(/\s+/g, ' ').trim().substring(0, 80)
  const period = String(data.period || '').replace(/\s+/g, ' ').trim().substring(0, 40)
  const start = parseClock(String(data.startTime || ''))
  const end = parseClock(String(data.endTime || ''))
  if (!schedule) return fail('Schedule name is required.')
  if (!period) return fail('Period is required.')
  if (start === null || end === null || end <= start) return fail('Enter valid start and end times.')
  const values = { school_id: school.id, schedule_name: schedule, period, start_time: formatClock(start), end_time: formatClock(end), updated_at: new Date().toISOString() }
  let q
  if (Number.isInteger(id) && id > 0) {
    const { data: oldRow, error: oldError } = await admin.from('master_schedules').select('schedule_name').eq('school_id', school.id).eq('id', id).maybeSingle()
    if (oldError) throw oldError
    if (!oldRow) return fail('Schedule row not found.')
    if (normalize(oldRow.schedule_name) !== normalize(schedule)) {
      const { data: sameOld, error: sameError } = await admin.from('master_schedules').select('id').eq('school_id', school.id).ilike('schedule_name', oldRow.schedule_name)
      if (sameError) throw sameError
      if ((sameOld || []).length === 1) {
        const roomIds = await schoolRoomIds(admin, school.id)
        const defaultUse = roomIds.length ? await admin.from('room_settings').select('room_id').in('room_id', roomIds).ilike('schedule_mode', oldRow.schedule_name).limit(1) : { data: [], error: null }
        const overrideUse = roomIds.length ? await admin.from('room_settings').select('room_id').in('room_id', roomIds).ilike('schedule_override_name', oldRow.schedule_name).limit(1) : { data: [], error: null }
        const calendarUse = await admin.from('school_calendar').select('calendar_date').eq('school_id', school.id).ilike('schedule_name', oldRow.schedule_name).limit(1)
        const specialUse = roomIds.length ? await admin.from('room_schedule_assignments').select('room_id').in('room_id', roomIds).ilike('schedule_name', oldRow.schedule_name).limit(1) : { data: [], error: null }
        if (defaultUse.error) throw defaultUse.error
        if (overrideUse.error) throw overrideUse.error
        if (calendarUse.error) throw calendarUse.error
        if (specialUse.error) throw specialUse.error
        if (defaultUse.data?.length || overrideUse.data?.length || calendarUse.data?.length || specialUse.data?.length) return fail('This is the final row for a schedule that is still in use. Update room schedule assignments first.')
      }
    }
    q = await admin.from('master_schedules').update(values).eq('school_id', school.id).eq('id', id).select('id').maybeSingle()
  } else {
    q = await admin.from('master_schedules').insert(values).select('id').single()
  }
  if (q.error) {
    if (q.error.code === '23505') return fail('That schedule already has a row for this period.')
    throw q.error
  }
  await writeAudit(admin, authTeacher.id, Number.isInteger(id) && id > 0 ? 'ADMIN_UPDATE_MASTER_SCHEDULE' : 'ADMIN_ADD_MASTER_SCHEDULE', null, { id: q.data?.id || id || null, schedule, period }, school.id)
  return { success: true, message: Number.isInteger(id) && id > 0 ? 'Master schedule row updated.' : 'Master schedule row added.' }
}

async function adminDeleteMasterSchedule(admin, authTeacher, school, id) {
  id = Number(id)
  if (!Number.isInteger(id) || id < 1) return fail('Schedule row not found.')
  const { data: row, error: readError } = await admin.from('master_schedules').select('schedule_name,period').eq('school_id', school.id).eq('id', id).maybeSingle()
  if (readError) throw readError
  if (!row) return fail('Schedule row not found.')
  const { data: sameName, error: countError } = await admin.from('master_schedules').select('id').eq('school_id', school.id).ilike('schedule_name', row.schedule_name)
  if (countError) throw countError
  if ((sameName || []).length === 1) {
    const roomIds = await schoolRoomIds(admin, school.id)
    const defaultUse = roomIds.length ? await admin.from('room_settings').select('room_id').in('room_id', roomIds).ilike('schedule_mode', row.schedule_name).limit(1) : { data: [], error: null }
    const overrideUse = roomIds.length ? await admin.from('room_settings').select('room_id').in('room_id', roomIds).ilike('schedule_override_name', row.schedule_name).limit(1) : { data: [], error: null }
    const calendarUse = await admin.from('school_calendar').select('calendar_date').eq('school_id', school.id).ilike('schedule_name', row.schedule_name).limit(1)
    const specialUse = roomIds.length ? await admin.from('room_schedule_assignments').select('room_id').in('room_id', roomIds).ilike('schedule_name', row.schedule_name).limit(1) : { data: [], error: null }
    if (defaultUse.error) throw defaultUse.error
    if (overrideUse.error) throw overrideUse.error
    if (calendarUse.error) throw calendarUse.error
    if (specialUse.error) throw specialUse.error
    if (defaultUse.data?.length || overrideUse.data?.length || calendarUse.data?.length || specialUse.data?.length) return fail('This schedule is still referenced by a room or calendar. Update those assignments first.')
  }
  const { error } = await admin.from('master_schedules').delete().eq('school_id', school.id).eq('id', id)
  if (error) throw error
  await writeAudit(admin, authTeacher.id, 'ADMIN_DELETE_MASTER_SCHEDULE', null, { id, schedule: row.schedule_name, period: row.period }, school.id)
  return { success: true, message: 'Master schedule row deleted.' }
}

async function setSchoolAdminMembership(admin, teacherId, school, enabled) {
  const level = enabled ? 'school_admin' : 'teacher'
  const q = await admin.from('teacher_schools').upsert({ teacher_id: teacherId, school_id: school.id, access_level: level }, { onConflict: 'teacher_id,school_id' })
  if (q.error) throw q.error
}

async function adminCreateTeacher(admin, authTeacher, school, access, data) {
  data = data || {}
  const name = String(data.name || '').trim()
  if (!name) return fail('Teacher name is required.')
  let email
  try { email = cleanEmail(data.email) } catch (error) { return fail(error.message || 'Enter a valid email address.') }
  let role = cleanTeacherRole(data.role)
  if (role === 'admin' && access.organizationAdmin !== true) return fail('Only an Organization Admin can create another Organization Admin.')
  if (access.organizationAdmin !== true) role = 'teacher'
  const pin = String(data.pin || '').trim()
  if (!/^\d{4,10}$/.test(pin)) return fail('PIN must be 4–10 digits.')
  const q = await admin.from('teachers').insert({ organization_id: access.organization.id, name, email, role, active: data.active !== false }).select('id,name').single()
  if (q.error) {
    if (q.error.code === '23505') return fail('That email address is already assigned to a teacher in this organization.')
    throw q.error
  }
  try {
    const pinQ = await admin.rpc('hp_set_teacher_pin', { p_teacher_id: q.data.id, p_pin: pin })
    if (pinQ.error) throw pinQ.error
    await replaceTeacherRooms(admin, q.data.id, data.roomIds, school)
    if (access.organizationAdmin === true && data.schoolAdmin === true) await setSchoolAdminMembership(admin, q.data.id, school, true)
    await writeAudit(admin, authTeacher.id, 'ADMIN_CREATE_TEACHER', null, { teacherId: q.data.id, name, role, schoolAdmin: data.schoolAdmin === true, roomIds: data.roomIds || [] }, school.id)
    return { success: true, teacher: { id: q.data.id, name: q.data.name }, message: `${name} created.` }
  } catch (error) {
    await admin.from('teachers').delete().eq('id', q.data.id)
    throw error
  }
}

async function adminUpdateTeacher(admin, authTeacher, school, access, teacherId, data) {
  teacherId = String(teacherId || '').trim(); data = data || {}
  if (!teacherId) return fail('Teacher is required.')
  const { data: existing, error: existingError } = await admin.from('teachers').select('id,name,role,organization_id').eq('id', teacherId).eq('organization_id', access.organization.id).maybeSingle()
  if (existingError) throw existingError
  if (!existing) return fail('Teacher not found.')
  if (access.organizationAdmin !== true) {
    if (existing.role === 'admin') return fail('Only an Organization Admin can manage an Organization Admin account.')
    const membershipQ = await admin.from('teacher_schools').select('teacher_id,access_level').eq('teacher_id', teacherId).eq('school_id', school.id).maybeSingle()
    if (membershipQ.error) throw membershipQ.error
    if (!membershipQ.data) return fail('You can only manage teachers attached to this school.')
    if (membershipQ.data.access_level === 'school_admin') return fail('Only an Organization Admin can manage a School Admin account.')
  }
  const patch = {}
  if (Object.hasOwn(data, 'name')) { const name = String(data.name || '').trim(); if (!name) return fail('Teacher name is required.'); patch.name = name }
  if (Object.hasOwn(data, 'email')) { try { patch.email = cleanEmail(data.email) } catch (error) { return fail(error.message || 'Enter a valid email address.') } }
  if (Object.hasOwn(data, 'role')) {
    const requestedRole = cleanTeacherRole(data.role)
    if (requestedRole !== existing.role && access.organizationAdmin !== true) return fail('Only an Organization Admin can change Organization Admin access.')
    patch.role = access.organizationAdmin === true ? requestedRole : existing.role
  }
  if (Object.hasOwn(data, 'active')) patch.active = data.active === true
  let q = { data: existing, error: null }
  if (Object.keys(patch).length) q = await admin.from('teachers').update(patch).eq('id', teacherId).eq('organization_id', access.organization.id).select('id,name').maybeSingle()
  if (q.error) {
    if (q.error.code === '23505') return fail('That email address is already assigned to a teacher in this organization.')
    throw q.error
  }
  if (!q.data) return fail('Teacher not found.')
  const pin = String(data.pin || '').trim()
  if (pin) {
    if (!/^\d{4,10}$/.test(pin)) return fail('PIN must be 4–10 digits.')
    const pinQ = await admin.rpc('hp_set_teacher_pin', { p_teacher_id: teacherId, p_pin: pin })
    if (pinQ.error) throw pinQ.error
    await admin.from('teacher_sessions').delete().eq('teacher_id', teacherId)
  }
  if (Array.isArray(data.roomIds)) await replaceTeacherRooms(admin, teacherId, data.roomIds, school)
  if (Object.hasOwn(data, 'schoolAdmin') && access.organizationAdmin === true) await setSchoolAdminMembership(admin, teacherId, school, data.schoolAdmin === true)
  await writeAudit(admin, authTeacher.id, 'ADMIN_UPDATE_TEACHER', null, { teacherId, patch, schoolAdmin: data.schoolAdmin, pinReset: Boolean(pin), roomIds: data.roomIds }, school.id)
  return { success: true, message: `${q.data.name} updated.` }
}

async function adminRestrictionsState(admin,school){
  const {data:rooms,error:roomError}=await admin.from('rooms').select('id,room_name,room_key')
    .eq('school_id',school.id).order('room_name')
  if(roomError)throw roomError
  const roomMap=new Map((rooms||[]).map(x=>[x.id,x]))
  if(!roomMap.size)return {success:true,rows:[]}
  const {data:restrictions,error}=await admin.from('student_restroom_restrictions')
    .select('room_id,student_id,restriction_type,pass_limit,updated_at')
    .in('room_id',[...roomMap.keys()]).order('updated_at',{ascending:false})
  if(error)throw error
  if(!restrictions?.length)return {success:true,rows:[]}
  const {data:students,error:studentError}=await admin.from('students')
    .select('id,student_number,name').eq('school_id',school.id)
    .in('id',[...new Set(restrictions.map(x=>x.student_id))])
  if(studentError)throw studentError
  const studentMap=new Map((students||[]).map(x=>[x.id,x]))
  return {success:true,rows:restrictions.filter(x=>studentMap.has(x.student_id))
    .map(x=>({
      roomId:x.room_id,room:roomMap.get(x.room_id)?.room_name||'',
      studentNumber:studentMap.get(x.student_id).student_number,
      studentName:studentMap.get(x.student_id).name,
      type:x.restriction_type,limit:x.pass_limit,updatedAt:x.updated_at
    }))}
}
async function adminSaveRoomRestriction(admin,teacher,school,roomId,studentNumber,type,rawLimit){
  const {data:room,error:roomError}=await admin.from('rooms').select('id')
    .eq('id',String(roomId||'')).eq('school_id',school.id).maybeSingle()
  if(roomError)throw roomError
  if(!room)return fail('Room not found in this school.')
  const {data:student,error:studentError}=await admin.from('students')
    .select('id,name').eq('school_id',school.id).eq('student_number',String(studentNumber||'').trim())
    .maybeSingle()
  if(studentError)throw studentError
  if(!student)return fail('Student not found.')
  type=String(type||'')
  if(!['Period','Day','Week','Month','Blocked'].includes(type))return fail('Invalid restriction.')
  const limit=type==='Blocked'?null:Number(rawLimit)
  if(type!=='Blocked'&&(!Number.isInteger(limit)||limit<1||limit>100))
    return fail('Pass limit must be an integer between 1 and 100.')
  const {error}=await admin.from('student_restroom_restrictions').upsert({
    room_id:room.id,student_id:student.id,restriction_type:type,pass_limit:limit,
    updated_by:teacher.id,updated_at:new Date().toISOString()
  },{onConflict:'room_id,student_id'})
  if(error)throw error
  const legacy=await admin.from('room_students').update({restroom_allowed:true})
    .eq('room_id',room.id).eq('student_id',student.id)
  if(legacy.error)throw legacy.error
  await writeAudit(admin,teacher.id,'ADMIN_SAVE_ROOM_RESTRICTION',room.id,
    {studentId:student.id,type,limit},school.id)
  return {success:true,message:'Restriction saved.'}
}
async function adminRemoveRoomRestriction(admin,teacher,school,roomId,studentNumber){
  const {data:room,error:roomError}=await admin.from('rooms').select('id')
    .eq('id',String(roomId||'')).eq('school_id',school.id).maybeSingle()
  if(roomError)throw roomError
  if(!room)return fail('Room not found.')
  const {data:student,error:studentError}=await admin.from('students').select('id')
    .eq('school_id',school.id).eq('student_number',String(studentNumber||'')).maybeSingle()
  if(studentError)throw studentError
  if(!student)return fail('Student not found.')
  const {error}=await admin.from('student_restroom_restrictions').delete()
    .eq('room_id',room.id).eq('student_id',student.id)
  if(error)throw error
  const legacy=await admin.from('room_students').update({restroom_allowed:true})
    .eq('room_id',room.id).eq('student_id',student.id)
  if(legacy.error)throw legacy.error
  await writeAudit(admin,teacher.id,'ADMIN_REMOVE_ROOM_RESTRICTION',room.id,{studentId:student.id},school.id)
  return {success:true,message:'Room restriction removed. Student follows the room default.'}
}

async function adminStudentsState(admin, school, options = {}) {
  const search = normalize(options.search || '')
  const includeInactive = options.includeInactive !== false
  let query = admin.from('students').select('id,student_number,name,active,restroom_allowed,created_at,updated_at').eq('school_id', school.id).order('name')
  if (!includeInactive) query = query.eq('active', true)
  const { data, error } = await query
  if (error) throw error
  let rows = (data || []).map(x => ({
    id: x.id, studentId: String(x.student_number), name: x.name,
    active: x.active !== false, restroomAllowed: x.restroom_allowed !== false,
    createdAt: x.created_at, updatedAt: x.updated_at
  }))
  if (search) rows = rows.filter(x => normalize(`${x.studentId} ${x.name}`).includes(search))
  return { success: true, rows, total: rows.length }
}

function cleanStudentName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').replace(/(?:,\s*)+$/, '').trim()
}

function cleanStudentImportRows(rows) {
  const cleaned = []
  const seen = new Set()
  for (const raw of Array.isArray(rows) ? rows : []) {
    const studentId = String(raw?.studentId ?? raw?.student_number ?? raw?.id ?? '').trim()
    const name = cleanStudentName(raw?.name)
    if (!studentId && !name) continue
    if (!studentId) return { error: `A row is missing Student ID: ${name || '(unnamed student)'}` }
    if (!name) return { error: `Student ${studentId} is missing a name.` }
    if (seen.has(studentId)) return { error: `Student ID ${studentId} appears more than once in the import.` }
    seen.add(studentId)
    cleaned.push({ studentId, name })
  }
  return { rows: cleaned }
}

async function adminSaveStudent(admin, authTeacher, school, studentUuid, data) {
  data = data || {}
  const studentId = String(data.studentId || '').trim()
  const name = cleanStudentName(data.name)
  if (!studentId) return fail('Student ID is required.')
  if (!name) return fail('Student name is required.')
  const values = { school_id: school.id, student_number: studentId, name, active: data.active !== false, restroom_allowed: data.restroomAllowed !== false, updated_at: new Date().toISOString() }
  let q
  if (studentUuid) q = await admin.from('students').update(values).eq('school_id', school.id).eq('id', String(studentUuid)).select('id,student_number,name').maybeSingle()
  else q = await admin.from('students').insert(values).select('id,student_number,name').single()
  if (q.error) {
    if (q.error.code === '23505') return fail('That Student ID already exists at this school.')
    throw q.error
  }
  if (!q.data) return fail('Student not found.')
  await writeAudit(admin, authTeacher.id, studentUuid ? 'ADMIN_UPDATE_STUDENT' : 'ADMIN_ADD_STUDENT', null, { studentId, name, active: values.active }, school.id)
  return { success: true, message: `${name} ${studentUuid ? 'updated' : 'added'}.`, student: { id: q.data.id, studentId: String(q.data.student_number), name: q.data.name } }
}

async function adminImportStudents(admin, authTeacher, school, payload = {}) {
  const parsed = cleanStudentImportRows(payload.rows)
  if (parsed.error) return fail(parsed.error)
  const rows = parsed.rows || []
  if (!rows.length) return fail('No student rows were supplied.')
  if (rows.length > 5000) return fail('Import is limited to 5,000 students at a time.')
  const { data: existing, error: existingError } = await admin.from('students').select('id,student_number,name,active,restroom_allowed').eq('school_id', school.id)
  if (existingError) throw existingError
  const map = new Map((existing || []).map(x => [String(x.student_number), x]))
  let added = 0, updated = 0, unchanged = 0, reactivated = 0
  const upserts = []
  const importedIds = new Set()
  const now = new Date().toISOString()
  for (const row of rows) {
    importedIds.add(row.studentId)
    const old = map.get(row.studentId)
    if (!old) {
      added++
      upserts.push({ school_id: school.id, student_number: row.studentId, name: row.name, active: true, restroom_allowed: true, updated_at: now })
      continue
    }
    const nameChanged = String(old.name) !== row.name
    const wasInactive = old.active === false
    if (nameChanged || wasInactive) {
      if (wasInactive) reactivated++
      else updated++
      upserts.push({ id: old.id, school_id: school.id, student_number: row.studentId, name: row.name, active: true, restroom_allowed: old.restroom_allowed !== false, updated_at: now })
    } else unchanged++
  }
  if (upserts.length) {
    const q = await admin.from('students').upsert(upserts, { onConflict: 'school_id,student_number' })
    if (q.error) throw q.error
  }
  let disabled = 0
  if (payload.disableMissing === true) {
    const toDisable = (existing || []).filter(x => x.active !== false && !importedIds.has(String(x.student_number))).map(x => x.id)
    if (toDisable.length) {
      disabled = toDisable.length
      const q = await admin.from('students').update({ active: false, updated_at: now }).eq('school_id', school.id).in('id', toDisable)
      if (q.error) throw q.error
    }
  }
  const summary = { totalImported: rows.length, added, updated, reactivated, unchanged, disabled }
  await writeAudit(admin, authTeacher.id, 'ADMIN_IMPORT_STUDENTS', null, summary, school.id)
  return { success: true, summary, message: `Student import complete: ${added} added, ${updated} updated, ${reactivated} reactivated${payload.disableMissing ? `, ${disabled} disabled` : ''}.` }
}

async function adminSecurityState(admin, school, access) {
  const [settings, schoolSettings] = await Promise.all([getOrganizationSettings(admin, access.organization.id), getSchoolSettings(admin, school.id)])
  const scopePrefix = `:${access.organization.organization_key}:${school.school_key}`
  const { data: locks, error } = await admin.from('auth_rate_limits').select('scope,fingerprint_hash,failure_count,window_started_at,locked_until,updated_at').order('updated_at', { ascending: false }).limit(500)
  if (error) throw error
  const now = Date.now()
  const orgAdminScope = `admin:${access.organization.organization_key}`
  const orgTeacherPrefix = `teacher:${access.organization.organization_key}:`
  const visibleLocks = (locks || []).filter(x => {
    const scope = String(x.scope || '')
    if (access.organizationAdmin === true) return scope === orgAdminScope || scope.startsWith(orgTeacherPrefix)
    return scope.includes(scopePrefix)
  })
  return {
    success: true,
    organizationAdmin: access.organizationAdmin === true,
    settings: {
      pinMaxFailures: Number(settings.pin_max_failures || 5),
      pinWindowMinutes: Number(settings.pin_window_minutes || 15),
      pinLockMinutes: Number(settings.pin_lock_minutes || 15),
      campusEmergencyLock: Boolean(schoolSettings.campus_emergency_lock)
    },
    lockouts: visibleLocks.map(x => ({
      scope: x.scope, fingerprint: String(x.fingerprint_hash || '').slice(0, 12) + '…', fingerprintHash: x.fingerprint_hash,
      failureCount: Number(x.failure_count || 0), windowStartedAt: x.window_started_at, lockedUntil: x.locked_until,
      isLocked: Boolean(x.locked_until && new Date(x.locked_until).getTime() > now), updatedAt: x.updated_at
    }))
  }
}

async function adminUpdateSecurity(admin, authTeacher, school, access, data = {}) {
  if (access.organizationAdmin !== true) return fail('Only an Organization Admin can change PIN security policy.')
  const pinMaxFailures = clampNumber(data.pinMaxFailures, 3, 10, 5)
  const pinWindowMinutes = clampNumber(data.pinWindowMinutes, 5, 60, 15)
  const pinLockMinutes = clampNumber(data.pinLockMinutes, 1, 120, 15)
  const q = await admin.from('organization_settings').upsert({ organization_id: access.organization.id, pin_max_failures: pinMaxFailures, pin_window_minutes: pinWindowMinutes, pin_lock_minutes: pinLockMinutes, updated_at: new Date().toISOString() }, { onConflict: 'organization_id' })
  if (q.error) throw q.error
  await writeAudit(admin, authTeacher.id, 'ADMIN_UPDATE_SECURITY_SETTINGS', null, { pinMaxFailures, pinWindowMinutes, pinLockMinutes }, school.id)
  return { success: true, message: 'Security settings updated.' }
}

async function adminClearLockout(admin, authTeacher, school, access, scope, fingerprintHash) {
  scope = String(scope || '').trim(); fingerprintHash = String(fingerprintHash || '').trim()
  if (!scope && !fingerprintHash && access.organizationAdmin !== true) return fail('Only an Organization Admin can clear all PIN attempt records.')
  let q
  if (!scope && !fingerprintHash) {
    const orgAdminScope = `admin:${access.organization.organization_key}`
    const orgTeacherPrefix = `teacher:${access.organization.organization_key}:`
    const allQ = await admin.from('auth_rate_limits').select('scope')
    if (allQ.error) throw allQ.error
    const scopes = [...new Set((allQ.data || []).map(x => String(x.scope || '')).filter(x => x === orgAdminScope || x.startsWith(orgTeacherPrefix)))]
    q = scopes.length ? await admin.from('auth_rate_limits').delete().in('scope', scopes) : { error: null }
  }
  else if (scope && fingerprintHash) {
    const allowed = access.organizationAdmin === true || scope.includes(`:${access.organization.organization_key}:${school.school_key}`)
    if (!allowed) return fail('That lockout does not belong to this school.')
    q = await admin.from('auth_rate_limits').delete().eq('scope', scope).eq('fingerprint_hash', fingerprintHash)
  } else return fail('Lockout identifier is incomplete.')
  if (q.error) throw q.error
  await writeAudit(admin, authTeacher.id, 'ADMIN_CLEAR_PIN_LOCKOUT', null, { scope: scope || 'ALL', fingerprint: fingerprintHash ? fingerprintHash.slice(0, 12) : 'ALL' }, school.id)
  return { success: true, message: scope ? 'Lockout cleared.' : 'All PIN attempt records cleared.' }
}

async function adminSetCampusLock(admin, authTeacher, school, turnOn) {
  turnOn = turnOn === true
  const q = await admin.from('school_settings').upsert({ school_id: school.id, campus_emergency_lock: turnOn, updated_at: new Date().toISOString() }, { onConflict: 'school_id' })
  if (q.error) throw q.error
  let cleared = 0
  if (turnOn) {
    const roomIds = await schoolRoomIds(admin, school.id)
    if (roomIds.length) {
      const { data: waiting, error } = await admin.from('waiting_requests').select('id').in('room_id', roomIds).eq('status', 'WAITING')
      if (error) throw error
      const ids = (waiting || []).map(x => x.id)
      if (ids.length) {
        cleared = ids.length
        const u = await admin.from('waiting_requests').update({ status: 'CANCELLED', cancelled_by: 'System', cancelled_at: new Date().toISOString() }).in('id', ids)
        if (u.error) throw u.error
      }
    }
  }
  await writeAudit(admin, authTeacher.id, turnOn ? 'ADMIN_CAMPUS_LOCK_ON' : 'ADMIN_CAMPUS_LOCK_OFF', null, { clearedWaiting: cleared }, school.id)
  return { success: true, message: turnOn ? `${school.name} Emergency Lock enabled. ${cleared} waiting request${cleared === 1 ? '' : 's'} cleared.` : `${school.name} Emergency Lock disabled.` }
}


/* ===== Hall Pilot 1.15: admin-only room scheduling ===== */
function canonicalDayType(value) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!clean || ['regular', 'primary'].includes(normalize(clean))) return ''
  return clean
}

function validDayDate(value) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ''
  const parsed = new Date(text + 'T12:00:00Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : ''
}

async function adminRoomSchedulingState(admin, school) {
  const [roomsQ, masterQ, exceptionQ, legacyQ, settings] = await Promise.all([
    admin.from('rooms').select('id,room_key,room_name,active').eq('school_id', school.id).order('room_name'),
    admin.from('master_schedules').select('schedule_name').eq('school_id', school.id).order('schedule_name'),
    admin.from('school_day_exceptions').select('calendar_date,day_type,note,active').eq('school_id', school.id).order('calendar_date', { ascending: true }).limit(1000),
    admin.from('school_calendar').select('calendar_date,schedule_name,note,active').eq('school_id', school.id).eq('active', true).limit(1000),
    getSchoolSettings(admin, school.id)
  ])
  for (const q of [roomsQ, masterQ, exceptionQ, legacyQ]) if (q.error) throw q.error
  const roomRows = roomsQ.data || []
  const roomIds = roomRows.map(x => x.id)
  const [settingsQ, assignmentsQ] = await Promise.all([
    roomIds.length ? admin.from('room_settings').select('room_id,schedule_mode').in('room_id', roomIds) : Promise.resolve({ data: [], error: null }),
    roomIds.length ? admin.from('room_schedule_assignments').select('room_id,day_type,schedule_name').in('room_id', roomIds) : Promise.resolve({ data: [], error: null })
  ])
  if (settingsQ.error) throw settingsQ.error
  if (assignmentsQ.error) throw assignmentsQ.error
  const roomDefaults = new Map((settingsQ.data || []).map(x => [String(x.room_id), x.schedule_mode || 'Regular']))
  const today = localDateKey(new Date(), school.timezone || 'America/Los_Angeles')
  return {
    success: true,
    enabled: settings.room_scheduling_enabled === true,
    autoEnabled: settings.auto_scheduling_enabled !== false,
    rooms: roomRows.map(x => ({ id: x.id, key: x.room_key, name: x.room_name, active: x.active !== false, defaultSchedule: roomDefaults.get(String(x.id)) || 'Regular' })),
    schedules: [...new Set((masterQ.data || []).map(x => x.schedule_name))].sort((a, b) => a.localeCompare(b)),
    assignments: (assignmentsQ.data || []).map(x => ({ roomId: x.room_id, dayType: x.day_type, schedule: x.schedule_name })),
    exceptions: (exceptionQ.data || []).map(x => ({ date: x.calendar_date, dayType: x.day_type, note: x.note || '', active: x.active !== false })),
    legacyFutureCount: (legacyQ.data || []).filter(x => x.calendar_date >= today).length,
    legacyDates: (legacyQ.data || []).filter(x => x.calendar_date >= today).map(x => ({ date: x.calendar_date, schedule: x.schedule_name, note: x.note || '' }))
  }
}

async function adminAssignRoomSchedules(admin, authTeacher, school, data = {}) {
  const roomIds = [...new Set((Array.isArray(data.roomIds) ? data.roomIds : []).map(x => String(x || '').trim()).filter(Boolean))]
  const rawType = String(data.dayType || '').trim()
  const isPrimary = ['regular', 'primary'].includes(normalize(rawType))
  const dayType = isPrimary ? 'Regular' : canonicalDayType(rawType)
  if (!dayType) return fail('Choose a valid day type.')
  if (!roomIds.length || roomIds.length > 250) return fail('Select between 1 and 250 classrooms.')
  const canonical = await masterScheduleName(admin, school, String(data.schedule || '').trim())
  if (!canonical) return fail('Choose an existing master bell schedule.')
  const rq = await admin.from('rooms').select('id').eq('school_id', school.id).eq('active', true).in('id', roomIds)
  if (rq.error) throw rq.error
  if ((rq.data || []).length !== roomIds.length) return fail('One or more selected classrooms are not active in this school.')
  const roomMode = await getSchoolSettings(admin, school.id)
  if (roomMode.room_scheduling_enabled === true && await hasSchoolTraffic(admin, roomIds))
    return fail('Wait until these rooms have no active passes or waiting requests before changing live schedule assignments.')
  const now = new Date().toISOString()
  if (isPrimary) {
    const q = await admin.from('room_settings').update({ schedule_mode: canonical, updated_at: now }).in('room_id', roomIds)
    if (q.error) throw q.error
  } else {
    const q = await admin.from('room_schedule_assignments').upsert(
      roomIds.map(room_id => ({ room_id, day_type: dayType, schedule_name: canonical, updated_at: now })),
      { onConflict: 'room_id,day_type' }
    )
    if (q.error) throw q.error
  }
  await writeAudit(admin, authTeacher.id, 'ADMIN_ASSIGN_ROOM_SCHEDULES', null, { rooms: roomIds, dayType, schedule: canonical }, school.id)
  return { success: true, message: canonical + ' assigned to ' + roomIds.length + ' room(s) for ' + (isPrimary ? 'Primary' : dayType) + '.' }
}

async function hasSchoolTraffic(admin, roomIds) {
  if (!roomIds.length) return false
  const [out, waiting] = await Promise.all([
    admin.from('passes').select('id').in('room_id', roomIds).is('return_at', null).limit(1),
    admin.from('waiting_requests').select('id').in('room_id', roomIds).eq('status', 'WAITING').limit(1)
  ])
  if (out.error) throw out.error
  if (waiting.error) throw waiting.error
  return Boolean(out.data?.length || waiting.data?.length)
}

async function adminSetRoomSchedulingEnabled(admin, authTeacher, school, data = {}) {
  if (typeof data.enabled !== 'boolean') return fail('Choose On or Off.')
  const status = await adminRoomSchedulingState(admin, school)
  if (status.enabled === data.enabled) return { success: true, enabled: data.enabled, message: 'Room scheduling is already ' + (data.enabled ? 'on.' : 'off.') }
  const activeRooms = status.rooms.filter(x => x.active)
  if (!activeRooms.length) return fail('Create an active classroom first.')
  if (await hasSchoolTraffic(admin, activeRooms.map(x => x.id))) return fail('Wait until all students are back and waiting lists are empty before changing the scheduling mode.')
  if (data.enabled) {
    const available = new Set(status.schedules.map(x => normalize(x)))
    const invalidDefaults = activeRooms.filter(x => !available.has(normalize(x.defaultSchedule)))
    if (invalidDefaults.length) return fail('Default schedule missing for: ' + invalidDefaults.map(x => x.name).join(', '))
    const today = localDateKey(new Date(), school.timezone || 'America/Los_Angeles')
    const exceptions = status.exceptions.filter(x => x.active && x.date >= today)
    for (const exception of exceptions) {
      const missing = activeRooms.filter(room => !status.assignments.some(x => String(x.roomId) === String(room.id) && normalize(x.dayType) === normalize(exception.dayType) && available.has(normalize(x.schedule))))
      if (missing.length) return fail(exception.date + ' (' + exception.dayType + ') is not configured in: ' + missing.map(x => x.name).join(', '))
    }
    if (status.legacyFutureCount && data.acknowledgeLegacyCalendar !== true)
      return fail('There are ' + status.legacyFutureCount + ' future dates in the old calendar. Review them, then explicitly acknowledge that room scheduling uses only the new special-day calendar.')
  }
  const q = await admin.from('school_settings').upsert({ school_id: school.id, room_scheduling_enabled: data.enabled, updated_at: new Date().toISOString() }, { onConflict: 'school_id' })
  if (q.error) throw q.error
  await writeAudit(admin, authTeacher.id, 'ADMIN_ROOM_SCHEDULING_MODE', null, { enabled: data.enabled, legacyFutureCount: status.legacyFutureCount }, school.id)
  return { success: true, enabled: data.enabled, message: 'Room scheduling ' + (data.enabled ? 'enabled.' : 'disabled; original calendar restored.') }
}

async function adminSaveDayExceptions(admin, authTeacher, school, data = {}) {
  const dayType = canonicalDayType(data.dayType)
  if (!dayType) return fail('Choose a special day type (not Primary).')
  const dates = [...new Set((Array.isArray(data.dates) ? data.dates : [data.date]).map(validDayDate))].sort()
  if (!dates.length || dates.includes('') || dates.length > 250) return fail('Enter 1–250 valid calendar dates.')
  const status = await adminRoomSchedulingState(admin, school)
  const rooms = status.rooms.filter(x => x.active)
  const missing = rooms.filter(room => !status.assignments.some(x => String(x.roomId) === String(room.id) && normalize(x.dayType) === normalize(dayType) && status.schedules.some(s => normalize(s) === normalize(x.schedule))))
  if (missing.length) return fail('Assign ' + dayType + ' to all active rooms first. Missing: ' + missing.map(x => x.name).join(', '))
  const today = localDateKey(new Date(), school.timezone || 'America/Los_Angeles')
  if (dates.includes(today) && status.enabled && await hasSchoolTraffic(admin, rooms.map(x => x.id)))
    return fail('Cannot change today’s schedule while students are out or waiting. Choose a future day or wait until the campus is clear.')
  const note = String(data.note || '').replace(/\s+/g, ' ').trim().slice(0, 250)
  const replace = normalize(data.conflictMode) === 'replace'
  const old = await admin.from('school_day_exceptions').select('calendar_date').eq('school_id', school.id).in('calendar_date', dates)
  if (old.error) throw old.error
  const already = new Set((old.data || []).map(x => x.calendar_date))
  const targetDates = replace ? dates : dates.filter(x => !already.has(x))
  if (targetDates.length) {
    const rows = targetDates.map(calendar_date => ({ school_id: school.id, calendar_date, day_type: dayType, note, active: true, updated_at: new Date().toISOString() }))
    const q = await admin.from('school_day_exceptions').upsert(rows, { onConflict: 'school_id,calendar_date' })
    if (q.error) throw q.error
  }
  const skipped = dates.length - targetDates.length
  await writeAudit(admin, authTeacher.id, 'ADMIN_SAVE_SPECIAL_DAYS', null, { dates: targetDates, dayType, replaced: replace }, school.id)
  return { success: true, added: targetDates.length, skipped, message: targetDates.length + ' special day(s) saved' + (skipped ? '; ' + skipped + ' existing dates skipped.' : '.') }
}

async function adminDeleteDayException(admin, authTeacher, school, date) {
  const valid = validDayDate(date)
  if (!valid) return fail('Choose a valid date.')
  const today = localDateKey(new Date(), school.timezone || 'America/Los_Angeles')
  const mode = await getSchoolSettings(admin, school.id)
  if (valid === today && mode.room_scheduling_enabled === true) {
    const roomIds = await schoolRoomIds(admin, school.id)
    if (await hasSchoolTraffic(admin, roomIds)) return fail('Cannot change today’s special schedule while students are out or waiting.')
  }
  const q = await admin.from('school_day_exceptions').delete().eq('school_id', school.id).eq('calendar_date', valid)
  if (q.error) throw q.error
  await writeAudit(admin, authTeacher.id, 'ADMIN_DELETE_SPECIAL_DAY', null, { date: valid }, school.id)
  return { success: true, message: 'Special-day exception removed for ' + valid + '.' }
}

async function adminCalendarState(admin, school) {
  const [calendarQ, settings] = await Promise.all([
    admin.from('school_calendar').select('calendar_date,schedule_name,note,active,batch_id,batch_label,created_at,updated_at').eq('school_id', school.id).order('calendar_date', { ascending: true }).limit(1000),
    getSchoolSettings(admin, school.id)
  ])
  if (calendarQ.error) throw calendarQ.error
  return {
    success: true,
    autoSchedulingEnabled: settings.auto_scheduling_enabled !== false,
    roomSchedulingEnabled: settings.room_scheduling_enabled === true,
    rows: (calendarQ.data || []).map(x => ({ date: x.calendar_date, schedule: x.schedule_name, note: x.note || '', active: x.active !== false, batchId: x.batch_id || '', batchLabel: x.batch_label || '' }))
  }
}

async function adminSetCalendarAutoScheduling(admin, authTeacher, school, data = {}) {
  if (typeof data.enabled !== 'boolean') return fail('Choose On or Off for automatic scheduling.')
  const { data: updated, error } = await admin.from('school_settings')
    .upsert({ school_id: school.id, auto_scheduling_enabled: data.enabled, updated_at: new Date().toISOString() }, { onConflict: 'school_id' })
    .select('auto_scheduling_enabled').single()
  if (error) throw error
  await writeAudit(admin, authTeacher.id, data.enabled ? 'ADMIN_CALENDAR_AUTO_ON' : 'ADMIN_CALENDAR_AUTO_OFF', null, { autoSchedulingEnabled: data.enabled }, school.id)
  return { success: true, autoSchedulingEnabled: updated.auto_scheduling_enabled, message: data.enabled ? 'Automatic calendar scheduling enabled for this school.' : 'Automatic calendar scheduling disabled for this school.' }
}

async function masterScheduleName(admin, school, schedule) {
  const { data, error } = await admin.from('master_schedules').select('schedule_name').eq('school_id', school.id).ilike('schedule_name', schedule).limit(1)
  if (error) throw error
  return data?.[0]?.schedule_name || ''
}

async function adminSaveCalendarEntry(admin, authTeacher, school, data = {}) {
  if ((await getSchoolSettings(admin, school.id)).room_scheduling_enabled === true)
    return fail('Original calendar edits are disabled while Room Scheduling is on. Use Special-Day Calendar instead.')
  const date = String(data.date || '').trim(); const schedule = String(data.schedule || '').trim()
  const note = String(data.note || '').replace(/\s+/g, ' ').trim().slice(0, 250)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Choose a valid calendar date.')
  if (!schedule) return fail('Choose a schedule.')
  const canonical = await masterScheduleName(admin, school, schedule)
  if (!canonical) return fail('That master schedule does not exist at this school.')
  const q = await admin.from('school_calendar').upsert({ school_id: school.id, calendar_date: date, schedule_name: canonical, note, active: data.active !== false, batch_id: null, batch_label: null, updated_at: new Date().toISOString() }, { onConflict: 'school_id,calendar_date' })
  if (q.error) throw q.error
  await writeAudit(admin, authTeacher.id, 'ADMIN_SAVE_CALENDAR_SCHEDULE', null, { date, schedule: canonical, note }, school.id)
  return { success: true, message: `${date} set to ${canonical}.` }
}

async function adminDeleteCalendarEntry(admin, authTeacher, school, date) {
  if ((await getSchoolSettings(admin, school.id)).room_scheduling_enabled === true)
    return fail('Original calendar edits are disabled while Room Scheduling is on. Use Special-Day Calendar instead.')
  date = String(date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Calendar date not found.')
  const q = await admin.from('school_calendar').delete().eq('school_id', school.id).eq('calendar_date', date)
  if (q.error) throw q.error
  await writeAudit(admin, authTeacher.id, 'ADMIN_DELETE_CALENDAR_SCHEDULE', null, { date }, school.id)
  return { success: true, message: `${date} calendar override removed.` }
}

async function adminSaveCalendarBatch(admin, authTeacher, school, data = {}) {
  if ((await getSchoolSettings(admin, school.id)).room_scheduling_enabled === true)
    return fail('Original calendar edits are disabled while Room Scheduling is on. Use Special-Day Calendar instead.')
  const schedule = String(data.schedule || '').trim()
  const note = String(data.note || '').replace(/\s+/g, ' ').trim().slice(0, 250)
  const conflictMode = String(data.conflictMode || 'skip').toLowerCase() === 'replace' ? 'replace' : 'skip'
  const label = String(data.label || '').replace(/\s+/g, ' ').trim().slice(0, 140)
  const dates = Array.from(new Set((Array.isArray(data.dates) ? data.dates : []).map(x => String(x || '').trim()))).sort()
  if (!schedule) return fail('Choose a schedule.')
  if (!dates.length) return fail('Choose at least one calendar date.')
  if (dates.length > 250) return fail('A calendar batch can contain at most 250 dates.')
  if (dates.some(x => !/^\d{4}-\d{2}-\d{2}$/.test(x))) return fail('One or more calendar dates are invalid.')
  const canonical = await masterScheduleName(admin, school, schedule)
  if (!canonical) return fail('That master schedule does not exist at this school.')
  const existingQ = await admin.from('school_calendar').select('calendar_date').eq('school_id', school.id).in('calendar_date', dates)
  if (existingQ.error) throw existingQ.error
  const existing = new Set((existingQ.data || []).map(x => x.calendar_date))
  const targetDates = conflictMode === 'replace' ? dates : dates.filter(x => !existing.has(x))
  const skipped = conflictMode === 'skip' ? dates.length - targetDates.length : 0
  if (!targetDates.length) return { success: true, message: `No dates added. ${skipped} existing date${skipped === 1 ? ' was' : 's were'} skipped.`, added: 0, replaced: 0, skipped }
  const batchId = crypto.randomUUID(); const now = new Date().toISOString(); const batchLabel = label || `${canonical} repeat batch`
  const rows = targetDates.map(calendar_date => ({ school_id: school.id, calendar_date, schedule_name: canonical, note, active: true, batch_id: batchId, batch_label: batchLabel, updated_at: now }))
  const q = await admin.from('school_calendar').upsert(rows, { onConflict: 'school_id,calendar_date' })
  if (q.error) throw q.error
  const replaced = conflictMode === 'replace' ? targetDates.filter(x => existing.has(x)).length : 0
  const added = targetDates.length - replaced
  await writeAudit(admin, authTeacher.id, 'ADMIN_SAVE_CALENDAR_BATCH', null, { batchId, batchLabel, schedule: canonical, dates: targetDates, added, replaced, skipped, conflictMode }, school.id)
  const parts = [`${added} date${added === 1 ? '' : 's'} added`]
  if (replaced) parts.push(`${replaced} replaced`); if (skipped) parts.push(`${skipped} skipped`)
  return { success: true, message: parts.join(' • ') + '.', batchId, added, replaced, skipped }
}

async function adminDeleteCalendarBatch(admin, authTeacher, school, batchId) {
  if ((await getSchoolSettings(admin, school.id)).room_scheduling_enabled === true)
    return fail('Original calendar edits are disabled while Room Scheduling is on. Use Special-Day Calendar instead.')
  batchId = String(batchId || '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchId)) return fail('Calendar batch not found.')
  const existing = await admin.from('school_calendar').select('calendar_date,batch_label').eq('school_id', school.id).eq('batch_id', batchId)
  if (existing.error) throw existing.error
  if (!existing.data?.length) return fail('Calendar batch not found.')
  const q = await admin.from('school_calendar').delete().eq('school_id', school.id).eq('batch_id', batchId)
  if (q.error) throw q.error
  const label = existing.data[0].batch_label || 'Repeat batch'
  await writeAudit(admin, authTeacher.id, 'ADMIN_DELETE_CALENDAR_BATCH', null, { batchId, batchLabel: label, dates: existing.data.map(x => x.calendar_date) }, school.id)
  return { success: true, message: `${existing.data.length} date${existing.data.length === 1 ? '' : 's'} removed from ${label}.` }
}

async function adminAuditLog(admin, school, options = {}) {
  const limit = clampNumber(options.limit, 10, 500, 200)
  let query = admin.from('audit_log').select('id,action,details,created_at,teachers(name),rooms(room_key,room_name)').eq('school_id', school.id).order('created_at', { ascending: false }).limit(limit)
  const roomKey = cleanRoomKey(options.roomKey || '')
  if (roomKey) {
    const { data: room, error: roomError } = await admin.from('rooms').select('id').eq('school_id', school.id).eq('room_key', roomKey).maybeSingle()
    if (roomError) throw roomError
    if (!room) return fail('Room not found.')
    query = query.eq('room_id', room.id)
  }
  const { data, error } = await query
  if (error) throw error
  const search = normalize(options.search || '')
  const rows = (data || []).map(x => ({ id: x.id, action: x.action, createdAt: x.created_at, teacher: x.teachers?.name || 'System', roomKey: x.rooms?.room_key || '', room: x.rooms?.room_name || '', details: x.details || {} }))
    .filter(x => !search || normalize([x.action, x.teacher, x.roomKey, x.room, JSON.stringify(x.details)].join(' ')).includes(search))
  return { success: true, rows }
}

// ============================================================
// V1.14.1 — School-scoped reporting and safe backup/export helpers
// ============================================================
async function fetchPaged(makeQuery, pageSize = 1000, maxRows = 100000) {
  const rows = []
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1)
    if (error) throw error
    const batch = data || []; rows.push(...batch)
    if (batch.length < pageSize) break
  }
  return rows
}

function validDateKey(value) { const text = String(value || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '' }
function safeReportDates(options = {}) {
  const today = new Date().toISOString().slice(0, 10)
  let endDate = validDateKey(options.endDate) || today
  let startDate = validDateKey(options.startDate) || (() => { const d = new Date(endDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 29); return d.toISOString().slice(0, 10) })()
  if (startDate > endDate) [startDate, endDate] = [endDate, startDate]
  return { startDate, endDate }
}
function passDurationMinutes(pass) {
  if (!pass.return_at) return null
  const ms = new Date(pass.return_at).getTime() - new Date(pass.leave_at).getTime()
  return Number.isFinite(ms) && ms >= 0 ? ms / 60000 : null
}

async function adminDestinationsState(admin, school) {
  const { data, error } = await admin.from('destination_catalog').select('id,name,enabled_schoolwide,counts_as_hall_pass,teacher_approval,default_max_out,sort_order,created_at,updated_at').eq('school_id', school.id).order('sort_order').order('name')
  if (error) throw error
  return { success: true, rows: (data || []).map(x => ({ id: x.id, name: x.name, enabled: x.enabled_schoolwide !== false, countsAsHallPass: x.counts_as_hall_pass !== false, teacherApproval: x.teacher_approval === true, defaultMaxOut: Number(x.default_max_out || 0), sortOrder: Number(x.sort_order || 0), createdAt: x.created_at, updatedAt: x.updated_at })) }
}

async function addCatalogDestinationToAllRooms(admin, school, catalog) {
  const { data: rooms, error: roomError } = await admin.from('rooms').select('id').eq('school_id', school.id)
  if (roomError) throw roomError
  if (!(rooms || []).length) return
  const rows = (rooms || []).map(r => ({ room_id: r.id, catalog_id: catalog.id, room_enabled: true, max_out_override: null, name: catalog.name, enabled: catalog.enabled_schoolwide !== false, max_out: Number(catalog.default_max_out || 0), max_per_day: 0, teacher_approval: catalog.teacher_approval === true, counts_as_hall_pass: catalog.counts_as_hall_pass !== false, sort_order: Number(catalog.sort_order || 0) }))
  const { error } = await admin.from('destinations').insert(rows)
  if (error) throw error
}

async function adminSaveMasterDestination(admin, authTeacher, school, id, data) {
  id = String(id || '').trim(); data = data || {}
  const name = String(data.name || '').replace(/\s+/g,' ').trim().substring(0,120)
  if (!name) return fail('Destination name is required.')
  const patch = { name, enabled_schoolwide: data.enabled !== false, counts_as_hall_pass: data.countsAsHallPass === true, teacher_approval: data.teacherApproval === true, default_max_out: Math.max(0, Math.round(Number(data.defaultMaxOut) || 0)), sort_order: Math.max(0, Math.round(Number(data.sortOrder) || 0)) }
  if (id) {
    const { data: saved, error } = await admin.from('destination_catalog').update(patch).eq('school_id', school.id).eq('id', id).select('*').maybeSingle()
    if (error) { if (error.code === '23505') return fail('A destination with that name already exists at this school.'); throw error }
    if (!saved) return fail('Destination not found.')
    await writeAudit(admin, authTeacher.id, 'ADMIN_UPDATE_DESTINATION', null, { destinationId:id, patch }, school.id)
    return { success:true, message:`${saved.name} updated.` }
  }
  const { data: saved, error } = await admin.from('destination_catalog').insert({ school_id: school.id, ...patch }).select('*').single()
  if (error) { if (error.code === '23505') return fail('A destination with that name already exists at this school.'); throw error }
  await addCatalogDestinationToAllRooms(admin, school, saved)
  await writeAudit(admin, authTeacher.id, 'ADMIN_CREATE_DESTINATION', null, { destinationId:saved.id, name:saved.name }, school.id)
  return { success:true, message:`${saved.name} added to the master destination list.` }
}

async function adminReportOptions(admin, school) {
  const [roomsQ, studentsQ, destinationsQ] = await Promise.all([
    admin.from('rooms').select('id,room_key,room_name,timezone,active').eq('school_id', school.id).order('room_name'),
    admin.from('students').select('id,student_number,name,active').eq('school_id', school.id).order('name'),
    admin.from('destination_catalog').select('name').eq('school_id', school.id).order('sort_order').order('name')
  ])
  if (roomsQ.error) throw roomsQ.error; if (studentsQ.error) throw studentsQ.error; if (destinationsQ.error) throw destinationsQ.error
  const destinationNames = [...new Set((destinationsQ.data || []).map(x => String(x.name || '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b))
  return { success: true, rooms: (roomsQ.data || []).map(r => ({ id:r.id, key:r.room_key, room:r.room_name, timezone:r.timezone, active:r.active !== false })), students: (studentsQ.data || []).map(s => ({ uuid:s.id, id:String(s.student_number), name:s.name, active:s.active !== false })), destinations: destinationNames }
}

async function adminCampusReport(admin, school, options = {}) {
  const { startDate, endDate } = safeReportDates(options)
  const includeTestData = options.includeTestData === true
  const roomKey = cleanRoomKey(options.roomKey || '')
  const studentNumber = String(options.studentId || '').trim()
  const detailRequested = options.studentDetail === true
  if (detailRequested && !studentNumber) return fail('Choose a student for the detailed report.')
  let detailStudent = null
  if (detailRequested) {
    const { data, error } = await admin.from('students')
      .select('student_number,name').eq('school_id', school.id)
      .eq('student_number', studentNumber).maybeSingle()
    if (error) throw error
    if (!data) return fail('Student not found at this school.')
    detailStudent = { studentId: String(data.student_number), studentName: data.name }
  }
  const destination = String(options.destination || '').trim()
  const longMinutes = clampNumber(options.longMinutes, 1, 240, 10)
  const frequentCount = clampNumber(options.frequentCount, 1, 1000, 5)
  const [roomsQ, teachersQ] = await Promise.all([
    admin.from('rooms').select('id,room_key,room_name,timezone,active').eq('school_id', school.id).order('room_name'),
    admin.from('teachers').select('id,name').eq('organization_id', school.organization_id).order('name')
  ])
  if (roomsQ.error) throw roomsQ.error; if (teachersQ.error) throw teachersQ.error
  const schoolRooms = roomsQ.data || []; const roomIds = schoolRooms.map(r => r.id)
  const roomMap = new Map(schoolRooms.map(r => [String(r.id), r])); const teacherMap = new Map((teachersQ.data || []).map(t => [String(t.id), t.name]))
  const selectedRoom = roomKey ? schoolRooms.find(r => r.room_key === roomKey) : null
  if (roomKey && !selectedRoom) return fail('Room not found.')
  if (!roomIds.length) return { success:true, filters:{startDate,endDate,roomKey,studentId:studentNumber,destination,includeTestData,longMinutes,frequentCount}, summary:{totalPasses:0,completedPasses:0,averageMinutes:0,longestMinutes:0,totalMinutes:0,overrides:0}, byRoom:[],byDestination:[],byStudent:[],longPasses:[],frequentStudents:[],overrides:[],studentDetail:detailRequested ? { ...detailStudent, rows:[] } : null }
  const broadStart = new Date(startDate + 'T00:00:00Z'); broadStart.setUTCDate(broadStart.getUTCDate() - 1)
  const broadEnd = new Date(endDate + 'T23:59:59Z'); broadEnd.setUTCDate(broadEnd.getUTCDate() + 1)
  const raw = await fetchPaged(() => {
    let q = admin.from('passes').select('id,room_id,student_id,destination_name,requested_at,leave_at,return_at,schedule_name,period,wait_seconds,status_note,test_data,counts_as_hall_pass,teacher_override,override_note,created_by_teacher_id,students!inner(student_number,name)').in('room_id', selectedRoom ? [selectedRoom.id] : roomIds).gte('leave_at', broadStart.toISOString()).lte('leave_at', broadEnd.toISOString()).order('leave_at', { ascending: false })
    if (studentNumber) q = q.eq('students.student_number', studentNumber)
    if (destination) q = q.ilike('destination_name', destination)
    if (!includeTestData) q = q.eq('test_data', false)
    return q
  })
  const passes = raw.map(p => {
    const room = roomMap.get(String(p.room_id)); if (!room) return null
    const date = localDateKey(new Date(p.leave_at), room.timezone || school.timezone || 'America/Los_Angeles')
    if (date < startDate || date > endDate) return null
    const durationMinutes = passDurationMinutes(p)
    return { passId:p.id,date,roomKey:room.room_key,room:room.room_name,studentId:String(p.students?.student_number || ''),studentName:p.students?.name || '',destination:p.destination_name,schedule:p.schedule_name,period:p.period || '',requested:p.requested_at,left:p.leave_at,returned:p.return_at || '',durationMinutes,waitSeconds:Number(p.wait_seconds || 0),teacherOverride:Boolean(p.teacher_override),overrideNote:p.override_note || '',statusNote:p.status_note || '',teacher:p.created_by_teacher_id ? (teacherMap.get(String(p.created_by_teacher_id)) || '') : '',testData:Boolean(p.test_data) }
  }).filter(Boolean)
  const byRoom = new Map(), byDestination = new Map(), byStudent = new Map(); let completed = 0, totalMinutes = 0, longestMinutes = 0, overrideCount = 0
  for (const p of passes) {
    const room = byRoom.get(p.roomKey) || { roomKey:p.roomKey, room:p.room, totalPasses:0, completedPasses:0, totalMinutes:0, longestMinutes:0, overrides:0 }; room.totalPasses++
    if (p.teacherOverride) { room.overrides++; overrideCount++ }
    if (Number.isFinite(p.durationMinutes)) { room.completedPasses++; room.totalMinutes += p.durationMinutes; room.longestMinutes = Math.max(room.longestMinutes, p.durationMinutes); completed++; totalMinutes += p.durationMinutes; longestMinutes = Math.max(longestMinutes, p.durationMinutes) }
    byRoom.set(p.roomKey, room)
    const destKey = normalize(p.destination); const dest = byDestination.get(destKey) || { destination:p.destination, totalPasses:0, completedPasses:0, totalMinutes:0, longestMinutes:0 }; dest.totalPasses++
    if (Number.isFinite(p.durationMinutes)) { dest.completedPasses++; dest.totalMinutes += p.durationMinutes; dest.longestMinutes = Math.max(dest.longestMinutes, p.durationMinutes) }; byDestination.set(destKey, dest)
    const studentKey = p.studentId; const stu = byStudent.get(studentKey) || { studentId:p.studentId, studentName:p.studentName, totalPasses:0, restroomPasses:0, completedPasses:0, totalMinutes:0, longestMinutes:0, overrides:0, rooms:new Set() }; stu.totalPasses++; stu.rooms.add(p.roomKey)
    if (normalize(p.destination) === 'restroom') stu.restroomPasses++; if (p.teacherOverride) stu.overrides++
    if (Number.isFinite(p.durationMinutes)) { stu.completedPasses++; stu.totalMinutes += p.durationMinutes; stu.longestMinutes = Math.max(stu.longestMinutes, p.durationMinutes) }; byStudent.set(studentKey, stu)
  }
  const roomRows = [...byRoom.values()].map(x => ({ ...x, averageMinutes:x.completedPasses ? x.totalMinutes/x.completedPasses : 0 })).sort((a,b)=>a.room.localeCompare(b.room))
  const destinationRows = [...byDestination.values()].map(x => ({ ...x, averageMinutes:x.completedPasses ? x.totalMinutes/x.completedPasses : 0 })).sort((a,b)=>b.totalPasses-a.totalPasses || a.destination.localeCompare(b.destination))
  const studentRows = [...byStudent.values()].map(x => ({ ...x, rooms:[...x.rooms].sort().join(', '), averageMinutes:x.completedPasses ? x.totalMinutes/x.completedPasses : 0 })).sort((a,b)=>b.totalPasses-a.totalPasses || a.studentName.localeCompare(b.studentName))
  return { success:true, filters:{startDate,endDate,roomKey,studentId:studentNumber,destination,includeTestData,longMinutes,frequentCount}, summary:{totalPasses:passes.length,completedPasses:completed,averageMinutes:completed ? totalMinutes/completed : 0,longestMinutes,totalMinutes,overrides:overrideCount}, byRoom:roomRows, byDestination:destinationRows, byStudent:studentRows, longPasses:passes.filter(p => Number.isFinite(p.durationMinutes) && p.durationMinutes >= longMinutes).sort((a,b)=>b.durationMinutes-a.durationMinutes), frequentStudents:studentRows.filter(x => x.totalPasses >= frequentCount), overrides:passes.filter(p => p.teacherOverride),
    studentDetail:detailRequested ? { ...detailStudent,
      rows:passes.filter(p => p.studentId === studentNumber).map(p => ({
        passId:p.passId,date:p.date,roomKey:p.roomKey,room:p.room,schedule:p.schedule,
        period:p.period,destination:p.destination,requested:p.requested,left:p.left,
        returned:p.returned,durationMinutes:p.durationMinutes,waitSeconds:p.waitSeconds,
        teacherOverride:p.teacherOverride,teacher:p.teacher,overrideNote:p.overrideNote,
        statusNote:p.statusNote,testData:p.testData
      }))
    } : null }
}

async function backupStudents(admin, school) {
  return fetchPaged(() => admin.from('students').select('id,student_number,name,restroom_allowed,active,created_at,updated_at').eq('school_id', school.id).order('student_number'))
}

async function backupPasses(admin, school) {
  const [roomsQ, teachersQ] = await Promise.all([admin.from('rooms').select('id,room_key,room_name').eq('school_id', school.id), admin.from('teachers').select('id,name').eq('organization_id', school.organization_id)])
  if (roomsQ.error) throw roomsQ.error; if (teachersQ.error) throw teachersQ.error
  const roomMap = new Map((roomsQ.data || []).map(x=>[String(x.id),x])); const roomIds = [...roomMap.keys()]; const teacherMap = new Map((teachersQ.data || []).map(x=>[String(x.id),x.name]))
  if (!roomIds.length) return []
  const rows = await fetchPaged(() => admin.from('passes').select('id,room_id,student_id,destination_id,destination_name,requested_at,leave_at,return_at,schedule_name,period,wait_seconds,status_note,test_data,counts_as_hall_pass,teacher_override,override_note,created_by_teacher_id,created_at,students!inner(student_number,name)').in('room_id', roomIds).order('leave_at', { ascending:true }))
  return rows.map(p => ({ pass_id:p.id,room_key:roomMap.get(String(p.room_id))?.room_key || '',room_name:roomMap.get(String(p.room_id))?.room_name || '',student_id:String(p.students?.student_number || ''),student_name:p.students?.name || '',destination:p.destination_name,requested_at:p.requested_at,leave_at:p.leave_at,return_at:p.return_at || '',duration_minutes:passDurationMinutes(p),schedule:p.schedule_name,period:p.period || '',wait_seconds:Number(p.wait_seconds || 0),status_note:p.status_note || '',test_data:Boolean(p.test_data),counts_as_hall_pass:Boolean(p.counts_as_hall_pass),teacher_override:Boolean(p.teacher_override),override_note:p.override_note || '',created_by_teacher:p.created_by_teacher_id ? (teacherMap.get(String(p.created_by_teacher_id)) || '') : '',created_at:p.created_at }))
}

async function backupAudit(admin, school) {
  const rows = await fetchPaged(() => admin.from('audit_log').select('id,room_id,teacher_id,action,details,created_at,teachers(name),rooms(room_key,room_name)').eq('school_id', school.id).order('created_at', { ascending:true }))
  return rows.map(x => ({ id:x.id,created_at:x.created_at,teacher:x.teachers?.name || 'System',room_key:x.rooms?.room_key || '',room_name:x.rooms?.room_name || '',action:x.action,details:x.details || {} }))
}

async function backupConfiguration(admin, school, access) {
  // Fetch the selected school's rooms first, then scope every dependent query to
  // those UUIDs. Staff are fetched only after we know which staff IDs are actually
  // attached to this school.
  const roomsQ = await admin
    .from('rooms')
    .select('id,room_key,room_name,timezone,active,emergency_lock,created_at,updated_at')
    .eq('school_id', school.id)
    .order('room_name')
  if (roomsQ.error) throw roomsQ.error

  const rooms = roomsQ.data || []
  const roomIds = rooms.map(x => x.id)
  const empty = { data: [], error: null }

  const [membershipsQ, catalogQ, schedulesQ, calendarQ, schoolSettingsQ, organizationSettingsQ, linksQ, settingsQ, destinationsQ, overridesQ] = await Promise.all([
    admin.from('teacher_schools').select('teacher_id,school_id,access_level').eq('school_id', school.id),
    admin.from('destination_catalog').select('*').eq('school_id', school.id).order('sort_order').order('name'),
    admin.from('master_schedules').select('*').eq('school_id', school.id).order('schedule_name').order('start_time'),
    admin.from('school_calendar').select('*').eq('school_id', school.id).order('calendar_date'),
    admin.from('school_settings').select('*').eq('school_id', school.id).maybeSingle(),
    admin.from('organization_settings').select('organization_id,pin_max_failures,pin_window_minutes,pin_lock_minutes,updated_at').eq('organization_id', access.organization.id).maybeSingle(),
    roomIds.length ? admin.from('teacher_rooms').select('teacher_id,room_id').in('room_id', roomIds) : Promise.resolve(empty),
    roomIds.length ? admin.from('room_settings').select('*').in('room_id', roomIds) : Promise.resolve(empty),
    roomIds.length ? admin.from('destinations').select('*').in('room_id', roomIds).order('room_id').order('sort_order') : Promise.resolve(empty),
    roomIds.length ? admin.from('room_students').select('room_id,student_id,active,restroom_allowed').in('room_id', roomIds) : Promise.resolve(empty)
  ])

  for (const q of [membershipsQ,catalogQ,schedulesQ,calendarQ,schoolSettingsQ,organizationSettingsQ,linksQ,settingsQ,destinationsQ,overridesQ]) {
    if (q.error) throw q.error
  }

  const schoolLinks = linksQ.data || []
  const schoolTeacherIds = [...new Set([
    ...(membershipsQ.data || []).map(x => String(x.teacher_id)),
    ...schoolLinks.map(x => String(x.teacher_id))
  ])]

  let schoolTeachers = []
  if (schoolTeacherIds.length) {
    const teachersQ = await admin
      .from('teachers')
      .select('id,name,email,role,active,created_at,updated_at')
      .eq('organization_id', access.organization.id)
      .in('id', schoolTeacherIds)
      .order('name')
    if (teachersQ.error) throw teachersQ.error
    schoolTeachers = teachersQ.data || []
  }

  return {
    organization:{id:access.organization.id,key:access.organization.organization_key,name:access.organization.name},
    school:{id:school.id,key:school.school_key,name:school.name,timezone:school.timezone},
    rooms,
    teachers:schoolTeachers,
    teacher_rooms:schoolLinks,
    teacher_schools:membershipsQ.data || [],
    room_settings:settingsQ.data || [],
    destination_catalog:catalogQ.data || [],
    room_destinations:destinationsQ.data || [],
    master_schedules:schedulesQ.data || [],
    school_calendar:calendarQ.data || [],
    school_settings:schoolSettingsQ.data || null,
    organization_settings:organizationSettingsQ.data || null,
    room_student_overrides:overridesQ.data || []
  }
}

async function adminBackupDataset(admin, school, access, dataset) {
  dataset = normalize(dataset)
  if (dataset === 'students') return { success:true, dataset:'students', rows:await backupStudents(admin, school) }
  if (dataset === 'passes') return { success:true, dataset:'passes', rows:await backupPasses(admin, school) }
  if (dataset === 'audit') return { success:true, dataset:'audit', rows:await backupAudit(admin, school) }
  if (dataset === 'configuration') return { success:true, dataset:'configuration', data:await backupConfiguration(admin, school, access) }
  if (dataset === 'full') {
    const roomIds = await schoolRoomIds(admin, school.id)
    const waitingPromise = roomIds.length ? fetchPaged(() => admin.from('waiting_requests').select('id,room_id,student_id,destination_id,requested_at,schedule_name,period,status,leave_at,pass_id,queue_order,cancelled_by,cancelled_at,test_data,created_at').in('room_id', roomIds).order('created_at', { ascending:true })) : Promise.resolve([])
    const [students, passes, audit, configuration, waiting] = await Promise.all([backupStudents(admin, school), backupPasses(admin, school), backupAudit(admin, school), backupConfiguration(admin, school, access), waitingPromise])
    return { success:true, dataset:'full', backup:{ format:'hall-pass-backup', version:'1.14.1', createdAt:new Date().toISOString(), organization:{key:access.organization.organization_key,name:access.organization.name}, school:{key:school.school_key,name:school.name}, securityNote:'PIN hashes, staff sessions, rate-limit fingerprints, and secrets are intentionally excluded.', students, passes, waiting_requests:waiting, audit_log:audit, configuration } }
  }
  return fail('Unknown backup dataset.')
}

async function adminOrganizationState(admin, access) {
  let schools = access.schools || []
  if (access.organizationAdmin === true) {
    const { data, error } = await admin.from('schools').select('id,organization_id,school_key,name,timezone,active').eq('organization_id', access.organization.id).order('name')
    if (error) throw error
    schools = data || []
  }
  return { success:true, organization:{ id:access.organization.id, key:access.organization.organization_key, name:access.organization.name }, organizationAdmin:access.organizationAdmin === true, schools:schools.map(s => ({ id:s.id,key:s.school_key,name:s.name,timezone:s.timezone,active:s.active !== false })) }
}

async function adminCreateSchool(admin, authTeacher, currentSchool, access, data = {}) {
  if (access.organizationAdmin !== true) return fail('Only an Organization Admin can add schools.')
  const key = cleanSchoolKey(data.key); const name = String(data.name || '').replace(/\s+/g,' ').trim(); const timezone = String(data.timezone || 'America/Los_Angeles').trim() || 'America/Los_Angeles'
  if (!key || !/^[a-z0-9_-]+$/.test(key)) return fail('School key may use lowercase letters, numbers, underscores, and hyphens only.')
  if (!name) return fail('School name is required.')
  const q = await admin.from('schools').insert({ organization_id:access.organization.id, school_key:key, name, timezone, active:data.active !== false }).select('id,school_key,name,timezone,active,organization_id').single()
  if (q.error) { if (q.error.code === '23505') return fail('That school key already exists in this organization.'); throw q.error }
  const school = q.data
  try {
    const settingsQ = await admin.from('school_settings').upsert({ school_id:school.id, campus_emergency_lock:false }, { onConflict:'school_id' }); if (settingsQ.error) throw settingsQ.error
    if (data.copyDefaults === true && currentSchool?.id) {
      const [catalogQ, schedulesQ] = await Promise.all([
        admin.from('destination_catalog').select('name,enabled_schoolwide,counts_as_hall_pass,teacher_approval,default_max_out,sort_order').eq('school_id', currentSchool.id),
        admin.from('master_schedules').select('schedule_name,period,start_time,end_time').eq('school_id', currentSchool.id)
      ])
      if (catalogQ.error) throw catalogQ.error; if (schedulesQ.error) throw schedulesQ.error
      if (catalogQ.data?.length) { const c = await admin.from('destination_catalog').insert(catalogQ.data.map(x => ({ school_id:school.id, ...x }))); if (c.error) throw c.error }
      if (schedulesQ.data?.length) { const s = await admin.from('master_schedules').insert(schedulesQ.data.map(x => ({ school_id:school.id, ...x }))); if (s.error) throw s.error }
    }
    await writeAudit(admin, authTeacher.id, 'ADMIN_CREATE_SCHOOL', null, { schoolId:school.id, schoolKey:key, name, copiedDefaults:data.copyDefaults === true }, school.id)
    return { success:true, school:{id:school.id,key:school.school_key,name:school.name,timezone:school.timezone,active:school.active !== false}, message:`${name} created.` }
  } catch (error) {
    await admin.from('schools').delete().eq('id', school.id)
    throw error
  }
}

async function adminUpdateSchool(admin, authTeacher, access, schoolId, data = {}) {
  if (access.organizationAdmin !== true) return fail('Only an Organization Admin can edit schools.')
  schoolId = String(schoolId || '').trim(); if (!schoolId) return fail('School is required.')
  const existingQ = await admin.from('schools').select('id,school_key,name').eq('id',schoolId).eq('organization_id',access.organization.id).maybeSingle()
  if (existingQ.error) throw existingQ.error
  if (!existingQ.data) return fail('School not found.')
  const patch = {}
  if (Object.hasOwn(data,'key')) { const key=cleanSchoolKey(data.key); if (!key || !/^[a-z0-9_-]+$/.test(key)) return fail('School key may use lowercase letters, numbers, underscores, and hyphens only.'); if (key !== cleanSchoolKey(existingQ.data.school_key)) return fail('School key is a permanent URL identifier. Change the school name instead of the school key.') }
  if (Object.hasOwn(data,'name')) { const name=String(data.name || '').replace(/\s+/g,' ').trim(); if (!name) return fail('School name is required.'); patch.name=name }
  if (Object.hasOwn(data,'timezone')) patch.timezone=String(data.timezone || 'America/Los_Angeles').trim() || 'America/Los_Angeles'
  if (Object.hasOwn(data,'active')) patch.active=data.active === true
  patch.updated_at=new Date().toISOString()
  const q=await admin.from('schools').update(patch).eq('id',schoolId).eq('organization_id',access.organization.id).select('id,school_key,name,timezone,active').maybeSingle()
  if (q.error) { if (q.error.code === '23505') return fail('That school key already exists in this organization.'); throw q.error }
  if (!q.data) return fail('School not found.')
  await writeAudit(admin,authTeacher.id,'ADMIN_UPDATE_SCHOOL',null,{schoolId,patch},schoolId)
  return {success:true,school:{id:q.data.id,key:q.data.school_key,name:q.data.name,timezone:q.data.timezone,active:q.data.active !== false},message:`${q.data.name} updated.`}
}

function adminAccessPayload(auth, school) {
  return { admin:{name:auth.teacher.name}, organization:{id:auth.access.organization.id,key:auth.access.organization.organization_key,name:auth.access.organization.name}, schools:(auth.access.schools || []).map(s=>({id:s.id,key:s.school_key,name:s.name,timezone:s.timezone,active:s.active !== false})), selectedSchool:school ? {id:school.id,key:school.school_key,name:school.name,timezone:school.timezone,active:school.active !== false} : null, organizationAdmin:auth.access.organizationAdmin === true }
}

async function adminDashboard(admin, body, fingerprintHash) {
  const args = Array.isArray(body.args) ? body.args : []
  const sessionToken = String(body.sessionToken || '')
  const requestedOrgKey = cleanOrgKey(body.orgKey)
  const requestedSchoolKey = cleanSchoolKey(body.schoolKey)
  let auth
  if (body.action === 'adminLogin') {
    auth = await verifyAdmin(admin, requestedOrgKey, requestedSchoolKey, args[0], sessionToken, fingerprintHash)
    if (!auth.teacher) return auth.locked ? fail(`Too many incorrect Admin PIN attempts. Try again in ${auth.retryMinutes} minute${auth.retryMinutes === 1 ? '' : 's'}.`) : fail(auth.message || 'Incorrect Admin PIN.')
    const school = chooseAdminSchool(auth.access, requestedSchoolKey)
    if (!school) return fail('No active school is assigned to this Admin account.')
    return { success:true, ...adminAccessPayload(auth, school), _teacherSessionToken:auth.newToken || sessionToken }
  }
  auth = await verifyAdmin(admin, requestedOrgKey, requestedSchoolKey, null, sessionToken, fingerprintHash)
  if (!auth.teacher) return fail(auth.message || 'Admin session expired. Please log in again.')

  // Organization-level actions must remain available even when the URL points
  // at a school that has just been disabled or renamed.
  if (body.action === 'adminOrganizationState') return adminOrganizationState(admin, auth.access)
  if (body.action === 'adminUpdateSchool') return adminUpdateSchool(admin, auth.teacher, auth.access, args[0], args[1] || {})
  if (body.action === 'adminCreateSchool') return adminCreateSchool(admin, auth.teacher, chooseAdminSchool(auth.access, requestedSchoolKey), auth.access, args[0] || {})

  const school = chooseAdminSchool(auth.access, requestedSchoolKey)
  if (!school) return fail(requestedSchoolKey ? 'You do not have Admin access to that active school.' : 'No active school is assigned to this Admin account.')
  if (body.action === 'adminManagementState') return adminManagementState(admin, school, auth.access)
  if (body.action === 'adminDestinationsState') return adminDestinationsState(admin, school)
  if (body.action === 'adminSaveMasterDestination') return adminSaveMasterDestination(admin, auth.teacher, school, args[0], args[1] || {})
  if (body.action === 'adminReportOptions') return adminReportOptions(admin, school)
  if (body.action === 'adminCampusReport') return adminCampusReport(admin, school, args[0] || {})
  if (body.action === 'adminBackupDataset') return adminBackupDataset(admin, school, auth.access, args[0])
  if (body.action === 'adminAuditLog') return adminAuditLog(admin, school, args[0] || {})
  if (body.action === 'adminRestrictionsState') return adminRestrictionsState(admin,school)
  if (body.action === 'adminSaveRoomRestriction') return adminSaveRoomRestriction(admin,auth.teacher,school,args[0],args[1],args[2],args[3])
  if (body.action === 'adminRemoveRoomRestriction') return adminRemoveRoomRestriction(admin,auth.teacher,school,args[0],args[1])
  if (body.action === 'adminStudentsState') return adminStudentsState(admin, school, args[0] || {})
  if (body.action === 'adminSaveStudent') return adminSaveStudent(admin, auth.teacher, school, args[0], args[1] || {})
  if (body.action === 'adminImportStudents') return adminImportStudents(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminSecurityState') return adminSecurityState(admin, school, auth.access)
  if (body.action === 'adminUpdateSecurity') return adminUpdateSecurity(admin, auth.teacher, school, auth.access, args[0] || {})
  if (body.action === 'adminClearLockout') return adminClearLockout(admin, auth.teacher, school, auth.access, args[0], args[1])
  if (body.action === 'adminSetCampusLock') return adminSetCampusLock(admin, auth.teacher, school, args[0] === true)
  if (body.action === 'adminRoomSchedulingState') return adminRoomSchedulingState(admin, school)
  if (body.action === 'adminAssignRoomSchedules') return adminAssignRoomSchedules(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminSetRoomSchedulingEnabled') return adminSetRoomSchedulingEnabled(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminSaveDayExceptions') return adminSaveDayExceptions(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminDeleteDayException') return adminDeleteDayException(admin, auth.teacher, school, args[0])
  if (body.action === 'adminCalendarState') return adminCalendarState(admin, school)
  if (body.action === 'adminSetCalendarAutoScheduling') return adminSetCalendarAutoScheduling(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminSaveCalendarEntry') return adminSaveCalendarEntry(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminDeleteCalendarEntry') return adminDeleteCalendarEntry(admin, auth.teacher, school, args[0])
  if (body.action === 'adminSaveCalendarBatch') return adminSaveCalendarBatch(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminDeleteCalendarBatch') return adminDeleteCalendarBatch(admin, auth.teacher, school, args[0])
  if (body.action === 'adminScheduleUsage') return adminScheduleUsage(admin, school, args[0])
  if (body.action === 'adminReplaceDeleteSchedule') return adminReplaceDeleteSchedule(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminManageWholeSchedule') return adminManageWholeSchedule(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminSaveMasterSchedule') return adminSaveMasterSchedule(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminDeleteMasterSchedule') return adminDeleteMasterSchedule(admin, auth.teacher, school, args[0])
  if (body.action === 'adminOnboardingDestinationDefaults') return adminOnboardingDestinationDefaults(admin, school, args[0])
  if (body.action === 'adminOnboardRoom') return adminOnboardRoom(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminCreateRoom') return adminCreateRoom(admin, auth.teacher, school, args[0] || {})
  if (body.action === 'adminUpdateRoom') return adminUpdateRoom(admin, auth.teacher, school, args[0], args[1] || {})
  if (body.action === 'adminDeleteRoom') return adminDeleteRoom(admin, auth.teacher, school, args[0])
  if (body.action === 'adminCloneRoomConfig') return adminCloneRoomConfig(admin, auth.teacher, school, args[0], args[1])
  if (body.action === 'adminCreateTeacher') return adminCreateTeacher(admin, auth.teacher, school, auth.access, args[0] || {})
  if (body.action === 'adminUpdateTeacher') return adminUpdateTeacher(admin, auth.teacher, school, auth.access, args[0], args[1] || {})

  const roomFilter = cleanRoomKey(args[0] || ''); const search = normalize(args[1] || '')
  const { data: rooms, error } = await admin.from('rooms').select('id,room_key,room_name,active,emergency_lock').eq('school_id',school.id).eq('active',true).order('room_name')
  if (error) throw error
  const visibleRooms = rooms || []
  const roomIds = roomFilter ? visibleRooms.filter(r=>r.room_key===roomFilter).map(r=>r.id) : visibleRooms.map(r=>r.id)
  let waiting=[]; let out=[]; let history=[]
  if (roomIds.length) {
    const wq = await admin.from('waiting_requests').select('id,room_id,requested_at,students!inner(student_number,name),destinations!inner(name)').in('room_id',roomIds).eq('status','WAITING').order('requested_at')
    if (wq.error) throw wq.error
    waiting=(wq.data||[]).map(x=>({requestId:x.id,roomKey:visibleRooms.find(r=>r.id===x.room_id)?.room_key||'',name:x.students.name,studentId:String(x.students.student_number),destination:x.destinations.name,requested:x.requested_at}))
    const oq=await admin.from('passes').select('id,room_id,leave_at,destination_name,students!inner(student_number,name)').in('room_id',roomIds).is('return_at',null).order('leave_at')
    if (oq.error) throw oq.error
    out=(oq.data||[]).map(x=>({passId:x.id,roomKey:visibleRooms.find(r=>r.id===x.room_id)?.room_key||'',name:x.students.name,studentId:String(x.students.student_number),destination:x.destination_name,leaveTime:x.leave_at}))
    const hq=await admin.from('passes').select('id,room_id,leave_at,return_at,destination_name,status_note,students!inner(student_number,name)').in('room_id',roomIds).order('leave_at',{ascending:false}).limit(250)
    if (hq.error) throw hq.error
    history=(hq.data||[]).map(x=>({passId:x.id,roomKey:visibleRooms.find(r=>r.id===x.room_id)?.room_key||'',name:x.students.name,studentId:String(x.students.student_number),destination:x.destination_name,left:x.leave_at,returned:x.return_at||'',statusNote:x.status_note||''})).filter(x=>!search || normalize([x.name,x.studentId,x.destination,x.roomKey,x.statusNote].join(' ')).includes(search))
  }
  const schoolSettings = await getSchoolSettings(admin, school.id)
  return {success:true,...adminAccessPayload(auth,school),campusEmergencyLock:Boolean(schoolSettings.campus_emergency_lock),rooms:visibleRooms.map(r=>({key:r.room_key,room:r.room_name,emergencyLock:r.emergency_lock})),waiting,out,history,campusStats:{activeRooms:visibleRooms.length,waiting:waiting.length,out:out.length}}
}


export default {
  fetch: withSupabase({ auth: 'none' }, async (req, ctx) => {
    if (req.method !== 'POST') return Response.json({ success: false, message: 'POST required.' }, { status: 405 })
    try {
      const body = await req.json()
      const admin = ctx.supabaseAdmin
      const fingerprintHash = await requestFingerprint(req)
      const result = String(body.action || '').startsWith('admin') ? await adminDashboard(admin, body, fingerprintHash) : await handleAction(admin, body, fingerprintHash)
      return Response.json(result)
    } catch (error) {
      console.error(error)
      return Response.json({ success: false, message: error?.message || 'Server error.' }, { status: 500 })
    }
  })
}
