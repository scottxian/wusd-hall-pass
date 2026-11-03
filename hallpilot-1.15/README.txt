HALL PILOT 1.15 — FLEXIBLE ROOM SCHEDULING
DEVELOPMENT STATUS: NOT DEPLOYED
=============================================================

GOAL
----
Normal school days do not require calendar entries. Each room uses its
assigned Primary master bell schedule. School-wide Minimum, Rally, Testing,
or other exceptional days use each room's separately assigned schedule.

Room assignments are independent of grade level. Multiple rooms may share
a single master schedule, and Admin can select multiple rooms at once.

SAFETY
------
This is a DEVELOPMENT BRANCH. Live Westfield Hall Pilot is untouched.
DO NOT merge this branch, deploy the Edge Functions, run the migration
against the live database, or turn on room scheduling without full review.

The GitHub repository's existing config.js still points to production.
NEVER serve this development branch as a functioning test site until its
config.js is explicitly redirected to a SEPARATE development Supabase
project. A branch alone does not provide database isolation.

FILES
-----
001-room-scheduling.sql      Additive schema migration (development first)
hallpass-staff.ts            Staff/admin Edge Function development source
hallpass-public.ts           Student/public Edge Function development source
test-scheduling.mjs          No-network synthetic regression tests
README.txt                   This guide
../admin.html                Admin UI with new Room Scheduling tab

DEPLOYMENT PREREQUISITES
------------------------
1. Provision a separate Supabase DEVELOPMENT project in an organization
   explicitly selected by the owner. Project creation may incur charges.
2. Replicate the EXISTING Hall Pilot schema, RPC functions, auth rules, and
   required organization/school setup there using dummy data only.
3. Run 001-room-scheduling.sql against DEVELOPMENT, not production.
4. Deploy both development Edge Functions to that development project.
5. Deploy a separate development website whose config.js URLs target ONLY
   the development project. Use a separate hostname/site (NOT app.hallpilot.net).
6. Run the test file: node hallpilot-1.15/test-scheduling.mjs
7. Perform browser tests in the development environment, including:
   - School-wide default unchanged with the feature off
   - Two rooms with different Primary bell times on the same day
   - Different Minimum bell times in those rooms on one date
   - Repeating weekday exceptions and skipping/replacing existing dates
   - Teacher's daily schedule override and automatic reset
   - Student kiosk CLOSED/OPEN matching staff status and database validation
   - School emergency lock, room lock, restroom limits, queue, waiting/out
   - Teacher login, student search, pass reports, Admin drilldowns/CSV/print
   - Teacher room change and copying room settings
   - Room with a missing special mapping closes instead of guessing times
   - Cross-school room mapping requests rejected
   - All current students returned before schedule mode is changed

HOW TO CONFIGURE (AFTER DEVELOPMENT VERIFICATION)
-------------------------------------------------
1. Create the school's Master Schedules: Regular, K–1 Regular,
   2–3 Regular, 4–5 Regular; K–1 Minimum, 2–3 Minimum, 4–5 Minimum.
   The names are examples and do NOT assign grade-based access.
2. In Admin > Room Scheduling, select multiple rooms, choose 'Primary'
   as Day Type, select their Primary schedule, and Assign.
3. For the same rooms, enter 'Minimum' and assign their Minimum schedule.
   Repeat for Rally, Testing, or any special day types needed.
4. Use 'Bring Existing Special Dates Forward' to preview future dates
   already entered in the original calendar. Only special dates need
   copying. Original entries are NOT deleted.
5. Add single or repeating special dates; preview before saving.
6. Check that every active room has a master Primary schedule and every
   active room has a mapping for every future special day type.
7. Enable Room Scheduling from Admin only AFTER classrooms are empty,
   original calendar entries have been reviewed, a backup is saved,
   and the owner approves the production switch.

SCHEDULE PRIORITY (WHEN ROOM SCHEDULING IS ON)
---------------------------------------------
1. Today's explicit teacher override
2. Today's school-wide Special Day -> room's mapped master schedule
3. Room Primary schedule (room_settings.schedule_mode)
If an exception is active but an assignment is missing, the schedule
resolves to a sentinel with no bell periods (passes remain closed).
The school-wide Automatic Calendar switch still disables exceptions,
but keeps room Primary schedules in force.

COMPATIBILITY (WHEN ROOM SCHEDULING IS OFF)
------------------------------------------
Original behavior is unchanged:
Teacher override > existing school_calendar date > school 'Regular'.
The original school_calendar table is retained, not migrated/deleted.
Returning to the old mode restores its original calendar assignments.

BACKEND DESIGN
--------------
- school_settings.room_scheduling_enabled: false by default.
- room_settings.schedule_mode: existing per-room Primary schedule column.
- The Admin Day Type label is Primary. The internal legacy identifier
  'Regular' remains accepted for backwards compatibility; neither
  Primary nor Regular is a special day type.
- room_schedule_assignments: (room_id, day_type) -> master schedule name.
- school_day_exceptions: special date -> special day type by school.
- Both Edge Function resolvers are IDENTICAL and use the same precedence.
- Master schedule changes protect references from the new mapping table.
- Admin writes validate school scope, known master schedule names, and
  complete special-day assignments across active rooms.
- Switching scheduling modes is blocked while passes are out or queued.
- No changes to public student access, teacher PINs, sessions, pass history,
  campus reporting, or pass RPC procedures are part of this branch.
- New tables have RLS enabled and no browser user data permissions.

WESTFIELD EXISTING CALENDAR (READ-ONLY INVENTORY, 2026-11-02)
--------------------------------------------------------------
For calendar_date >= 2026-11-02: 24 Regular entries, 11 Minimum entries.
Keep original calendar data. Regular entries become unnecessary when
each room has a Primary schedule. 'Prepare Those Dates' is a read-only
preview action to copy special dates into the NEW calendar.

ROLLOUT & ROLLBACK
------------------
Apply schema changes and Edge Functions only during an approved rollout
after full backups. Leave room_scheduling_enabled=false initially.
Configure and verify mappings before enabling.
If problems arise after rollout, disabling the feature restores the
original school_calendar resolver. If the Edge Functions malfunction,
restore known-good staff v11 / public v6; the additive schema can remain.
Only if needed, roll back the Admin page to the prior release.

No live deploy or production database changes have been performed by
the development work represented by this branch.
