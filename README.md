# Hale Build Tracker

A shared web app for tracking a house build: phases and County inspections, timeline, budget, change orders, loan draws, vendors and lien releases, fixture selections with photos, site log, punch list, questions for the contractor, documents and contacts.

Built with [Vite](https://vitejs.dev) (plain JavaScript, no framework) and [Supabase](https://supabase.com) for sign-in, the database, live updates and file storage. Hosted on [Vercel](https://vercel.com).

---

## What's already done

The Supabase project **hale-build** (`eyjmzklwmhpxkyjekptm`, US West) is set up and ready:

- Tables, access rules and the photo/PDF storage bucket are created (`supabase/migrations/` has the exact SQL).
- People only see builds they belong to. Owners invite by email; members can view and edit everything.
- `.env.example` already has this project's URL and publishable key. The publishable key is safe to ship in the browser; the access rules protect the data.

## Deploy: about 10 minutes

### 1. Code on GitHub

Already done: <https://github.com/caguiar54-hhsf/hale-build-tracker>. To make changes later, edit the files and push to `main`.

### 2. Deploy on Vercel

1. Go to <https://vercel.com/new>, pick **hale-build-tracker** from your GitHub repos, and click **Import**.
2. Vercel detects Vite automatically. Open **Environment Variables** and add both values from `.env.example`:
   - `VITE_SUPABASE_URL` = `https://eyjmzklwmhpxkyjekptm.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_L0qqhCX4zawyWDztLPKWSQ_H4yeo4MP`
3. Click **Deploy**. When it finishes, copy your site address (for example `https://hale-build-tracker.vercel.app`).

### 3. Tell Supabase your site address (required for sign-up emails)

In the Supabase dashboard, open **hale-build → Authentication → URL Configuration**:

- **Site URL**: your Vercel address, e.g. `https://hale-build-tracker.vercel.app`
- **Redirect URLs**: add `https://hale-build-tracker.vercel.app/**`, and `http://localhost:5173/**` if you'll run it on your computer.

Without this, the confirmation and password-reset links in emails point to the wrong place.

### 4. Create your account and the build

1. Open your Vercel address, click **Create an account**, and confirm from your inbox.
2. Sign in, name the build (e.g. "The Kealoha house") and click **Create**. It starts with the standard Hawaiʻi County phase list.
3. Go to **Files → Sharing** and invite your friends by email.
4. Send them the site address. They create an account **with the same email you invited**, confirm it, and the build appears when they sign in.

Each person can add the app to their phone's home screen (Share → Add to Home Screen) so it opens like an app.

---

## Good to know

- **Email limits.** Supabase's built-in email service only sends a few emails per hour. That's fine for a handful of friends. If confirmation emails stop arriving, wait an hour, or set up your own email sender under **Authentication → Emails → SMTP Settings** (Resend or SendGrid have free tiers).
- **Keep "Confirm email" turned on** (Authentication → Sign In / Providers → Email). Invites rely on it: someone only joins a build after proving they own the invited email.
- **Roles.** Owners can invite and remove people and rename the build. Members can edit everything else. Anyone can leave a build.
- **Several builds.** One account can belong to several builds; use the **Hale Build ▾** switcher at the top.
- **Files** are private. Photos and PDFs load through links that expire after an hour and only work for members.
- **Updates.** Every push to `main` on GitHub redeploys on Vercel automatically.

## Run it on your computer

```bash
npm install
cp .env.example .env
npm run dev
```

Then open <http://localhost:5173>.

## Project layout

```
index.html               page shell: sign-in, build picker, app frame
src/main.js              all views, forms and the Supabase data layer (bottom of file)
src/style.css            design tokens and styles (light and dark)
src/supabase.js          Supabase client
public/                  icon and home-screen manifest
supabase/migrations/     database schema and access rules (already applied)
vercel.json              build settings and security headers
```

### How data is stored

- `projects`: one row per build.
- `project_members`: who belongs to which build, and their role.
- `invites`: emails waiting to join. Accepted automatically at sign-in once the email is confirmed.
- `records`: every tracker item (phases, costs, selections, log entries...) as a row with a `collection` name and a JSON `data` column. Changes stream to everyone with the build open.
- Storage bucket `files`: photos and PDFs, stored under the build's id.
