WESTFIELD HALL PASS
V1.14.1 CANONICAL MULTI-TENANT
CUMULATIVE CHANGES SINCE V1.0
=============================================

Current release: V1.14.1
Release target: October 2026

This file summarizes the major architecture, security, administration,
reporting, and usability changes made since the first shared Supabase
school version (V1.0).


CURRENT ARCHITECTURE
--------------------

The Hall Pass system now uses:

- GitHub Pages for the student, teacher, and admin web interfaces.
- Supabase PostgreSQL for shared persistent data.
- Two Supabase Edge Functions:
    - hallpass-public for student/public actions.
    - hallpass-staff for teacher/admin actions.
- UUID-based tenant identity:
    Organization UUID -> School UUID -> Room UUID.

Human-readable URL keys are aliases, not database identities:

- organization_key is the top-level namespace.
- school_key is unique only inside its organization.
- room_key is unique only inside its school.

This allows, for example:

- District A / westfield / d4
- District B / westfield / d4
- District A / another-school / d4

without collisions.

Canonical URLs now include the complete scope:

Student:
  ?org=wusd&school=westfield&room=d4

Teacher:
  teacher.html?org=wusd&school=westfield&room=d4

Admin:
  admin.html?org=wusd&school=westfield

Legacy pre-V1.14 bare room links such as ?room=d4 are preserved through
explicit legacy aliases for the original Westfield rooms. New rooms are
created with canonical scoped links only.


VERSION HISTORY
===============

V1.0 - SHARED SUPABASE SCHOOL VERSION
--------------------------------------

The original Supabase school-wide version replaced the Google Sheet as the
live database while preserving the behavior of the working D4 single-room
system.

Major changes:

- One shared Supabase PostgreSQL database for the school.
- One static GitHub Pages application/codebase for all rooms.
- One browser-facing Edge Function named hallpass.
- Room-specific URLs using ?room=ROOMKEY.
- Shared tables for rooms, teachers, teacher-room assignments, students,
  room/student overrides, room settings, destinations, schedules, waiting
  requests, passes, teacher sessions, backups, and audit data.
- Student records stored once instead of being duplicated in every room.
- One active waiting request and one active pass per student across the school.
- Queue order and destination capacity remained room-specific.
- Teacher PINs stored as bcrypt hashes rather than plaintext.
- Browser files never contained a Supabase service-role/secret key.
- Student lookup, waiting list, FIFO queueing, teacher override, return,
  restroom limits, per-student restroom control, emergency lock, reports,
  pass warnings, and live refresh were carried forward from D4.
- Initial seed created the planned Westfield rooms and copied D4 defaults as
  starting configuration.


V1.1 - PGCRYPTO / PIN HASH COMPATIBILITY FIX
--------------------------------------------

V1.1 corrected PostgreSQL pgcrypto function references used for PIN hashing
and verification.

Changes:

- PIN creation changed to extensions.crypt(..., extensions.gen_salt('bf')).
- Teacher PIN verification changed to use extensions.crypt(...).
- Admin PIN verification changed to use extensions.crypt(...).

No user-facing feature change; this stabilized PIN hashing in Supabase.


V1.2 - SPLIT SQL INSTALL / DATABASE STABILIZATION
-------------------------------------------------

The initial schema was split into smaller SQL files so installation errors
could be isolated and corrected more easily.

The SQL was organized into:

1. Core tables and RLS/security setup.
2. PIN/hash helper functions.
3. Atomic pass-request/start functions.
4. Teacher and remaining database functions.

This release reinforced:

- RLS on Hall Pass tables.
- No direct anonymous/authenticated browser table access.
- Service-role-only database operations through the Edge Function.
- Atomic student request/start behavior.
- Database-side duplicate-pass, queue, capacity, restroom-limit, and active-pass
  checks.


V1.3 - ROOMS & TEACHERS ADMIN MANAGEMENT
-----------------------------------------

Added the first real school administration layer.

New Admin capabilities:

- Rooms & Teachers tab.
- Add/edit/disable rooms.
- Add/edit/disable teachers.
- Teacher/Admin roles.
- Set/reset teacher PINs.
- Assign one or more teachers to a room.
- Assign one or more rooms to a teacher.
- Clone room settings/destinations/schedules from an existing room.
- Generate student and teacher URLs for each room.


