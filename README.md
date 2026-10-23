# Edgeloop

A job board for 3D artists. Every morning a script pulls open roles from studio job pages, keeps the 3D art ones, and saves them to `data/`. The site is a single `index.html` that reads that data, so it can be hosted for free as a static site.

## What's in here

| Path | What it does |
| --- | --- |
| `index.html` | The website. |
| `studios.json` | The studios to check, and which hiring platform each one uses. |
| `boards.json` | Search words and settings for the job boards (JobsPipe, Reed, Adzuna, JSearch). |
| `scripts/fetch-jobs.mjs` | Fetches every studio's jobs, filters to 3D art roles, and writes `data/jobs.json` and `data/jobs.js`. |
| `.github/workflows/update-jobs.yml` | Runs the script every day at 05:00 UTC on GitHub and commits the new data. |
| `data/` | The latest jobs. Updated automatically, so don't edit it by hand. |

## Putting it online (no coding tools needed)

1. **Make a GitHub repository.** Sign in to github.com, click **New repository**, name it `edgeloop`, make it **Public**, and create it.
2. **Upload the files.** On the new repo page, click **uploading an existing file**, drag in everything from this folder (including the `.github` folder), and click **Commit changes**.
   - Windows hides folders starting with a dot in some views. If `.github` doesn't upload, install [GitHub Desktop](https://desktop.github.com/), choose **Add existing repository**, pick this folder and publish it instead.
3. **Let the daily job save its results.** In the repo go to **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions** and save.
4. **Run it once now.** Go to the **Actions** tab, pick **Update jobs**, and click **Run workflow**. After a minute or two, `data/jobs.json` will have fresh jobs.
5. **Turn on the website.** Go to **Settings → Pages**, set **Source** to **Deploy from a branch**, choose `main` and `/ (root)`, and save. Your site appears at `https://<your-username>.github.io/edgeloop/` within a few minutes.

After that it updates itself every day. To use your own domain, add it under **Settings → Pages → Custom domain**.

## Adding job boards (JobsPipe, Reed, Adzuna and Google Jobs)

Studio job pages only cover studios you list. Job boards add everyone else: smaller studios, archviz and product viz firms, agencies and recruiters. Each board needs a key, and any board without a key is skipped.

| Board | What it adds | Get a key |
| --- | --- | --- |
| **JobsPipe** | LinkedIn, Indeed and other boards in one search. UK only by default. | jobspipe.dev (free plan: 1,000 credits that never refill) |
| **Reed** | UK jobs posted on reed.co.uk | Sign up at reed.co.uk/developers (free) |
| **Adzuna** | UK jobs gathered from many sites, plus salary estimates when an advert has none | Register at developer.adzuna.com (free tier) |
| **JSearch** (optional) | Google Jobs results, which include many LinkedIn and Indeed listings | Subscribe on RapidAPI (free tier, then paid) |

To add a key: in your GitHub repo go to **Settings → Secrets and variables → Actions → New repository secret** and add whichever of these you have:

- `JOBSPIPE_API_KEY`
- `REED_API_KEY`
- `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`
- `JSEARCH_API_KEY`

The next daily run picks them up. To test straight away, run the workflow from the Actions tab.

Never put a key in a file in this repo: the repo is public. Keys only go in GitHub secrets.

**JobsPipe credits:** JobsPipe charges one credit per job it returns (jobs already paid for are free again for the rest of that month). To make credits last, the first run collects the last 30 days, and every run after that only asks for jobs JobsPipe found since the previous run. Earlier JobsPipe listings are kept in `data/jobs.json` for 45 days. The run log on the Actions tab shows how many credits are left, and the free plan's credits don't refill. If you change the JobsPipe filters in `boards.json`, re-collect the last 30 days: add a repository variable `JOBSPIPE_BACKFILL` set to `1` (Settings → Secrets and variables → Actions → Variables), run the workflow once, then delete the variable. JobsPipe's server times out on big searches, so keep `pageSize` at 5.

**Staying inside free limits:** each run makes one Reed and one Adzuna call per search word in `boards.json` (10 words = 10 calls a day each), and one JSearch call per query (4 a day). Check each provider's current limits and trim the lists if needed.

**Rules to keep:**
- Adzuna's terms require a "Jobs by Adzuna" credit. The page adds it automatically when Adzuna listings are shown.
- Adzuna's estimated salaries are marked "Estimate" and are left out of the median pay figure.
- Board listings from studios already in `studios.json` are skipped, because the studio's own page is the better source.

**Why not LinkedIn or Indeed directly?** LinkedIn's user agreement bans scraping and it has sued scrapers. Indeed closed its public job search API in 2023 and its terms also ban scraping. JobsPipe and JSearch are data providers that collect those listings themselves and sell access, so the collecting is done under their terms, not this site's. Check their terms before relying on them for a commercial site.

## Adding a studio

Find the studio's careers page and click through to a job. The link tells you which platform they use:

| Link looks like | `ats` value | `token` is |
| --- | --- | --- |
| `job-boards.greenhouse.io/riotgames/...` or `boards.greenhouse.io/riotgames` | `greenhouse` | `riotgames` |
| `jobs.lever.co/studioname/...` | `lever` | `studioname` |
| `jobs.ashbyhq.com/studioname/...` | `ashby` | `studioname` |
| `jobs.smartrecruiters.com/StudioName/...` | `smartrecruiters` | `StudioName` |
| `apply.workable.com/studioname/...` | `workable` | `studioname` |

Then add a line to `studios.json`:

```json
{ "name": "Studio Name", "ats": "greenhouse", "token": "studiotoken", "industry": "Games", "hq": "London, UK" }
```

`industry` should be one of: Games, Film & TV, Animation, Archviz, Product viz, Advertising, XR.

Studios on Workday, Teamtailor, iCIMS or their own custom careers pages aren't supported yet. The run log on the Actions tab lists any studio that failed and why.

## Running it on your own computer

Install [Node.js](https://nodejs.org/) (version 20 or newer), then in this folder run:

```
node scripts/fetch-jobs.mjs
```

Open `index.html` in a browser to see the result.

## Good to know

- Pay is only shown when the studio lists it. Other currencies are converted to pounds using fixed rates at the top of `scripts/fetch-jobs.mjs`; update them now and then.
- Discipline, seniority, region and work mode are worked out from the job title and location text, so the odd role will be filed in the wrong place.
- The script only reads each platform's public job feed or official API, once a day, and links back to the original posting for applying.
- Job board listings are marked "Recruiter" when the company name looks like a recruitment agency. This is a guess from the name.
