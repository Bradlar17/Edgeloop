// Pulls open roles from each studio's public job board, plus job board APIs (Reed, Adzuna,
// and optionally JSearch for Google Jobs listings), keeps the 3D art ones, and writes
// data/jobs.json (for anything else to use) and data/jobs.js (for the page).
// Run with Node 20+: node scripts/fetch-jobs.mjs
// Job board keys come from environment variables; any board without a key is skipped.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'EdgeloopJobsBot/1.0 (3D art job board; daily fetch)';

// Approximate rates to GBP. Good enough for comparing roles; update now and then.
const TO_GBP = { GBP: 1, USD: 0.79, EUR: 0.85, CAD: 0.575, AUD: 0.52, NZD: 0.47, SEK: 0.075, NOK: 0.073, DKK: 0.114, PLN: 0.2, CHF: 0.9, JPY: 0.0052, KRW: 0.00057, SGD: 0.59, INR: 0.0094 };
const PER_YEAR = { yr: 1, day: 220, hr: 1760 };

// ---------- Which titles count as 3D art roles ----------
const INCLUDE = /\b(artist|animator|animation|rigg(?:er|ing)|technical art|tech art|lighting|lighter|vfx|fx|modell?er|modell?ing|textur\w*|surfac\w*|look ?dev\w*|art director|art lead|lead art|head of art|sculpt\w*|3d|cg|cgi|character td|creature td|groom\w*|matte painter|visuali[sz]er)\b/i;
const EXCLUDE = /\b(engineer|programm\w*|developer|produc\w*|recruit\w*|assistant\.?e?|head of (?!art)|partenaire|rh|user interface|technical designer|marketing|community|audio|sound|music|qa|tester|test|writer|narrative|analyst|scientist|sales|account|finance|legal|hr|people partner|ux|ui|2d|concept|illustrat\w*|storyboard|graphic designer|motion graphics|brand|copy|social|video|editor|coordinator|game designer|level designer|systems designer|economy|monetization|monetisation|product manager|project manager|director of (?!art)|make-?up|nail|tattoo|recording|mural|florist|floral|beauty|lash|brow|hair stylist|barber|cake|signwriter|sign writer|teacher|lecturer|tutor|crane|scaffold\w*|steel|erector|offshore|deck|loler|cpcs|seating|gaffer|telecoms?|splicing|electrician|multimedia|motion designer)\b/i;
// Japanese titles (common at Keywords Studios Tokyo) have no word boundaries, so they get their own check.
const JA_ART = /アーティスト|アニメーター|リガー/;
export const isArtRole = t => (INCLUDE.test(t) || JA_ART.test(t)) && !EXCLUDE.test(t);
// Job board searches pull in a lot of non-3D "artist" roles, so board listings must also mention 3D work.
// Tools and industries only: words like "rigger" or "animation" appear in the titles being checked, so they prove nothing.
const THREE_D = /\b(3d|cg|cgi|maya|blender|zbrush|unreal|unity|houdini|substance|3ds ?max|cinema ?4d|c4d|v-?ray|corona|redshift|arnold|nuke|motionbuilder|toon ?boom|game|games|gaming|vfx|render\w*|archviz|feature animation|animated (series|features?|films?)|cinematics?)\b/i;
export const looksLike3D = (title, desc) => THREE_D.test(title) || THREE_D.test(desc || '');

// Order matters: the first rule that matches wins.
const DISC_RULES = [
  ['Technical Art', /tech(nical)? art|artiste technique|pipeline td|shader|テクニカル/i],
  ['Rigging', /rigg|technical animator|character td|creature td|リガー/i],
  ['Art Direction', /art director|head of art|directeur.{0,12}art/i],
  ['Animation', /animat|アニメ/i],
  ['VFX', /\bvfx\b|\bc?fx\b|effects|effets|compositing|\broto\b|paint artist|matchmove|mmra|crowd|エフェクト/i],
  ['Lighting', /light|éclairage|ライティング/i],
  ['Hard Surface', /hard[- ]surface|vehicle|weapon|mech\b/i],
  ['Texturing', /textur|surfac|look ?dev|material/i],
  ['Character', /character|personnage|creature|sculpt|groom|hair|キャラクター/i],
  ['Environment', /environ|world|level art|niveau|landscape|terrain|背景/i],
  ['Props', /\bprops?\b/i],
  ['Modelling', /model|modél/i]
];
export const discipline = t => (DISC_RULES.find(([, re]) => re.test(t)) || ['Generalist'])[0];