V1.3.1 - ROOM URL ROUTING FIX
-----------------------------

Fixed the browser API shim so it reads the current ?room= value fresh for each
request instead of relying on stale room state.

This prevented navigation or room-link changes from accidentally continuing to
send requests to the wrong room.


V1.4 - MASTER SCHOOL SCHEDULES
------------------------------

Bell schedules became centrally managed school-wide data.

Changes:

- Added school-wide Master Schedules.
- Campus Admin controls schedule definitions and bell times.
- Teachers select which schedule a room uses but do not edit the bell-time
  library.
- Creating/cloning a room no longer clones independent schedule definitions.
- D4's existing schedules were migrated into the master schedule table.

This eliminated separate schedule copies drifting between rooms.


V1.5 - SECURITY HARDENING & PRIVACY
-----------------------------------

Added the first major security-hardening layer.

Changes:

- PIN attempt/rate-limit tracking.
- Default protection: 5 failed attempts in 15 minutes triggers a 15-minute
  lockout.
- Raw IP addresses are not stored.
- Only a SHA-256-derived client fingerprint is stored for lockout tracking.
- Successful login clears that client's failed-attempt counter.
- Public Waiting / Students Out lists mask names to first name + last initial.
- Teacher/Admin interfaces continue to show full student names.
- Student public lookup was restricted to the room's assigned students at this
  stage of development.
- Added an Admin Audit Log for management activity.
- Fixed a room-clone issue introduced when schedules became centralized.


V1.6 - SAFE ROOM DELETE + MASTER STUDENT MODEL
----------------------------------------------

Changed the roster model from room membership to a true school-wide master
student list.

Changes:

- Any active master student can use any active room.
- room_students became an override layer rather than a lookup gate.
- Per-room restroom access remains possible through room/student overrides.
- Teacher dashboards show the school-wide master student list.
- Updating a student's restroom access creates/updates the room override even
  if the student had never previously been assigned to that room.
- Admin may delete a room only if it has no pass or waiting history.
- Rooms with history must be disabled instead of deleted, preserving referential
  and historical integrity.


V1.7 - STUDENT ADMIN, SECURITY CONTROLS, CALENDAR, CAMPUS LOCK
--------------------------------------------------------------

Expanded Admin into a real school operations console.

Master Students:

- Add/edit/disable/reactivate students.
- Preview-first CSV import.
- Optional "disable missing students" behavior.
- Duplicate Student IDs rejected.
- Students are disabled, not deleted, so history remains intact.

Configurable security:

- Admin controls failed attempts before lockout.
- Admin controls attempt-window length.
- Admin controls lockout duration.
- Admin can view current lockout/attempt records.
- Admin can clear individual or all lockout records.

Campus Emergency Lock:

- One Admin action blocks new passes in every room at the school.
- Current waiting requests are cleared.
- Students already out may still return.
- Room-level teacher emergency lock remains available.

School Calendar:

- Admin assigns a master schedule to individual dates.
- Rooms automatically follow the school's calendar schedule.
- Teachers can override the schedule for the current day only.
- "Auto" returns the room to calendar/default behavior.
- Teacher override automatically expires after the date.

Dynamic schedule names:

- Removed the original Regular/Minimum/Rally/Test-only constraint.
- Custom schedule names such as Assembly or Testing work end-to-end.


V1.7.1 - CSV TRAILING-COMMA NAME FIX
------------------------------------

Fixed student imports where an empty trailing CSV field could become part of
the student's name.

Example fixed:
  123456,Jane Smith,

The importer now ignores trailing empty cells and removes accidental terminal
commas from names.


V1.8 - PUBLIC / STAFF BACKEND SPLIT
-----------------------------------

Split the single hallpass Edge Function into two separate functions:

- hallpass-public
- hallpass-staff

Benefits:

- Student/public actions are isolated from staff/admin actions.
- Staff-session and administrative code is no longer exposed through the public
  function surface.
- Existing front-end behavior was preserved through api-shim.js.
- config.js continued to contain only the public project/function location, not
  any privileged credentials.
