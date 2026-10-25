# Deploying Palculate

The backend serves the frontend and Socket.IO from one web service. This keeps
the app and its real-time signaling on the same origin.

## Configure accounts, saved XP, and the leaderboard

Account profiles, XP totals, and the leaderboard use Supabase. Create a
Supabase project, open its **SQL Editor**, and run the complete contents of
`supabase-schema.sql` once. The script creates the profile and XP-award tables,
the new-user profile trigger, and the function that applies each quiz reward
only once.

In the Supabase project settings, copy the project URL, the publishable/anon
key, and the **service_role** secret key. In Render, open this web service's
**Environment** settings and add:

| Key | Value |
| --- | --- |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your Supabase publishable/anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase `service_role` secret |

Save the changes to trigger a redeploy. The service-role key must only be set
as a Render environment variable; never put it in frontend code or commit it
to GitHub. The app sends passwords to Supabase Auth over HTTPS and does not
store passwords itself. If Supabase email confirmation is enabled, new users
must confirm their email before logging in.

## Deploy with Render

1. Put this backend folder (including `public/index.html`, `package.json`,
   `package-lock.json`, `server.js`, `render.yaml`, and
   `supabase-schema.sql`) in a Git repository and push it to GitHub. Do not
   include `node_modules`.
2. In Render, create a new **Blueprint** and select that GitHub repository.
   Render reads `render.yaml`, installs dependencies, and starts the service.
3. Configure the Supabase environment variables above, then open the HTTPS
   URL Render provides and share it with other users.

The server listens on the `PORT` supplied by the hosting provider and serves
the built-in `public` directory. To serve a different frontend directory, set
`FRONTEND_PATH` to its path in the hosting environment.

## Video-call networking

The app requests camera and microphone access, which browsers require to be
served over HTTPS (or from localhost). The app currently uses a public STUN
server for peer-to-peer WebRTC; users on some restrictive networks may also
need a TURN service for reliable video connections.
