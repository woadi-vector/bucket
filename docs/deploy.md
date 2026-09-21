# Deploying Bucket

Everything here needs credentials, so these are steps for a human with the Cloudflare and
GitHub accounts. Each one says what to check before moving on.

The end state is a public repo with an MIT license visible in the About section, and a demo URL
a judge can open with no login and no cost to them.

---

## 0. Before you start

```bash
npm install
npm run build
```

_Check:_ `✓ built in …` and no errors. If the build fails with `EBUSY … .output\public`, a
`wrangler dev` is still holding the directory — stop it first.

---

## 1. Cloudflare login

```bash
npx wrangler login
```

Opens a browser for OAuth.

_Check:_ `npx wrangler whoami` prints your account, not "You are not authenticated".

---

## 2. Create the database

```bash
npx wrangler d1 create bucket-db
```

It prints a block like:

```jsonc
{
  "d1_databases": [
    { "binding": "BUCKET_DB", "database_name": "bucket-db", "database_id": "xxxxxxxx-…" },
  ],
}
```

**Copy that `database_id`** into `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

_Check:_ `grep database_id wrangler.jsonc` shows a uuid, not the placeholder. This value is not
a secret and is meant to be committed.

---

## 3. Create the schema

```bash
npm run db:migrate:remote
```

_Check:_ both `0001_init.sql` and `0002_model_usage.sql` report ✅, then:

```bash
npm run db:tables
```

Expect `d1_migrations`, `model_usage`, `sessions`, `transactions`.

> **Use the npm script, not `npx wrangler d1 migrations apply` directly.**
>
> After a build, `.wrangler/deploy/config.json` redirects wrangler to the _generated_
> `.output/server/wrangler.json`, whose `migrations_dir` points at a directory that does not
> exist there. A bare `wrangler d1 migrations apply` silently reports **"No migrations to
> apply!"** and creates nothing. The app then deploys and appears to work — it falls back to an
> unsaved seed when the tables are missing — while nothing persists. The npm scripts all pass
> `--config wrangler.jsonc` to force the root config.

---

## 4. Set the API key

```bash
npx wrangler secret put NEBIUS_API_KEY
```

Paste the key when prompted. It is stored by Cloudflare and never written to the repo.

_Check:_ `npx wrangler secret list` shows `NEBIUS_API_KEY`. The value is not displayed, which is
the point.

> Do not put the key in `wrangler.jsonc` under `vars`. That file is committed.

---

## 5. Deploy

```bash
npm run build
npx wrangler deploy
```

_Check:_ it prints a `https://bucket.<your-subdomain>.workers.dev` URL. That is the demo URL.

---

## 6. Verify the deploy like a judge would

Open the URL **in a private window** — that is the cold-open path a judge takes.

1. The app loads already populated: four buckets, a hero number, one item in the Sleep On It
   tray. An empty app means the seed did not run.
2. Make a purchase and refresh. It is still there → D1 is wired.
3. Tag something a _need_ that your history undermines (the seeded history is set up for this —
   confirm the tray item). Within a few seconds the retraction card appears with a written
   argument → Token Factory is wired.
4. Press **Put it back** → the money returns to its bucket and the item moves to the tray.

Then confirm no key leaked into anything the browser downloads:

```bash
npm run check:secrets
```

_Check:_ `Clean: no secret value or name appears in client output.`

And confirm the tiering actually split:

```bash
npm run db:spend
```

_Check:_ `nano` has more calls than `ultra`. If `ultra` matches `nano`, escalation is firing on
agreements and something is wrong.

---

## 7. Publish the repo

The hackathon rules require a public repo with an OSS license visible in the GitHub About
section.

```bash
# one-time, if you do not have it
winget install GitHub.cli
gh auth login

gh repo create bucket --public --source=. --remote=origin --push
```

_Check:_

- The About section shows **MIT**. If not, GitHub did not detect `LICENSE` — confirm it is at the
  repo root and unmodified.
- `git log --oneline | wc -l` matches what GitHub shows.
- **Nothing secret was pushed.** Run this before and after:

```bash
node -e "const{readFileSync}=require('fs'),{execSync}=require('child_process');const k=(readFileSync('.dev.vars','utf8').match(/NEBIUS_API_KEY\s*=\s*(.+)/)||[])[1]?.trim();if(!k){console.log('no key');process.exit(0)}console.log(execSync('git log -p --all',{maxBuffer:3e8}).toString().includes(k)?'*** LEAK ***':'clean: key in no commit')"
```

---

## Budget

Spend is capped in `src/lib/server/budget.ts`: a global ceiling of **$10**, plus 60 verdicts and
10 escalations per session. At measured rates a verdict costs 64–73 µ$, so $10 is roughly 144,000
Nano verdicts. The cap exists to bound a runaway loop or someone hammering a login-free endpoint,
not to ration the budget.

To watch spend on the live site:

```bash
npm run db:spend
```

If the guard starts declining calls, raise `BUDGET.totalUsd` and redeploy. The app does not break
when capped — the engine degrades to agreeing with the user.

---

## If something is wrong

**App loads but is empty, and nothing persists across a refresh.** Either the tables were never
created (see the warning in step 3 — check `npm run db:tables`) or the D1 binding is missing. Check `wrangler.jsonc` has the real
`database_id` and that you rebuilt after changing it — the binding is copied into
`.output/server/wrangler.json` at build time.

**Verdicts never appear.** The key is not set, or the budget guard is declining. Check
`npx wrangler tail` for `[verdict] budget guard declined` or `NEBIUS_API_KEY is not set`.

**Everything agrees with you.** Also the fallback path — the engine degrades to agreeing when it
cannot get a real answer, so universal agreement means the model is not being reached.

**Verdicts are empty or unparseable.** Check `max_tokens`. A truncated response returns HTTP 200
with empty content; see [token-factory-findings.md](token-factory-findings.md) §3.
