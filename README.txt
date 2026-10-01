WESTFIELD HALL PASS — MASTER SCHEDULE UPDATE v1.4

What changes:
- Bell schedules are now school-wide Master Schedules managed from Campus Admin.
- Teachers can select the schedule their room uses today, but cannot edit bell times.
- Room-specific settings/destinations remain room-specific.
- Creating/cloning a room no longer copies bell schedules.

DEPLOY IN THIS ORDER:
1. Supabase SQL Editor: run supabase/migrations/002_master_schedules.sql once.
   It creates master_schedules and copies the existing D4 schedules into it.
2. Supabase Edge Functions > hallpass > Edit code:
   replace the function with supabase/functions/hallpass/index.ts, then Deploy updates.
   Keep Verify JWT with legacy secret OFF.
3. GitHub Pages repo:
   replace admin.html and teacher.html.
   Also replace api-shim.js if you have not already installed the v1.3.1 room URL fix.
   Do NOT replace config.js; keep the one with your real Supabase Project ID.
4. Hard refresh the Admin and Teacher pages.

Admin now has a Master Schedules tab.
Teacher > Controls now shows schedule choices from the master schedule library.
