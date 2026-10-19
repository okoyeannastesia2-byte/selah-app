# Setting up Selah as your own app

This puts Selah on its own web address with its own icon. Anyone can install it on a phone or laptop, with no Claude account needed. It takes about 45 minutes the first time.

**What each piece does**

| Piece | Job | Cost to start |
|---|---|---|
| **Supabase** | Accounts, sign-in, and saving everyone's progress, journal and prayers | Free plan |
| **n8n** (your Cloud account) | Receives AI requests from Selah and calls OpenAI with your existing key | Your current plan; every AI answer is 1 execution |
| **OpenAI** (your existing key) | Writes reflections, Ask answers and prayers | Pay per use, a few dollars a month for family |
| **GitHub** | Holds Selah's files | Free |
| **Vercel** | Gives Selah its web address and runs the small AI bridge | Free (Hobby) for personal, non-commercial use |

Keep a notes file open while you work. You'll copy about six values from one place to another.

---

## Step 1 — Supabase (accounts and saving)

1. Go to **supabase.com**, sign up, then click **New project**.
2. Name it `selah`. Create a strong **database password** and save it in your notes. For **Region**, choose **Central EU (Frankfurt)**, or the closest region to where most users live.
3. Wait about 2 minutes for the project to be ready.
4. Open **SQL Editor**, then **New query**.
5. Open `supabase/schema.sql` from the Selah folder and copy all of it into the editor.
6. On the line marked `<<< YOUR EMAIL`, replace `your-email@example.com` with the email you'll sign in to Selah with. That account becomes the admin who can see testers.
7. Click **Run**. You should see *Success. No rows returned*.
8. Go to **Project Settings** (gear icon), then **API**, and copy these three values into your notes:
   - **Project URL**, which looks like `https://abcd1234.supabase.co`
   - **anon public** key. It's safe inside the app.
   - **service_role** key. ⚠️ This is secret. Only ever paste it into Vercel, never into the app, a chat or a screenshot.
9. Go to **Authentication**, then **Sign In / Providers**, then **Email**. Make sure **Email** is enabled and **Confirm email** is on.

## Step 2 — n8n (the AI bridge to OpenAI)

1. In n8n, click **Create workflow**, then the **⋯ menu**, then **Import from File**, and choose `n8n/selah-ai-workflow.json`.
2. Open the first node, **Selah app request**. Under **Credential for Header Auth**, create a new one:
   - **Name:** `x-selah-secret`, exactly like that.
   - **Value:** a long random secret. A password generator works; 40+ letters and numbers is ideal.
   - Copy that same secret into your notes as **N8N_SECRET**.
3. In the same node, copy the **Production URL** into your notes as **N8N_WEBHOOK_URL**. It ends in `/webhook/selah-ai`.
4. Open the **OpenAI** node. Under **Credential for OpenAI**, choose the OpenAI credential you already use.
5. (Optional) Open **Build OpenAI request** to change the models at the top:
   - `MODEL_MAIN` (`gpt-6.1-sol`) is used for reflections, prayers and Ask.
   - `MODEL_FAST` (`gpt-6-luna`) is the cheapest option. Use `gpt-6-luna` for both to spend the least.
6. Click **Save**, then **Publish** (or switch the workflow to **Active**).

For privacy, this workflow doesn't keep successful runs, so people's prayers aren't stored in n8n. It only keeps failed runs, so you can see what went wrong.

## Step 3 — Put your Supabase details into Selah

Open `public/config.js` and fill in the two values from Step 1:

```js
supabaseUrl: "https://abcd1234.supabase.co",
supabaseAnonKey: "eyJhbGciOi...the anon public key...",
```

Only the **anon** key goes here, never the service_role key.

## Step 4 — GitHub (where the files live)

**The easy way:** create a free account at **github.com**. Click **New repository**, name it `selah`, set it to **Private**, and create it. Then tell Claude the repository name. Claude can upload all the files for you, and later updates can go straight there.

**Or upload them yourself:** in the empty repository, click **uploading an existing file** and drag in everything inside the Selah folder. GitHub accepts 100 files at a time, so:
- first upload everything **except** the `public/photos` folder, and click **Commit**;
- then click **Add file**, then **Upload files**, and drag in `public/photos`.

Check that the folder structure stayed the same (`public/`, `api/`, `supabase/`, `n8n/`).