- The old monolithic hallpass function became obsolete after successful testing.


V1.9 - CAMPUS REPORTS & BACKUP
------------------------------

Added a dedicated Admin Reports & Backup area.

Reports added:

- Campus Overview.
- Student Summary.
- Long Passes with adjustable duration threshold.
- Frequent Passes with adjustable pass-count threshold.
- Teacher Overrides.
- Filters for room, student, destination, date range, and test-data inclusion.
- CSV download of the current report.

Backup/export added:

- Students CSV.
- Complete pass-history CSV.
- Rooms / Teachers / Settings JSON.
- Audit Log CSV.
- Full Backup JSON.

Security rules for backups:

The exports intentionally exclude:

- Teacher/Admin PIN hashes.
- Staff-session hashes.
- Rate-limit/client-fingerprint hashes.
- Supabase secrets/service-role credentials.


V1.10 - MASTER DESTINATIONS
---------------------------

Destinations became centrally defined school-wide data.

Admin controls the canonical destination definition:

- Destination Name.
- Enabled School-Wide.
- Counts as Hall Pass.
- Teacher Approval Required.
- Default Max Out.
- Sort Order.

Teachers control only room-specific behavior:

- Enabled in This Room.
- Max Out Override.

Additional changes:

- Added destination_catalog as the canonical destination source.
- Existing destination rows remain the effective room runtime layer.
- Existing pass history and destination foreign keys were preserved.
- Destination names became consistent across campus reporting.
- Retired the old destination Max/Day concept; restroom limiting remains a
  room/student rule.


V1.10.1 - SESSION LIFETIMES + DESTINATION UI CLEANUP
----------------------------------------------------

Security/session changes:

- Teacher sessions limited to an 8-hour hard lifetime.
- Admin sessions limited to a 2-hour hard lifetime.
- Existing older sessions are also evaluated against the newer shorter limit.

The destination Admin UI also received visual/editability corrections for
disabled master destinations.


V1.10.2 / V1.10.3 - DESTINATION EDIT BUTTON UI FIXES
----------------------------------------------------

Additional Admin UI corrections were made to ensure disabled destinations still
present a clearly usable Edit control.

During this work an important deployment lesson was identified: GitHub Pages may
still be serving an older file after code has been replaced. The live page's
source/version should be verified before repeatedly changing working code.


V1.11 - BULK / REPEATING SCHOOL CALENDAR
----------------------------------------

Expanded the School Calendar from one-date-at-a-time editing to bulk scheduling.

Added:

- Repeat by one or multiple weekdays.
- Date-range scheduling.
- Preview before applying.
- Conflict behavior: Skip existing dates or Replace them.
- Paste multiple one-off dates.
- Persistent calendar batch IDs.
- Delete an entire generated batch later.
- Editing one date detaches that date from its original batch.


V1.12 - ROOM ONBOARDING WIZARD
------------------------------

Added a guided room-creation workflow to Admin.

Wizard steps:

1. Room information.
2. New or existing teacher.
3. Teacher PIN when appropriate.
4. Start from school defaults or clone an existing room.
5. Review/adjust destination choices and capacity overrides.
6. Final review and create.

Safety behavior:

- Existing teachers keep their other room assignments.
- Existing teacher PIN remains unchanged unless an Admin explicitly replaces it.
- PIN values are never written into the audit log.
- Newly-created onboarding records are cleaned up if a later onboarding step
  fails, avoiding partially-created rooms.
- The original manual Add Room / Add Teacher tools remain available.


V1.13 - ROOM LINKS & TEACHER SHARING
------------------------------------

Added room-link management directly to Admin.

For each room Admin can:

- Copy Student Hall Pass link.
- Copy Teacher Control Panel link.
- Open either link.
- Copy a ready-to-send setup message.
- Email the assigned teacher through the device/browser mailto handler.
- Add a missing teacher email.

After successful room onboarding, the Room Links panel opens automatically.

No email service credentials are stored by Hall Pass.


V1.13.1 - ADMIN REPORT SORTING
------------------------------

Updated Admin Reports & Backup tables to mimic Teacher report sorting.

Changes:

- Click any report column heading to sort.
- Click again to reverse sort direction.
- Active heading displays an ascending/descending arrow.
- Numeric fields sort numerically.
- Text/name fields sort alphabetically.
- Sorting applies to Admin report tables such as Student Summary, Long Passes,
  Campus Overview breakdowns, and similar report output.


ONE-TIME PRODUCTION DATA OPERATIONS BEFORE V1.14
=================================================

007 - D4 / E6 HISTORICAL PASS RECONCILIATION AND IMPORT
--------------------------------------------------------

The original D4 and Coldiron/E6 spreadsheets were compared before importing old
history into Supabase.

Because E6 was originally created by copying D4, the two histories contained a
large shared prefix.

Reconciliation identified:

- Exact copied history shared by both files.
- D4-only passes.
- E6-only post-copy passes.
- Incomplete/test records.

Final historical import:

- D4: 520 completed historical passes.
- E6: 24 genuine E6-only completed historical passes.
- Total: 544 imported historical passes.

The shared copied history was imported once, not duplicated.

A corrupt old calculated duration value was not trusted; the migration preserved
actual leave/return timestamps so duration is derived correctly from timestamps.


008 - PRE-PRODUCTION OPERATIONAL CLEANUP
----------------------------------------

Before importing the real history, development/runtime data was cleared while
configuration was preserved.

Cleared:

- Development/test passes.
- Waiting requests.
- Pass backups.
- Staff sessions.
- PIN attempt/rate-limit records.
- Development audit history.

Preserved:

- Rooms.
- Teachers and assignments.
- Master students.
- Room/student overrides.
- Room settings.
- Master destinations.
- Room destination settings.
- Master schedules.
- School calendar.
- Security/system configuration.


V1.14.0 - INITIAL MULTI-SCHOOL DESIGN (RETIRED)
-----------------------------------------------

An initial Organization -> School expansion was built, but was intentionally
retired before rollout after reviewing the identity assumptions.

The reason:

A room key such as d4 cannot be assumed unique across schools, and a school key
such as westfield cannot be assumed unique across districts/organizations.

V1.14.0 was therefore superseded by V1.14.1 before rollout.

DO NOT DEPLOY V1.14.0.


V1.14.1 - CANONICAL MULTI-TENANT ORGANIZATION / SCHOOL / ROOM DESIGN
--------------------------------------------------------------------

V1.14.1 is the current release.

Canonical identity:

- Organization UUID.
- School UUID belonging to that organization.
- Room UUID belonging to that school.

Human-readable keys are scoped aliases:

- organization_key is the top-level URL namespace.
- school_key is unique only inside its organization.
- room_key is unique only inside its school.

This means every district may have its own school named/keyed Westfield and every
school may have its own D4 without collision.

Migration/backfill:

All existing production data was placed under:

- Organization: Washington Unified School District.
- Organization key: wusd.
- School: Westfield Village Elementary School.
- School key: westfield.

Existing rooms, students, destinations, schedules, calendar data, teachers,
settings, audit data, and the 544 imported historical passes remain intact.

Canonical URL behavior:

- New student/teacher links always contain org + school + room.
- Student and Teacher pages resolve and display their complete context.
- Legacy pre-V1.14 Westfield bare-room links remain valid through explicit
  legacy_room_aliases.
- The system does NOT search globally for a matching D4.
- A future D4 at another school cannot hijack the old Westfield D4 link.
- New rooms do not receive bare-room aliases.

Stable URL identifiers:

- Organization, school, and room URL keys are permanent after creation.
- Display names may be changed independently.
- This protects bookmarks, kiosks, QR codes, and distributed teacher links.

School-owned scope:

- Rooms.
- Students.
- Master destinations.
- Master bell schedules.
- School calendar.
- School/campus emergency lock.
- Reports and backups.

Organization-owned scope:

- Teachers.
- Organization Admin access.
- PIN-attempt/lockout security policy.

Access levels:

- Organization Admin: all active schools within that organization.
- School Admin: assigned school(s) only.
- Teacher: assigned room(s) only.

Security/authorization hardening:

- Admin authentication is organization-scoped.
- School Admin eligibility is checked against the requested school.
- School Admins cannot manage Organization Admin accounts upward.
- School Admins cannot view/clear Organization Admin PIN lockout records.
- Organization security/lockout settings are independent from other
  organizations in the same deployment.
- School emergency lock affects only the selected school.
- Database guards reject room/student and room/destination cross-school
  mismatches.
- Both Edge Functions use a single database-backed canonical room resolver.
- Pass operations use resolved room UUID identity rather than trusting a bare
  room key.

Admin multi-tenant behavior:

- Added Organization & Schools management.
- Added active-school selector.
- Students, destinations, calendar, reports, backups, rooms, and related Admin
  operations follow the selected school.
- Organization Admin can work across schools in the organization.
- A School Admin remains restricted to authorized school(s).
- A bare Admin URL is backward-compatible while only one active organization
  exists.
- If multiple organizations exist, the Admin URL must identify the organization.

Backup isolation:

- Full Backup identifies its organization and selected school.
- Backup reads only the selected school's room-level configuration/history.
- Staff included in a school backup are limited to staff attached to that school.
- PIN hashes, session hashes, rate-limit fingerprints, and service credentials
  remain excluded.

Front-end scope changes:

- api-shim.js now preserves full org/school/room context.
- Student page uses canonical tenant scope.
- Teacher page uses canonical tenant scope and displays organization/school/room
  context.
- Old ?view=teacher redirects preserve organization and school parameters.
- Admin page uses organization/school context and school selection.
- V1.13.1 sortable Admin reports are preserved.

Other fixes found during the multi-tenant review:

- Fixed an inherited Admin audit-filter variable bug.
- Corrected selected-school organization identity used by staff management and
  reporting.
- Corrected Teacher context display assignment.
- Tightened backup queries so unrelated school staff/room records are not pulled
  and filtered only in browser memory.
- Corrected privilege boundaries around organization-level staff accounts.


CURRENT SECURITY MODEL
======================

Teacher/Admin PINs:

- PINs are never stored as plaintext.
- PINs are hashed with PostgreSQL pgcrypto bcrypt.
- A forgotten PIN cannot be recovered; it must be reset.

Staff sessions:

- Successful PIN login creates a random session token.
- The browser stores the raw temporary token in sessionStorage.
- Supabase stores only a SHA-256 hash of the session token.
- Teacher session hard lifetime: 8 hours.
- Admin session hard lifetime: 2 hours.

Public/student privacy:

- Public waiting/out displays use masked names.
- Full names remain available only to authenticated staff interfaces.

Database/API security:

- RLS remains enabled.
- Browsers do not directly query privileged Hall Pass tables.
- Edge Functions perform the privileged database operations.
- No service-role key is placed in GitHub/browser files.
- hallpass-public contains no staff-session creation path.
- hallpass-staff handles staff/admin authentication and privileged actions.


CURRENT PRODUCTION BASELINE
===========================

At the V1.14.1 conversion point, Westfield production data included:

- 10 rooms.
- 182 master students.
- 8 master destinations.
- 544 historical D4/E6 passes imported into Supabase.

The V1.14.1 database migration preserved these records while placing them under
the WUSD / Westfield tenant hierarchy.


V1.14.1 DEPLOYMENT FILES
========================

Database:

- supabase/migrations/009_organization_school_foundation.sql

Edge Functions:

- supabase/functions/hallpass-public/index.ts
- supabase/functions/hallpass-staff/index.ts

GitHub Pages:

- api-shim.js
- admin.html
- index.html
- teacher.html

KEEP THE EXISTING LIVE config.js.
Do not replace config.js during the V1.14.1 upgrade.

The old V1.14.0 package is retired and must not be used.


ROLLBACK / COMPATIBILITY
========================

V1.14.1 was designed as an in-place migration:

- Database migration may be applied before the new web UI.
- Existing V1.13 pages remain functional during staged deployment.
- hallpass-public may be upgraded and tested before hallpass-staff.
- hallpass-staff may be upgraded and tested before the GitHub front end.
- Legacy D4/E6 URLs remain supported.

The release package includes V1.13.1 front-end rollback files for temporary UI
rollback while leaving the V1.14.1 database and Edge Functions in place.


SUMMARY
=======