export function level(t) {
  if (/principal|director|directeur|directrice|head of|staff/i.test(t)) return 'Principal+';
  if (/\blead\b|supervisor|superviseur|manager|chef/i.test(t)) return 'Lead';
  if (/senior|sénior|\bsr\.?\b|expert|シニア/i.test(t)) return 'Senior';
  if (/junior|\bjr\.?\b|graduate|intern|associate|entry|trainee|apprentice/i.test(t)) return 'Junior';
  return 'Mid';
}

function workMode(hint, loc, title) {
  const h = String(hint || '').toLowerCase();
  if (h.includes('hybrid')) return 'Hybrid';
  if (h.includes('remote')) return 'Remote';
  if (h.includes('onsite') || h.includes('on-site') || h.includes('office')) return 'On-site';
  const s = `${loc} ${title}`.toLowerCase();
  if (s.includes('hybrid')) return 'Hybrid';
  if (s.includes('remote')) return 'Remote';
  return 'Not stated';
}

function contractType(hint, title) {
  const s = `${hint || ''} ${title}`.toLowerCase();
  if (/intern/.test(s)) return 'Internship';
  if (/contract|temporary|temp\b|fixed[- ]term|freelance/.test(s)) return 'Contract';
  if (/part[- _]?time/.test(s)) return 'Part-time';
  if (/full[- _]?time|permanent/.test(s)) return 'Full-time';
  return 'Not stated';
}

// Studios in studios.json have a known industry; board listings are guessed from their text.
export function industryFromText(text) {
  const s = String(text || '');
  if (/\b(arch-?viz|architectural (visuali[sz]\w*|render\w*|3d|cgi)|interior visuali[sz]\w*)\b/i.test(s)) return 'Archviz';
  if (/\b(game|games|gaming|unreal|unity|playstation|xbox|console)\b/i.test(s)) return 'Games';
  if (/\bfeature animation\b/i.test(s)) return 'Animation';
  if (/\b(vfx|feature films?|episodic|tv series|television|post-?production)\b/i.test(s)) return 'Film & TV';
  if (/\b(vr|ar|xr|virtual reality|augmented reality|mixed reality)\b/i.test(s)) return 'XR';
  if (/\b(advertising|ad agency|campaigns?|commercials)\b/i.test(s)) return 'Advertising';
  if (/\b(product visuali[sz]\w*|e-?commerce|furniture|packaging|retail)\b/i.test(s)) return 'Product viz';
  if (/\banimat(ed|ion) (series|features?|studio|films?)\b/i.test(s)) return 'Animation';
  return 'Other';
}
const RECRUITER = /\b(recruit\w*|resourcing|staffing|personnel|talent|headhunt\w*|consultancy|hays|randstad|adecco|michael page|amiqus|search partners)\b/i;