## Step 5 — Vercel (the web address)

1. Go to **vercel.com** and sign up with your GitHub account.
2. Click **Add New**, then **Project**, and **Import** the `selah` repository.
3. **Framework Preset:** Other. Leave the build command empty. **Output Directory:** `public`.
4. Open **Environment Variables** and add these six:

| Name | Value |
|---|---|
| `SUPABASE_URL` | the Project URL from Step 1 |
| `SUPABASE_ANON_KEY` | the anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role key (secret) |
| `N8N_WEBHOOK_URL` | the Production URL from Step 2 |
| `N8N_SECRET` | the same secret you put in n8n |
| `AI_DAILY_LIMIT` | `30` (AI answers per person per day; change any time) |

5. Click **Deploy**. After about a minute you get an address like `selah-abc.vercel.app`.
   - Under **Settings**, then **Domains**, you can change it to something nicer, such as `selah-annie.vercel.app`.

## Step 6 — Tell Supabase your web address

In Supabase, go to **Authentication**, then **URL Configuration**:
- set **Site URL** to your Vercel address, for example `https://selah-annie.vercel.app`;
- add the same address under **Redirect URLs** and click **Save**.

This makes the confirmation and password-reset emails open Selah.

## Step 7 — Install it

- **iPhone:** open your Selah address in **Safari**, then tap **Share**, then **Add to Home Screen**, then **Add**. The Selah sunrise icon appears on your home screen and opens full screen.
- **Android:** open it in **Chrome**, then **⋮**, then **Install app**.
- **Windows laptop:** open it in **Chrome** or **Edge** and click the **install icon** in the address bar (a little screen with an arrow).

Create your account with the **same email** you put in the SQL in Step 1. That makes you the admin, so **Profile** will show **See testers**.

## Step 8 — Invite your family and friend

1. Send them the Selah address and they each create their own account.
2. To be a family circle, everyone goes to **Profile**, enters the **same Family circle code** (for example `OKOYE-FAMILY`) and taps **Save**. You'll see when each other met with God and can send encouragement.
3. Prayers, the journal, the story people share and Ask chats stay private to each person. Even you, as admin, can't see them. You only see first names, topics and progress.

---

## Keeping costs safe

- **OpenAI:** in the **OpenAI dashboard**, set a **monthly budget limit**, for example $10.
- **Selah's daily limit:** `AI_DAILY_LIMIT` caps how many AI answers each person can get per day. When someone reaches it, Selah tells them kindly, and everything else keeps working.
- **n8n Cloud executions:** every AI answer is one execution. Roughly, people × answers per day × 30 should stay under your plan's monthly limit.
- **Supabase emails:** the built-in email sender only sends a few emails per hour. That's fine for family. When you open Selah to more people, add your own email sender under **Authentication**, then **SMTP**.

## Good to know

- **Separate progress:** this version has its own accounts, so progress from the Claude version doesn't move over automatically. Both can run side by side.
- **Offline:** once installed, the Bible chapters and photos you've opened stay available without internet. The AI parts need internet.
- **Microphone:** the "Pour out your heart" microphone works in the installed app in Safari and Chrome; it will ask permission the first time. The keyboard microphone also works.

## If something doesn't work

| What you see | What to check |
|---|---|
| The sign-in screen never appears, or Selah only saves "on this device" | `public/config.js` has the right Supabase URL and anon key |
| "Please confirm your email first" | Open the confirmation email (check Spam) and tap the link, then sign in |
| The confirmation link opens a broken page | Step 6: Site URL and Redirect URLs in Supabase |
| Reflections say "aren't available right now" and Ask doesn't answer | The n8n workflow is **Active**, the six Vercel variables are set, and you **redeployed** after adding them (Deployments, then ⋯, then Redeploy) |
| n8n shows "Authorization data is wrong" | The Header Auth name is exactly `x-selah-secret` and the value matches `N8N_SECRET` in Vercel |
| n8n's OpenAI node fails | Your OpenAI key has credit, and the model names in **Build OpenAI request** exist on your OpenAI account |
| "You've used today's AI help" | That's the daily limit. Raise `AI_DAILY_LIMIT` in Vercel and redeploy |
| You don't see **See testers** | You signed up with a different email from the one in the SQL. Change it in Supabase → **Table Editor** → `admins` |