From V1.0 to V1.14.1, Hall Pass evolved from a single-school shared Supabase
replacement for the D4 Google Sheet into a structured multi-tenant system with:

- Shared school data.
- Master students.
- Central schedules and destinations.
- Room-specific operational overrides.
- Secure hashed PIN authentication and temporary sessions.
- PIN brute-force protection.
- Student privacy masking.
- Audit logging.
- School calendar automation.
- Emergency locking.
- CSV roster management.
- Reports, exports, and safe backups.
- Guided room onboarding.
- Teacher/link sharing tools.
- Historical pass migration and reconciliation.
- Organization / School / Room UUID identity.
- Scoped district, school, and room URL aliases.
- Organization Admin, School Admin, and Teacher authorization boundaries.
- Tenant-isolated operations, reports, backups, and security policy.

V1.14.1 is the first release designed from the beginning to allow multiple
organizations, multiple schools per organization, repeated school names across
districts, and repeated room names across schools without identity collisions.


WESTFIELD HALL PASS — V1.14.2 TEACHER UI FIX

BASE
----
V1.14.1 Canonical Multi-Tenant

CHANGES
-------
1. Restored the missing Student Restroom Access table functions.
2. Added a visible Search button.
3. Student search now works by name or Student ID as-you-type, with Enter, or by clicking Search.
4. Added visible match/no-match feedback.
5. Restored per-student Restroom Allowed Save behavior.
6. Auto schedule now shows the effective schedule directly on the button, e.g. “Auto — Regular”.
7. Schedule source text now clearly states the effective automatic schedule or teacher override.
8. Corrected render order so schedule buttons receive their active state after being created.

DEPLOYMENT
----------
Replace ONLY teacher.html in the GitHub Pages repository.
Do not change config.js, api-shim.js, index.html, admin.html, Supabase SQL, or either Edge Function.

After GitHub publishes, hard-refresh the teacher page.


WESTFIELD HALL PASS — V1.14.3 TEACHER Student Search Fix Part 2

BASE
----
V1.14.2 Canonical Multi-Tenant

FILES TO REPLACE
- teacher.html only

WHAT CHANGED
- Student Restroom Access search now tolerates both current and legacy student field names.
- Search button and Enter key force a fresh school-roster pull from getTeacherDashboardState before filtering.
- Live typing still filters the already-loaded roster immediately.
- Search status shows the number of students loaded, so an empty roster is visible instead of looking like a failed search.
- No database, SQL, Edge Function, Admin, student page, api-shim.js, or config.js changes.

EXPECTED TEST
- Search for Christian. The current 182-student master roster should return multiple matches.

WESTFIELD HALL PASS — V1.14.4 TEACHER ROSTER REPAIR

BASE
----
V1.14.3 Canonical Multi-Tenant

FILES TO REPLACE
Replace only teacher.html on GitHub Pages.
No SQL, Edge Function, api-shim.js, admin.html, index.html, or config.js changes are required.

FIXES
- Restores the missing renderStudentOptions() helper.
- This helper populates both Teacher Override > Student and Reports > Individual Student dropdowns.
- Its absence caused renderState() to stop before Student Restroom Access could render, producing "Student roster has not loaded" even when the backend returned students.
- Retains the V1.14.3 student search behavior: live search, Search button, Enter key, reload, and loaded-count feedback.
- Retains Auto schedule effective-schedule display from V1.14.2/1.14.3.
- Clarifies that Student Restroom Access changes are for THIS ROOM only.

DEPLOY
1. Replace teacher.html in the GitHub Pages repository.
2. Commit the change.
3. Hard-refresh the teacher page.
4. Log in.
5. Verify the Teacher Override Student dropdown is populated.
6. Under Controls, search "Christian" in Student Restroom Access.

Campus Hall Pass — Browser Tab Title Patch
=======================================

Base package: V1.14.1 Canonical Multi-Tenant Upgrade — CORRECTED
Teacher page: User-supplied V1.14.4 (search/roster fixes retained)
Patch: Titles only, plus a one-time read-only display-metadata API endpoint.

