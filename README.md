# Selah

A Bible companion app: journeys with women and men of the Bible, theme studies, reading plans,
guided breathing meditations, prayer journal, "Pour out your heart", Ask, and the Bible in KJV,
BBE and Luther 1912 (German).

- `public/` the app (static files, installable as a phone/laptop app)
- `api/ai.js` small server function: checks sign-in and the daily limit, then calls n8n
- `supabase/schema.sql` database tables and privacy rules
- `n8n/selah-ai-workflow.json` import into n8n; calls OpenAI with your credential
- `tools/build.py` rebuilds `public/index.html` from the Claude version of Selah

Setup: see **SETUP.md**.

Photos from Unsplash (credited in the app under Profile → Photo credits).
Bible texts: King James Version and Bible in Basic English (public domain), Luther 1912 (public domain).