const UK = /\b(uk|gb|united kingdom|great britain|england|scotland|wales|northern ireland|london|manchester|guildford|leamington|brighton|dundee|edinburgh|glasgow|bristol|sheffield|cambridge|oxford|liverpool|newcastle|nottingham|birmingham|leeds|warwick|surrey|derby|cardiff|belfast|bath|reading|farnborough|milton keynes|runcorn|horsham|wilmslow|banbury|stockport|southam|chertsey|wakefield|bournemouth|norwich|brighton|york|southampton|portsmouth|leicester|coventry|exeter|plymouth|aberdeen|swansea|kent|essex|hertfordshire|berkshire|hampshire|lancashire|yorkshire|cheshire|devon|sussex)\b/i;
const EU = /\b(europe|emea|eu|germany|france|spain|sweden|finland|poland|netherlands|ireland|denmark|norway|italy|portugal|czech\w*|romania|belgium|austria|switzerland|hungary|ukraine|serbia|croatia|bulgaria|estonia|latvia|lithuania|greece|turkey|cyprus|malta|iceland|berlin|munich|hamburg|frankfurt|paris|lyon|montpellier|bordeaux|stockholm|malmö|malmo|gothenburg|uppsala|helsinki|warsaw|krak[oó]w|wroc[lł]aw|amsterdam|utrecht|dublin|copenhagen|barcelona|madrid|valencia|lisbon|porto|oslo|prague|brno|bucharest|vienna|zurich|geneva|budapest|kyiv|belgrade|milan|rome|ghent)\b/i;
const NA = /\b(north america|americas|united states|usa|u\.s\.|us|canada|california|texas|washington|new york|oregon|massachusetts|north carolina|illinois|florida|colorado|seattle|bellevue|redmond|kirkland|los angeles|santa monica|san francisco|san mateo|irvine|san diego|austin|dallas|boston|chicago|raleigh|cary|burbank|montr[eé]al|vancouver|toronto|quebec|qu[eé]bec|ottawa|edmonton|calgary|halifax|mexico)\b/i;
const APAC = /\b(apac|asia|japan|tokyo|osaka|korea|seoul|china|shanghai|beijing|shenzhen|hong kong|singapore|australia|sydney|melbourne|brisbane|adelaide|india|bangalore|bengaluru|pune|hyderabad|new zealand|auckland|wellington|malaysia|kuala lumpur|philippines|manila|taiwan|taipei|vietnam|thailand|bangkok|indonesia)\b/i;
export function region(loc) {
  if (UK.test(loc)) return 'UK';
  if (EU.test(loc)) return 'Europe';
  if (NA.test(loc)) return 'North America';
  if (APAC.test(loc)) return 'Asia-Pacific';
  return 'Other';
}