Expected with org=wusd, school=westfield, room=d4 and assigned teacher Scott Christian:
  Student: Hall Pass Student - WUSD - Westfield - Room D4 (Christian)
  Teacher: Hall Pass Teacher - WUSD - Westfield - Room D4 (Christian)
  Admin:   Hall Pass Admin - WUSD - Westfield

Files changed versus the supplied baseline ZIP:
  index.html: browser title and metadata title lookup
  teacher.html: replaced with user-supplied V1.14.4, then added title logic
  admin.html: dynamic browser title on login and school switches
  supabase/functions/hallpass-public/index.ts: added getRoomDisplayMetadata (read-only)
  TITLE-UPDATE-README.txt: this file
No changes to the staff Edge Function, database schema, or pass operations.

Deployment:
1. Preserve your current live config.js (it is not included in the supplied ZIP).
2. Deploy only the changed public Edge Function using your existing Supabase deployment process.
3. Upload the three changed HTML files to the same GitHub Pages location.
   Leave existing api-shim.js, config.js, and all other production files untouched.
4. Open the normal student/teacher/admin URLs (include org/school/room).
5. Confirm the exact browser tab titles. Existing staff assignments supply surnames.

Limitations:
- If no active teacher is assigned to a room, the title omits the teacher parentheses.
- If several active teachers are assigned, surnames are joined with " / ".
- Without the updated public Edge Function, the rest of the pages still work but titles omit the teacher names.
- Automated tests use a mocked server; they do not certify the production Supabase deployment,
  teacher PIN login, pass writes, or a live GitHub Pages rollout.

Version 1.14.4 - Teacher UI and Browser Titles
Date: October 12, 2026
Type: User interface improvements
Status: Offline smoke tests passed; live deployment verification pending

Changes:
1. Preserved the V1.14.4 teacher student-search and roster-loading repairs.
2. Preserved the improved Auto schedule display showing the effective schedule.
3. Standardized browser-tab titles across Admin, Teacher, and Student pages.
4. Added dynamic organization, school, room, and assigned-teacher information to browser titles.
5. Added read-only room display information through the public API.
6. Supported assigned-teacher names without hardcoding them.

Files affected:
index.html
teacher.html
admin.html
supabase/functions/hallpass-public/index.ts

Compatibility:
No database schema changes.
No changes to pass-management operations.
Existing teacher V1.14.4 functionality retained.

Testing:
JavaScript parsing passed.
All three pages loaded in simulated browser tests.
Browser-tab titles displayed correctly using test data.
Teacher search and Auto schedule display passed simulated tests.
Live Supabase and production deployment not tested.


Version 1.14.4 - Confirmation Popup Cleanup
Date: October 12, 2026
Type: User interface improvements
Status: Offline smoke tests passed; live deployment verification pending

Changes:
1. Simplified wording in 12 existing confirmation and input dialogs.
2. Clarified whether actions affect one student, one room, or the campus.
3. Shortened emergency-lock, waiting-list, pass-limit override, room-deletion, schedule, and administrative confirmation messages.
4. Simplified student cancellation and teacher PIN prompts.
5. Retained native browser OK/Cancel dialogs.
6. Preserved existing confirmation and cancellation logic.

Files affected:
index.html
teacher.html
admin.html

Compatibility:
No Supabase changes for the popup cleanup.
No database schema changes.
No modifications to pass-management operations.
Existing browser titles, student search, roster loading, and schedule displays retained.

Testing:
JavaScript parsing passed.
All three pages loaded successfully in simulated browser tests.
Confirmation cancellation paths were tested.
Cancel prevented the associated write operations in simulated tests.
Teacher student-search and Auto schedule functions remained operational with mocked data.
No live Supabase writes or production deployment tests performed.

Deployment:
Replace index.html, teacher.html, and admin.html with the updated versions.
No additional database migrations or Edge Function changes are required for the popup cleanup.
Production verification pending.


Standard Format for Future Updates

Version [Version Number] - [Update Name]
Date: [Date]
Type: [Feature / Bug Fix / UI / Security / Performance]
Status: [Testing and Deployment Status]

Changes:
Describe what was added, corrected, or improved.

Files affected:
List modified application files.

Compatibility:
Identify unchanged functionality.
Document any database, API, or configuration changes.

Testing:
Describe tests actually completed.
Record failed or untested scenarios.

Deployment:
Identify files requiring replacement.
Document required backend deployment, migration, or configuration changes.
Record production verification status.
Hall Pass - Short Browser-Tab Titles
Date: October 12, 2026
Type: User interface improvement
Status: Offline smoke tests passed; production verification pending

Changes:
- Student tabs now show "Hall Pass Student - Room D4" (room varies dynamically).
- Teacher tabs now show "Hall Pass Teacher - Room D4" (room varies dynamically).
- Admin tabs now show "Hall Pass Admin - Westfield" (school varies dynamically).
- Full organization, school, and room details remain in the page headers.
- Removed unnecessary title-related API calls from the student and teacher pages.
- Preserved existing V1.14.4 teacher search, Auto schedule, and popup cleanup.

Files Affected:
index.html
teacher.html
admin.html

Compatibility:
No database, Supabase function, API shim, or pass-processing changes.
No SQL migration required.

Deployment:
Replace index.html, teacher.html, and admin.html on GitHub Pages.
Keep existing config.js, api-shim.js, and Supabase functions unchanged.

Testing:
Static JavaScript validation and simulated browser title/UI tests passed.
Live production verification is pending.

--------------------------------------------------
Version 1.14.5 - Student Searchable Dropdowns
Date: October 12, 2026
Type: Teacher and Admin interface improvement
Status: Offline browser tests passed; live testing pending

Changes:
1. Teacher Override Pass: student selection now supports type-ahead suggestions by name or student ID.
2. Teacher Individual Student Report: the student selection now supports type-ahead suggestions.
3. Teacher Student Restroom Access: name and ID searches now display clickable student suggestions while typing.
4. Admin Student Summary Report: the student filter now supports type-ahead suggestions while retaining the All Students option.
5. Admin Students: the roster search now offers matching student suggestions while typing.
6. Admin Recent Pass History: the search now offers student suggestions after the school roster loads; destination and room free-text searches remain available.
7. Dropdown results show both the student name and ID and support mouse/touch selection and arrow-key plus Enter selection.
8. Suggestions are limited to eight visible results; continue typing to narrow the list.
9. Student IDs are still passed unchanged to existing pass and report functions.

Files Changed:
teacher.html
admin.html

Compatibility:
No changes to index.html or the student kiosk.
No changes to Supabase, SQL, configuration, API endpoints, student access rules, pass limits, or reports.
Preserves V1.14.4 teacher roster/search fixes, Auto schedule clarity, popup cleanup, and compact browser-tab titles.

Offline Verification:
Teacher Override selection by name and ID: Passed.
Teacher Individual Student Report selection: Passed.
Teacher Restroom Access autocomplete: Passed.
Admin Student Report selection: Passed.
Admin Student Roster autocomplete: Passed.
Admin Recent Pass History autocomplete: Passed.
Arrow Down and Enter keyboard selection: Passed.
Unmatched typing clears any previously selected student ID: Passed.
JavaScript syntax checks: Passed.
Duplicate static HTML ID check: Passed.
Live Supabase read/write and production end-to-end testing: Not performed.

Deployment:
Back up current production teacher.html and admin.html.
Replace only teacher.html and admin.html in GitHub.
Do not run any SQL migration or redeploy Supabase functions.
After GitHub Pages publishes, hard-refresh teacher and admin pages and verify all search locations.


------------------------------------------------------------
Branding-only update — October 13, 2026 (pending asset upload)
------------------------------------------------------------

Added display-only Hall Pilot branding support across student, teacher and
administrator screens. Uses the Hall Pilot paper-plane favicon and mark,
a responsive white brand strip, and school-specific logos chosen by the
organization + school URL/context keys. Westfield's Wildcats logo is
registered as assets/schools/wusd--westfield.webp.

Important:
- The Wildcats asset must exist before this change is deployed.
- This is a STATIC asset registry. No admin upload screen was added.
- A missing school image is hidden; the school name remains visible.
- The existing red/green student status area is not modified.
- No changes to pass requests, waiting lists, timers, database, Edge
  Functions, reports, security, or schedule handling.
- Three existing page title helpers were reworded from Hall Pass to Hall Pilot.