// ---------- Text helpers ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', pound: '£', euro: '€', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•' };
const decode = s => String(s || '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const plain = html => decode(decode(String(html || ''))
  .replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, '\n')
  .replace(/<li[^>]*>/gi, '• ')
  .replace(/<[^>]+>/g, ' '))
  .replace(/[ \t ]+/g, ' ')
  .replace(/\s*\n\s*/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
const norm = s => String(s || '').toLowerCase().replace(/\b(ltd|limited|inc|llc|plc|gmbh|studios?|games|entertainment)\b/g, '').replace(/[^a-z0-9]+/g, '');

// Finds a salary range written in a job description, e.g. "£45,000 - £55,000" or "$90k–$120k".
const CUR = '(£|€|CA\\$|C\\$|US\\$|\\$|GBP|USD|EUR|CAD)';
const NUM = '(\\d{1,3}(?:[,.]\\d{3})+|\\d{2,3}(?:\\.\\d)?\\s?[kK])';
const SAL_RE = new RegExp(`${CUR}\\s?${NUM}\\s*(?:-|–|—|to)\\s*(?:${CUR})?\\s?${NUM}`);
const toNum = s => /k$/i.test(s.trim()) ? parseFloat(s) * 1000 : Number(s.replace(/[,.](?=\d{3}\b)/g, ''));
export function salaryFromText(text, loc) {
  const m = SAL_RE.exec(text || '');
  if (!m) return null;
  const sym = m[1].toUpperCase();
  const cur = sym === '£' || sym === 'GBP' ? 'GBP' : sym === '€' || sym === 'EUR' ? 'EUR'
    : /^C/.test(sym) ? 'CAD' : sym === 'US$' || sym === 'USD' ? 'USD' : /canada/i.test(loc) ? 'CAD' : 'USD';
  const min = toNum(m[2]), max = toNum(m[4]);
  if (!(min >= 12000 && max >= min && max <= 800000)) return null;
  return { min, max, cur, per: 'yr' };
}
// Works out pay per year/day/hour from the size of the numbers, for boards that don't say.
const perFromSize = max => max < 200 ? 'hr' : max < 2000 ? 'day' : 'yr';
function withGbp(s) {
  if (!s || !TO_GBP[s.cur] || !(s.min > 0) || !(s.max >= s.min)) return null;
  return { ...s, gbp: Math.round(((s.min + s.max) / 2) * PER_YEAR[s.per] * TO_GBP[s.cur]) };
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// ---------- Studio job pages: one fetcher per hiring platform, all returning the same raw shape ----------
const FETCHERS = {
  async greenhouse(t) {
    const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`);
    return d.jobs.map(j => {
      const desc = plain(j.content);
      const loc = j.location?.name || '';
      return { title: j.title, loc, url: j.absolute_url, posted: j.first_published || j.updated_at, desc, salary: salaryFromText(desc, loc) };
    });
  },
  async lever(t) {
    const d = await getJson(`https://api.lever.co/v0/postings/${t}?mode=json`);
    return d.map(j => {
      const desc = [j.descriptionPlain, ...(j.lists || []).map(l => `${l.text}\n${plain(l.content)}`), j.additionalPlain].filter(Boolean).join('\n\n');
      const loc = j.categories?.allLocations?.join(' / ') || j.categories?.location || '';
      const sr = j.salaryRange;
      const salary = sr && sr.min && sr.max && /year|hour/.test(sr.interval || '')
        ? { min: sr.min, max: sr.max, cur: sr.currency, per: /hour/.test(sr.interval) ? 'hr' : 'yr' }
        : salaryFromText(desc, loc);
      return { title: j.text, loc, url: j.hostedUrl, posted: new Date(j.createdAt).toISOString(), desc, salary, modeHint: j.workplaceType, typeHint: j.categories?.commitment };
    });
  },
  async ashby(t) {
    const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`);
    return d.jobs.filter(j => j.isListed !== false).map(j => {
      const desc = j.descriptionPlain || plain(j.descriptionHtml);
      const loc = [j.location, ...(j.secondaryLocations || []).map(s => s.location)].filter(Boolean).join(' / ');
      const c = j.compensation?.summaryComponents?.find(x => x.compensationType === 'Salary' && x.minValue && x.maxValue);
      const salary = c && /YEAR|HOUR/.test(c.interval || '')
        ? { min: c.minValue, max: c.maxValue, cur: c.currencyCode, per: /HOUR/.test(c.interval) ? 'hr' : 'yr' }
        : salaryFromText(desc, loc);
      return { title: j.title, loc, url: j.jobUrl, posted: j.publishedAt, desc, salary, modeHint: j.workplaceType || (j.isRemote ? 'remote' : ''), typeHint: j.employmentType };
    });
  },
  async smartrecruiters(t) {
    const all = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100&offset=${offset}`);
      all.push(...d.content);
      if (offset + 100 >= d.totalFound) break;
    }
    const out = [];
    for (const j of all) {
      if (!isArtRole(j.name)) continue;
      const loc = j.location?.fullLocation || [j.location?.city, j.location?.country].filter(Boolean).join(', ');
      let desc = '';
      try {
        const full = await getJson(`https://api.smartrecruiters.com/v1/companies/${t}/postings/${j.id}`);
        const sec = full.jobAd?.sections || {};
        desc = plain([sec.jobDescription?.text, sec.qualifications?.text, sec.additionalInformation?.text].filter(Boolean).join('\n'));
      } catch { /* description is optional */ }
      out.push({
        title: j.name, loc, url: `https://jobs.smartrecruiters.com/${t}/${j.id}`, posted: j.releasedDate, desc, salary: salaryFromText(desc, loc),
        modeHint: j.location?.hybrid ? 'hybrid' : j.location?.remote ? 'remote' : '', typeHint: j.typeOfEmployment?.label
      });
    }
    out.total = all.length; // only art roles are returned, so report the full count separately
    return out;
  },
  async workable(t) {
    const d = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${t}?details=true`);
    return d.jobs.map(j => {
      const desc = plain(j.description);
      const loc = [j.city, j.state, j.country].filter(Boolean).join(', ');
      return { title: j.title, loc, url: j.url || j.shortlink, posted: j.published_on || j.created_at, desc, salary: salaryFromText(desc, loc), modeHint: j.telecommuting ? 'remote' : '', typeHint: j.employment_type };
    });
  }
};

// ---------- Job boards: each needs a key, searches by keyword, and returns raw roles with a company name ----------
const ADZUNA_CUR = { gb: 'GBP', us: 'USD', ca: 'CAD', au: 'AUD', nz: 'NZD', de: 'EUR', fr: 'EUR', nl: 'EUR', es: 'EUR', it: 'EUR', at: 'EUR', be: 'EUR', pl: 'PLN', sg: 'SGD', in: 'INR', ch: 'CHF' };

export function normalizeAdzuna(r, country) {
  const min = Number(r.salary_min) || 0, max = Number(r.salary_max) || min;
  return {
    title: r.title ? plain(r.title) : '', company: r.company?.display_name || '', loc: r.location?.display_name || '',
    url: r.redirect_url, posted: r.created, desc: plain(r.description),
    salary: min ? { min: Math.round(min), max: Math.round(max), cur: ADZUNA_CUR[country] || 'GBP', per: perFromSize(max), est: String(r.salary_is_predicted) === '1' } : null,
    typeHint: [r.contract_type, r.contract_time].filter(Boolean).join(' '), via: 'Adzuna'
  };
}
export function normalizeReed(r) {
  const [dd, mm, yyyy] = String(r.date || '').split('/');
  const min = Number(r.minimumSalary) || 0, max = Number(r.maximumSalary) || min;
  return {
    title: r.jobTitle || '', company: r.employerName || '', loc: r.locationName || '',
    url: r.jobUrl, posted: yyyy ? `${yyyy}-${mm}-${dd}T00:00:00Z` : null, desc: plain(r.jobDescription),
    salary: min ? { min, max, cur: r.currency || 'GBP', per: perFromSize(max) } : null, via: 'Reed'
  };
}
export function normalizeJsearch(r) {
  const loc = [r.job_city, r.job_state, r.job_country].filter(Boolean).join(', ');
  const desc = String(r.job_description || '');
  const per = { YEAR: 'yr', HOUR: 'hr', DAY: 'day' }[String(r.job_salary_period || '').toUpperCase()];
  const salary = r.job_min_salary && r.job_max_salary && per
    ? { min: r.job_min_salary, max: r.job_max_salary, cur: r.job_salary_currency || 'USD', per }
    : salaryFromText(desc, loc);
  return {
    title: r.job_title || '', company: r.employer_name || '', loc, url: r.job_apply_link || r.job_google_link,
    posted: r.job_posted_at_datetime_utc, desc, salary, modeHint: r.job_is_remote ? 'remote' : '', typeHint: r.job_employment_type,
    via: r.job_publisher || 'Google Jobs'
  };
}

const PROVIDER_NAME = { linkedin: 'LinkedIn', indeed: 'Indeed', glassdoor: 'Glassdoor', remoteok: 'RemoteOK', himalayas: 'Himalayas', workday: 'Workday', greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby' };
export function normalizeJobspipe(r) {
  const provider = r.sources?.[0]?.provider || '';
  const min = r.min_annual_salary, max = r.max_annual_salary;
  return {
    title: r.job_title || '', company: r.company || r.company_object?.name || '', loc: r.location || r.country || '',
    url: r.url || r.source_url || r.sources?.[0]?.url, posted: r.date_posted || r.discovered_at, desc: String(r.description || ''),
    salary: min && max && r.salary_currency ? { min, max, cur: r.salary_currency, per: 'yr', est: r.salary_type === 'estimated' } : null,
    modeHint: r.work_arrangement || (r.remote ? 'remote' : r.hybrid ? 'hybrid' : ''), typeHint: (r.employment_statuses || []).join(' '),
    via: PROVIDER_NAME[provider] || provider || 'JobsPipe', agency: r.employer_type ? r.employer_type !== 'employer' : undefined
  };
}
const jpTime = d => d.toISOString().slice(0, 19).replace('T', ' ');

const BOARDS = {
  // JobsPipe charges a credit per job returned, so after the first backfill it only asks for jobs found since the last run.
  async jobspipe(cfg, env, ctx) {
    if (!env.JOBSPIPE_API_KEY) return null;
    const body = {
      job_title_or: cfg.titles, job_title_not: cfg.titlesNot, job_country_code_or: cfg.countries || ['GB'],
      limit: cfg.pageSize || 10 // larger pages, or adding order_by, make their gateway time out (HTTP 504)
    };
    if (ctx.jobspipeSince) body.discovered_at_gte = ctx.jobspipeSince;
    else body.posted_at_max_age_days = cfg.backfillDays || 30;
    const out = [];
    let cursor = null, credits = null;
    const post = () => fetch('https://api.jobspipe.dev/v1/jobs/search', {
      method: 'POST', signal: AbortSignal.timeout(120000), // searches with many title filters can take a while
      headers: { Authorization: `Bearer ${env.JOBSPIPE_API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(cursor ? { ...body, cursor } : body)
    });
    do {
      let res = await post();
      if (res.status === 504 || res.status === 503) res = await post(); // their gateway times out now and then; one retry
      if (res.status === 402) throw new Error('Out of JobsPipe credits');
      if (!res.ok) throw new Error(`HTTP ${res.status} from api.jobspipe.dev`);
      const d = await res.json();
      out.push(...(d.data || []).map(normalizeJobspipe));
      cursor = d.metadata?.next_cursor;
      credits = d.metadata?.credits_remaining ?? credits;
    } while (cursor && out.length < (cfg.maxPerRun || 150));
    out.creditsRemaining = credits;
    return out;
  },
  async adzuna(cfg, env) {
    if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) return null;
    const out = [];
    for (const country of cfg.countries || ['gb']) {
      for (const kw of cfg.keywords) {
        const q = new URLSearchParams({ app_id: env.ADZUNA_APP_ID, app_key: env.ADZUNA_APP_KEY, results_per_page: '50', what: kw, max_days_old: String(cfg.maxDaysOld || 30), sort_by: 'date', 'content-type': 'application/json' });
        const d = await getJson(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${q}`);
        out.push(...(d.results || []).map(r => normalizeAdzuna(r, country)));
      }
    }
    return out;
  },
  async reed(cfg, env) {
    if (!env.REED_API_KEY) return null;
    const auth = 'Basic ' + Buffer.from(`${env.REED_API_KEY}:`).toString('base64');
    const out = [];
    for (const kw of cfg.keywords) {
      const q = new URLSearchParams({ keywords: kw, resultsToTake: '100' });
      const d = await getJson(`https://www.reed.co.uk/api/1.0/search?${q}`, { Authorization: auth });
      out.push(...(d.results || []).map(normalizeReed));
    }
    return out;
  },
  async jsearch(cfg, env) {
    if (!env.JSEARCH_API_KEY) return null;
    const out = [];
    for (const query of cfg.queries || []) {
      const q = new URLSearchParams({ query, page: '1', num_pages: '1', date_posted: cfg.datePosted || 'week' });
      const d = await getJson(`https://jsearch.p.rapidapi.com/search?${q}`, { 'X-RapidAPI-Key': env.JSEARCH_API_KEY, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' });
      out.push(...(d.data || []).map(normalizeJsearch));
    }
    return out;
  }
};
const BOARD_NAMES = { jobspipe: 'JobsPipe', adzuna: 'Adzuna', reed: 'Reed', jsearch: 'JSearch (Google Jobs)' };
const BOARD_KEEP_DAYS = 45; // incremental board listings are carried over between runs for this long

function toJob(r, { studio, industry, hq, source }) {
  const loc = r.loc || hq || '';
  const company = studio || r.company || 'Company not given';
  return {
    id: '',
    title: r.title.trim(),
    studio: company,
    industry: industry || industryFromText(`${r.title} ${company} ${r.desc}`),
    location: loc,
    region: region(loc),
    mode: workMode(r.modeHint, loc, r.title),
    type: contractType(r.typeHint, r.title),
    disc: discipline(r.title),
    level: level(r.title),
    salary: withGbp(r.salary),
    posted: r.posted && !isNaN(new Date(r.posted)) ? new Date(r.posted).toISOString() : null,
    url: r.url,
    source,
    via: r.via || null,
    recruiter: !studio && (r.agency ?? RECRUITER.test(company)),
    desc: (r.desc || '').slice(0, 900)
  };
}

async function main() {
  const studios = JSON.parse(await readFile(path.join(ROOT, 'studios.json'), 'utf8'));
  let boardCfg = {};
  try { boardCfg = JSON.parse(await readFile(path.join(ROOT, 'boards.json'), 'utf8')); } catch { /* boards are optional */ }
  let prev = null;
  try { prev = JSON.parse(await readFile(path.join(ROOT, 'data', 'jobs.json'), 'utf8')); } catch { /* first run */ }
  const runStarted = new Date();
  const jobs = [];
  const report = [];
  const seenUrl = new Set();
  const seenRole = new Set(); // company + title, so the same role from two sources only shows once
  const roleKey = (company, title) => `${norm(company)}|${norm(title)}`;
  // Boards often list one role under several company names (e.g. "ILM UK" and "Lucasfilm").
  // A long, specific title is distinctive enough to dedupe on by itself; short ones like "3D Artist" aren't.
  const seenLongTitle = new Set();
  const longTitleKey = title => { const t = norm(title); return t.length >= 25 ? t : null; };
  const isDuplicate = (company, title, url) => seenUrl.has(url) || seenRole.has(roleKey(company, title)) || seenLongTitle.has(longTitleKey(title));
  const remember = (company, title, url) => { seenUrl.add(url); seenRole.add(roleKey(company, title)); const lt = longTitleKey(title); if (lt) seenLongTitle.add(lt); };

  for (const s of studios) {
    const fetcher = FETCHERS[s.ats];
    if (!fetcher) { report.push({ name: s.name, kind: 'studio', ok: false, error: `Unknown platform "${s.ats}"` }); continue; }
    try {
      const raw = await fetcher(s.token);
      let art = 0;
      for (const r of raw) {
        if (!r.title || !r.url || !isArtRole(r.title) || seenUrl.has(r.url)) continue;
        remember(s.name, r.title, r.url);
        art++;
        jobs.push(toJob(r, { studio: s.name, industry: s.industry, hq: s.hq, source: s.ats }));
      }
      const total = raw.total ?? raw.length;
      report.push({ name: s.name, kind: 'studio', ok: true, total, art });
      console.log(`✓ ${s.name}: ${art} art roles of ${total}`);
    } catch (e) {
      report.push({ name: s.name, kind: 'studio', ok: false, error: e.message });
      console.warn(`✗ ${s.name}: ${e.message}`);
    }
  }

  // Studios with their own feed are already covered directly, so board copies of their roles are skipped.
  const studioNames = new Set(studios.map(s => norm(s.name)));

  // JobsPipe only returns jobs found since the last run, so keep the ones fetched before (until they're old).
  const keepAfter = Date.now() - BOARD_KEEP_DAYS * 864e5;
  let carried = 0;
  for (const j of prev?.jobs || []) {
    if (j.source !== 'jobspipe' || !j.posted || new Date(j.posted) < keepAfter) continue;
    // Re-check and re-sort with the current rules, so rule fixes apply to listings already paid for.
    if (!isArtRole(j.title) || !looksLike3D(j.title, j.desc)) continue;
    if (isDuplicate(j.studio, j.title, j.url) || studioNames.has(norm(j.studio))) continue;
    remember(j.studio, j.title, j.url); carried++;
    jobs.push({ ...j, disc: discipline(j.title), level: level(j.title), region: region(j.location), industry: industryFromText(`${j.title} ${j.studio} ${j.desc}`) });
  }
  if (carried) console.log(`↺ Kept ${carried} JobsPipe roles from earlier runs`);
  // JOBSPIPE_BACKFILL=1 re-fetches the last 30 days, e.g. after changing filters (jobs already paid for this month are free).
  const ctx = { jobspipeSince: process.env.JOBSPIPE_BACKFILL ? null : prev?.jobspipeSince || null };
  let jobspipeSince = prev?.jobspipeSince || null;
  let jobspipeCredits = prev?.jobspipeCredits ?? null;

  for (const [key, run] of Object.entries(BOARDS)) {
    const cfg = { keywords: boardCfg.keywords || [], ...(boardCfg[key] || {}) };
    if (cfg.enabled === false) continue;
    const name = BOARD_NAMES[key];
    try {
      const raw = await run(cfg, process.env, ctx);
      if (raw === null) { report.push({ name, kind: 'board', ok: false, skipped: true, error: 'No API key set' }); console.log(`– ${name}: skipped, no API key`); continue; }
      if (key === 'jobspipe') {
        // Overlap by an hour so nothing found mid-run is missed; repeats are free within the month and deduped here.
        jobspipeSince = jpTime(new Date(runStarted.getTime() - 3600e3));
        jobspipeCredits = raw.creditsRemaining ?? jobspipeCredits;
        console.log(`  JobsPipe credits left: ${jobspipeCredits}`);
      }
      let art = 0;
      for (const r of raw) {
        if (!r.title || !r.url || seenUrl.has(r.url)) continue;
        if (!isArtRole(r.title) || !looksLike3D(r.title, r.desc)) continue;
        if (studioNames.has(norm(r.company)) || isDuplicate(r.company, r.title, r.url)) continue;
        remember(r.company, r.title, r.url);
        art++;
        jobs.push(toJob(r, { source: key }));
      }
      report.push({ name, kind: 'board', ok: true, total: raw.length, art });
      console.log(`✓ ${name}: ${art} new art roles of ${raw.length} results`);
    } catch (e) {
      report.push({ name, kind: 'board', ok: false, error: e.message });
      console.warn(`✗ ${name}: ${e.message}`);
    }
  }

  const okCount = report.filter(r => r.ok).length;
  if (okCount === 0) {
    console.error('Every source failed. Keeping the previous data.');
    process.exit(1);
  }

  jobs.sort((a, b) => (b.posted || '').localeCompare(a.posted || ''));
  jobs.forEach((j, i) => { j.id = String(i); });
  const studioReports = report.filter(r => r.kind === 'studio');
  const data = {
    generatedAt: new Date().toISOString(),
    studiosChecked: studioReports.length,
    studiosOk: studioReports.filter(r => r.ok).length,
    boards: [...new Set([...report.filter(r => r.kind === 'board' && r.ok).map(r => r.name), ...(carried ? ['JobsPipe'] : [])])],
    jobspipeSince,
    jobspipeCredits,
    jobs,
    report
  };
  await mkdir(path.join(ROOT, 'data'), { recursive: true });
  await writeFile(path.join(ROOT, 'data', 'jobs.json'), JSON.stringify(data, null, 1));
  await writeFile(path.join(ROOT, 'data', 'jobs.js'), `window.EDGELOOP = ${JSON.stringify(data)};\n`);
  console.log(`\nSaved ${jobs.length} art roles from ${okCount} sources.`);
}

// Run only when called directly, so the helpers above can be imported for testing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
