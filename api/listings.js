// Vercel Serverless Function — GET /api/listings
// InternRun: pan-European internship listings, one place, no signup wall (MVP decision 2026-08-04).
//
// Two kinds of entries, both returned together:
//  1. CURATED — hand-maintained list of well-known internship programmes (EU institutions, big
//     tech/finance employers, research bodies) and the major aggregator platforms students should
//     know about (JobTeaser, GoAbroad, ErasmusIntern, IAESTE, etc). Same approach Roomrun uses for
//     agencies with no-scraping policies: no legal risk, refreshed by hand periodically.
//  2. LIVE — currently just the "Highlights" block on the official EU Careers traineeships page
//     (eu-careers.europa.eu), which is public EU government information explicitly meant to be
//     found (robots.txt allows it, no ToS restriction). Only 2-3 items at a time by design of that
//     page — small but genuinely real-time. More live sources to follow once vetted the same way
//     Rightmove/OnTheMarket/Alba were vetted for Roomrun.
//
// Filtering fields (added 2026-08-25):
//  - countries: string[] — clean European country names, or ['Multiple countries'] for programmes
//    that run across many offices/countries at once. Used to populate the country dropdown, so it
//    never shows raw location prose ("17,500+ programmes", "80+ countries", etc) as a fake country.
//  - season: ('summer'|'spring'|'other')[] — when the programme actually runs. 'summer' = the
//    standard Jun-Sep student internship window. 'spring' = a round that starts roughly Feb-Apr
//    (inferred from published intake/deadline months where we have them). 'other' = rolling intake,
//    a single autumn/winter round, multi-month structured traineeships, or aggregator directories
//    with no fixed season. Traineeships that run two rounds a year get both tags.
//  - paid: true | false | 'mixed' — 'mixed' means the programme has both paid and unpaid tracks, or
//    (for directories) links out to a mix of paid and unpaid postings.
const { convert } = require('html-to-text');

// Known EU institutions/agencies/bodies, copied verbatim from the "Institution/EU body" filter
// dropdown on the traineeships page. Used as a closed vocabulary to anchor the live parser below:
// without this, there's no reliable delimiter between "end of institution name" and "start of the
// next traineeship's title" once everything's been flattened to plain text, since both are free-form
// prose sitting right next to each other. Matching against this known list removes that ambiguity.
const EU_ORGS = [
  'Court of Justice', 'Clean Aviation Joint Undertaking', 'Clean Hydrogen Joint Undertaking',
  'Circular Bio-based Europe Joint Undertaking (CBE JU)', '(KDT) Key Digital Technologies Joint Undertaking',
  '(SNS JU) Smart Networks and Services Joint Undertaking', 'Innovative Health Initiative Joint Undertaking (IHI JU)',
  "(EU-RAIL) The Europe's Rail Joint Undertaking", 'Global Health EDCTP3 Joint Undertaking', 'SESAR 3 Joint Undertaking (S3JU)',
  '(JRC) Joint Research Centre', 'Council of the European Union', '(ECA) European Court of Auditors',
  'Authority for European Political Parties and European Political Foundations', 'Anti Money Laundering Authority (AMLA)',
  '(EISMEA) European Innovation Council and SMEs Executive Agency', '(ECCC) European Cybersecurity Competence Centre',
  'European Council', 'European Parliament', 'European Ombudsman', 'European Data Protection Supervisor',
  'European Committee of the Regions', 'European Investment Fund (EIF)', '(EESC) European Economic and Social Committee',
  '(ECB) European Central Bank', '(EEAS) European External Action Service', 'European Commission',
  '(EIB) European Investment Bank', '(EACEA) European Education and Culture Executive Agency',
  '(REA) European Research Executive Agency', '(CINEA) European Climate, Infrastructure and Environment Executive Agency',
  '(HaDEA) European Health and Digital Executive Agency', '(FRONTEX) European Border and Coast Guard Agency',
  '(Eurojust) European Union Agency for Criminal Justice Cooperation',
  '(eu-LISA) European Union Agency for the Operational Management of Large-Scale IT Systems in the Area of Freedom, Security and Justice',
  '(CEPOL) European Union Agency for Law Enforcement Training', '(EUSPA) European Union Agency for the Space Programme',
  '(ENISA) European Union Agency for Cybersecurity', 'European Union Agency for Asylum (EUAA)',
  'Agency for Support for BEREC (BEREC Office)', '(ERA) European Union Agency for Railways',
  '(Europol) European Union Agency for Law Enforcement Cooperation', '(EuroHPC) European High Performance Computing Joint Undertaking',
  '(ERCEA) European Research Council Executive Agency', '(ELA) European Labour Authority',
  '(EIGE) European Institute for Gender Equality', '(EDA) European Defence Agency', '(EUDA) European Union Drugs Agency',
  'EPSO - European Personnel Selection Office', '(EMA) European Medicines Agency',
  '(EU ISS) European Union Institute for Security Studies', '(SRB) Single Resolution Board',
  '(EFSA) European Food Safety Authority', '(EBA) European Banking Authority', '(EEA) European Environment Agency',
  '(EMSA) European Maritime Safety Agency', '(EASA) European Union Aviation Safety Agency',
  '(CPVO) Community Plant Variety Office', '(ECDC) European Centre for Disease Prevention and Control',
  '(ESMA) European Securities and Markets Authority', '(EIOPA) European Insurance and Occupational Pensions Authority',
  '(EU-OSHA) European Agency for Safety and Health at Work', '(SatCen) European Union Satellite Centre',
  '(FRA) European Union Agency for Fundamental Rights',
  '(FCH JU) New Energy World Joint Undertaking, Fuel Cells and Hydrogen for Sustainability',
  '(F4E) European Joint Undertaking for ITER and the Development of Fusion Energy',
  '(EUROFOUND) European Foundation for the Improvement of Living and Working Conditions',
  '(EUIPO) European Union Intellectual Property Office', '(ETF) European Training Foundation',
  "(EPPO) European Public Prosecutor's Office", '(EIT) European Institute of Innovation and Technology',
  '(EFCA) European Fisheries Control Agency', '(ECHA) European Chemicals Agency',
  '(CEDEFOP) European Centre for the Development of Vocational Training',
  '(CDT) Translation Centre for the Bodies of the European Union', '(ACER) Agency for the Cooperation of Energy Regulators'
];
const EU_ORG_PATTERN = EU_ORGS
  .slice()
  .sort((a, b) => b.length - a.length) // longest first so alternation prefers full names over substrings
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const CATEGORIES = {
  eu: 'EU Institutions',
  tech: 'Tech',
  finance: 'Finance & Consulting',
  ngo: 'NGOs & Research',
  platform: 'Platforms & Directories'
};

const CURATED = [
  // --- EU Institutions ---
  { id: 'blue-book', title: 'EU Blue Book Traineeship', org: 'European Commission', category: 'eu',
    location: 'Brussels, Belgium', note: 'Around €1,538/month · ~1,000 places/round · deadlines 31 Jan & 31 Aug',
    url: 'https://commission.europa.eu/about/organisation/departments-and-executive-agencies/traineeships_en',
    countries: ['Belgium'], season: ['spring', 'other'], paid: true },
  { id: 'schuman', title: 'Schuman Traineeship', org: 'European Parliament', category: 'eu',
    location: 'Brussels, Belgium / Luxembourg', note: 'Around €1,667/month · ~500 places/round · deadlines mid-May & mid-Oct',
    url: 'https://schuman-application.europarl.europa.eu',
    countries: ['Belgium', 'Luxembourg'], season: ['spring', 'other'], paid: true },
  { id: 'cjeu', title: 'CJEU Traineeship (stage)', org: 'Court of Justice of the EU', category: 'eu',
    location: 'Luxembourg', note: 'Around €2,400/month, one of the highest-paid EU traineeships',
    url: 'https://curia.europa.eu/jcms/jcms/Jo2_7008/en/',
    countries: ['Luxembourg'], season: ['other'], paid: true },
  { id: 'ecb', title: 'Graduate & Trainee Programmes', org: 'European Central Bank', category: 'eu',
    location: 'Frankfurt, Germany', note: 'Paid traineeships across ECB departments, rolling intake',
    url: 'https://www.ecb.europa.eu/careers/what-we-offer/graduates-trainees/html/index.en.html',
    countries: ['Germany'], season: ['other'], paid: true },
  { id: 'eeas', title: 'Traineeships', org: 'European External Action Service', category: 'eu',
    location: 'Brussels, Belgium / EU Delegations worldwide', note: 'Paid & unpaid tracks, twice a year',
    url: 'https://www.eeas.europa.eu/eeas/traineeships_en',
    countries: ['Multiple countries'], season: ['other'], paid: 'mixed' },
  { id: 'eucareers-all', title: 'All EU institutions, agencies & bodies', org: 'EU Careers (EPSO)', category: 'eu',
    location: 'Across the EU', note: 'Central directory covering 50+ EU agencies and bodies at once',
    url: 'https://eu-careers.europa.eu/en/job-opportunities/traineeships',
    countries: ['Multiple countries'], season: ['other'], paid: 'mixed' },
  { id: 'eib', title: 'Traineeships at the EIB', org: 'European Investment Bank', category: 'eu',
    location: 'Luxembourg', note: 'Around €1,500/month · two intakes a year, Mar-Apr & Sep-Oct',
    url: 'https://www.eib.org/en/about/careers/categories/traineeships/index',
    countries: ['Luxembourg'], season: ['spring', 'other'], paid: true },
  { id: 'frontex', title: 'Blue Book Traineeship', org: 'Frontex', category: 'eu',
    location: 'Warsaw, Poland', note: 'Paid 5-month traineeship, ~€1,476/month · up to 60 places/year',
    url: 'https://www.frontex.europa.eu/careers/traineeships/',
    countries: ['Poland'], season: ['other'], paid: true },

  // --- Tech ---
  { id: 'google', title: 'Software Engineering & STEP Internships', org: 'Google', category: 'tech',
    location: 'London, Zurich, Munich, Dublin & more', note: 'Summer internships across EMEA offices',
    url: 'https://careers.google.com/students/',
    countries: ['Multiple countries'], season: ['summer'], paid: true },
  { id: 'microsoft', title: 'Explore & Software Engineering Internships', org: 'Microsoft', category: 'tech',
    location: 'Dublin, Munich, London & more', note: 'Undergrad (Explore) and standard SWE tracks',
    url: 'https://careers.microsoft.com/students/us/en/usuniversityhub',
    countries: ['Multiple countries'], season: ['summer'], paid: true },
  { id: 'sap', title: 'iXp Internship Programme', org: 'SAP', category: 'tech',
    location: 'Walldorf, Germany & offices EU-wide', note: 'Rolling intake, most SAP offices across Europe',
    url: 'https://jobs.sap.com/content/Students-and-Graduates/',
    countries: ['Multiple countries'], season: ['other'], paid: true },
  { id: 'spotify', title: 'Summer Internship', org: 'Spotify', category: 'tech',
    location: 'Stockholm, Sweden', note: 'Engineering, design & data roles, applications open ~Nov-Jan',
    url: 'https://www.lifeatspotify.com/students',
    countries: ['Sweden'], season: ['summer'], paid: true },
  { id: 'asml', title: 'Internship Programme', org: 'ASML', category: 'tech',
    location: 'Veldhoven, Netherlands', note: 'Deep-tech / semiconductor internships, rolling intake',
    url: 'https://www.asml.com/en/careers/students',
    countries: ['Netherlands'], season: ['other'], paid: true },
  { id: 'amazon', title: 'Student Internship Programme', org: 'Amazon', category: 'tech',
    location: 'London, Munich, Paris, Madrid & more', note: "Tech, ops & business tracks, open to Bachelor's/Master's/PhD students",
    url: 'https://amazon.jobs/content/en/career-programs/university-ops/eu-students-internship',
    countries: ['Multiple countries'], season: ['summer'], paid: true },
  { id: 'meta', title: 'Software & Production Engineering Internship', org: 'Meta', category: 'tech',
    location: 'London, Dublin', note: '12-24 week internships, multiple start dates a year',
    url: 'https://www.metacareers.com/students-and-grads/',
    countries: ['United Kingdom', 'Ireland'], season: ['summer'], paid: true },
  { id: 'booking', title: 'Compass Internship Programme', org: 'Booking.com', category: 'tech',
    location: 'Amsterdam, Netherlands', note: '9-week or 5-6 month tracks for students at Dutch universities',
    url: 'https://careers.booking.com/early-careers/',
    countries: ['Netherlands'], season: ['other'], paid: true },
  { id: 'siemens', title: 'Consulting Internship (Siemens Advanta)', org: 'Siemens', category: 'tech',
    location: 'Munich, Germany & offices EU-wide', note: '10+ week placements in digital transformation consulting, rolling intake',
    url: 'https://www.siemens-advanta.com/careers/consulting/internship',
    countries: ['Multiple countries'], season: ['other'], paid: true },

  // --- Finance & Consulting ---
  { id: 'gs', title: 'Summer Analyst Programme', org: 'Goldman Sachs', category: 'finance',
    location: 'London, Frankfurt, Warsaw & more', note: 'Applications typically open ~Aug-Sep the year before',
    url: 'https://www.goldmansachs.com/careers/students',
    countries: ['Multiple countries'], season: ['summer'], paid: true },
  { id: 'mckinsey', title: 'Summer Business Analyst', org: 'McKinsey & Company', category: 'finance',
    location: 'Offices across Europe', note: 'Rolling by office, strategy/consulting track',
    url: 'https://www.mckinsey.com/careers/students',
    countries: ['Multiple countries'], season: ['summer'], paid: true },
  { id: 'big4', title: 'Summer & Placement Internships', org: 'Deloitte / EY / PwC / KPMG', category: 'finance',
    location: 'Offices across Europe', note: 'Each Big Four firm runs its own European scheme — check each site',
    url: 'https://www.pwc.com/gx/en/careers/students.html',
    countries: ['Multiple countries'], season: ['summer'], paid: true },
  { id: 'unilever', title: 'Future Leaders Internship', org: 'Unilever', category: 'finance',
    location: 'London, Rotterdam & more', note: 'Marketing, finance & supply chain tracks',
    url: 'https://www.unilever.com/careers/graduates-and-internships/',
    countries: ['Multiple countries'], season: ['summer'], paid: true },
  { id: 'jpmorgan', title: 'Summer Analyst & Software Engineer Programmes', org: 'J.P. Morgan', category: 'finance',
    location: 'London & EMEA offices', note: '10-12 week internships across markets, tech & banking',
    url: 'https://www.jpmorganchase.com/careers/explore-opportunities/students-and-graduates',
    countries: ['Multiple countries'], season: ['summer'], paid: true },
  { id: 'bcg', title: 'Summer Internship', org: 'Boston Consulting Group', category: 'finance',
    location: 'Offices across Europe', note: '10-12 week case-team placements, highly competitive',
    url: 'https://careers.bcg.com/global/en/students',
    countries: ['Multiple countries'], season: ['summer'], paid: true },

  // --- NGOs & Research ---
  { id: 'cern', title: 'Summer Student & Technical Student Programmes', org: 'CERN', category: 'ngo',
    location: 'Geneva, Switzerland (border FR/CH)', note: 'Physics, engineering & computing, deadlines ~Jan',
    url: 'https://careers.cern/students',
    countries: ['Switzerland'], season: ['summer'], paid: true },
  { id: 'undp', title: 'Internship Programme', org: 'UNDP', category: 'ngo',
    location: 'Various EU country offices', note: 'Development & policy work, rolling by office · paid monthly stipend',
    url: 'https://www.undp.org/jobs/browse?query=intern',
    countries: ['Multiple countries'], season: ['other'], paid: true },
  { id: 'unicef', title: 'Internship Programme', org: 'UNICEF', category: 'ngo',
    location: 'Geneva & Brussels', note: 'Child rights & humanitarian work, rolling intake · paid monthly stipend',
    url: 'https://www.unicef.org/careers/internships',
    countries: ['Switzerland', 'Belgium'], season: ['other'], paid: true },
  { id: 'oecd', title: 'Internship Programme', org: 'OECD', category: 'ngo',
    location: 'Paris, France', note: 'Economics & policy research, rolling intake · ~€1,000/month stipend',
    url: 'https://www.oecd.org/careers/internship-programme/',
    countries: ['France'], season: ['other'], paid: true },
  { id: 'esa', title: 'ESA Graduate Trainee Programme', org: 'European Space Agency', category: 'ngo',
    location: 'Netherlands & ESA sites across Europe', note: '~100 places/year, one-year programme, around €2,800/month',
    url: 'https://www.esa.int/About_Us/Careers_at_ESA/Graduates_ESA_Graduate_Trainees',
    countries: ['Multiple countries'], season: ['other'], paid: true },
  { id: 'who', title: 'Internship Programme', org: 'World Health Organization', category: 'ngo',
    location: 'Geneva, Switzerland', note: '6-24 week placements, paid living allowance',
    url: 'https://www.who.int/careers/internship-programme',
    countries: ['Switzerland'], season: ['other'], paid: true },
  { id: 'icrc', title: 'Traineeship Programme', org: 'International Committee of the Red Cross', category: 'ngo',
    location: 'Geneva, Switzerland', note: 'Paid traineeships across humanitarian & legal divisions, ~80 places/year',
    url: 'https://careers.icrc.org/go/Graduates-and-Students/3808201/',
    countries: ['Switzerland'], season: ['other'], paid: true },

  // --- Platforms & Directories (link out — not individual listings) ---
  { id: 'jobteaser', title: 'JobTeaser', org: 'Platform', category: 'platform',
    location: 'Pan-European', note: 'Official career platform for 800+ European universities',
    url: 'https://www.jobteaser.com',
    countries: ['Multiple countries'], season: ['other'], paid: 'mixed' },
  { id: 'goabroad', title: 'GoAbroad', org: 'Platform', category: 'platform',
    location: 'Global, strong EU coverage', note: '17,500+ internship & study-abroad programmes',
    url: 'https://www.goabroad.com/intern-abroad',
    countries: ['Multiple countries'], season: ['other'], paid: 'mixed' },
  { id: 'erasmusintern', title: 'ErasmusIntern', org: 'Erasmus Student Network', category: 'platform',
    location: 'Pan-European', note: 'Traineeship portal for Erasmus+ placements',
    url: 'https://erasmusintern.org',
    countries: ['Multiple countries'], season: ['other'], paid: 'mixed' },
  { id: 'iaeste', title: 'IAESTE', org: 'Platform', category: 'platform',
    location: '80+ countries', note: 'Paid STEM placements, strong Europe network',
    url: 'https://iaeste.org',
    countries: ['Multiple countries'], season: ['summer'], paid: true },
  { id: 'aiesec', title: 'AIESEC', org: 'Platform', category: 'platform',
    location: '100+ countries', note: 'Internships & volunteer exchanges, leadership focus',
    url: 'https://aiesec.org',
    countries: ['Multiple countries'], season: ['other'], paid: 'mixed' },
  { id: 'piktalent', title: 'Piktalent', org: 'Platform', category: 'platform',
    location: 'Pan-European', note: 'Erasmus+ and international mobility placements',
    url: 'https://piktalent.com',
    countries: ['Multiple countries'], season: ['other'], paid: 'mixed' },
  { id: 'milkround', title: 'Milkround — Europe', org: 'Platform', category: 'platform',
    location: 'UK-based, Europe-wide listings', note: 'Thousands of graduate internship listings',
    url: 'https://www.milkround.com/jobs/internship/in-europe',
    countries: ['Multiple countries'], season: ['other'], paid: 'mixed' },
  { id: 'prosple', title: 'Prosple', org: 'Platform', category: 'platform',
    location: 'UK & Europe', note: 'Graduate job & internship search by employer',
    url: 'https://uk.prosple.com',
    countries: ['Multiple countries'], season: ['other'], paid: 'mixed' },
  { id: 'eures', title: 'EURES', org: 'Platform', category: 'platform',
    location: 'Across the EU/EFTA', note: 'Official EU job & traineeship mobility portal',
    url: 'https://eures.europa.eu',
    countries: ['Multiple countries'], season: ['other'], paid: 'mixed' }
];

// Clean European country names used to normalise free-text locations coming from the live
// EU Careers scrape below. Longest-first so "Czech Republic" isn't shadowed by a shorter partial.
const EUROPEAN_COUNTRIES = [
  'Czech Republic', 'United Kingdom', 'Liechtenstein', 'Switzerland', 'Netherlands', 'Luxembourg',
  'Portugal', 'Slovakia', 'Slovenia', 'Bulgaria', 'Croatia', 'Denmark', 'Estonia', 'Finland', 'Germany',
  'Hungary', 'Iceland', 'Ireland', 'Latvia', 'Lithuania', 'Romania', 'Belgium', 'Cyprus', 'France',
  'Greece', 'Poland', 'Sweden', 'Norway', 'Austria', 'Italy', 'Malta', 'Spain', 'Czechia'
];

function normalizeCountries(locStr) {
  if (!locStr) return ['Multiple countries'];
  const found = EUROPEAN_COUNTRIES.filter((c) => locStr.includes(c));
  return found.length ? found : ['Multiple countries'];
}

// EU institution traineeship rounds are almost always twice a year. Deadlines in the back half of
// the year (Oct-Jan) precede a round that starts roughly Feb-Apr — tag that 'spring'. Deadlines
// Apr-Aug precede an autumn/winter start — bucketed as 'other' alongside rolling-intake postings.
function inferSeasonFromDeadline(deadlineStr) {
  if (!deadlineStr) return ['other'];
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const lower = deadlineStr.toLowerCase();
  let month = null;
  for (let i = 0; i < monthNames.length; i++) {
    if (lower.includes(monthNames[i])) { month = i + 1; break; }
  }
  if (month === null) {
    const m = deadlineStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-]\d{2,4}/);
    if (m) month = parseInt(m[2], 10);
  }
  if (month && [10, 11, 12, 1].includes(month)) return ['spring'];
  return ['other'];
}

// --- Live source: EU Careers "Highlights" (see header comment) ---
let liveCache = { items: [], fetchedAt: 0 };
const LIVE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// html-to-text renders EU Careers' headings in ALL CAPS. Convert shouty titles to a
// readable case; leave anything that isn't fully uppercase (unlikely here) untouched.
function toTitleCase(str) {
  if (!str) return str;
  if (str !== str.toUpperCase()) return str;
  return str.toLowerCase().replace(/(^|[\s\-(/])([a-z])/g, (m0, sep, ch) => sep + ch.toUpperCase());
}

async function fetchEuCareersHighlights() {
  const now = Date.now();
  if (liveCache.items.length && now - liveCache.fetchedAt < LIVE_TTL_MS) {
    return liveCache.items;
  }
  try {
    const res = await fetch('https://eu-careers.europa.eu/en/job-opportunities/traineeships', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InternRunBot/1.0)' }
    });
    if (!res.ok) throw new Error('EU Careers fetch failed: ' + res.status);
    const html = await res.text();
    const text = convert(html, { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }] });
    // Collapse all whitespace (including newlines) to single spaces so this doesn't depend on
    // whether html-to-text puts Deadline/Location/Institution on one line or several — we only
    // rely on the literal field-label keywords as boundaries, not on line breaks or spacing.
    const flat = text.replace(/\s+/g, ' ').trim();

    const items = [];
    const blockRe = new RegExp('Deadline:\\s*(.+?)\\s*Location\\(s\\):\\s*(.+?)\\s*Institution\\/EU body:\\s*(' + EU_ORG_PATTERN + ')', 'gi');
    let m;
    let lastEnd = 0;
    while ((m = blockRe.exec(flat)) && items.length < 8) {
      const [, deadline, location, org] = m;
      // Title is whatever text sits between the end of the previous match and the start of this
      // "Deadline:" — bounding org against the known institution list (above) means that text is
      // unambiguous, unlike a plain lazy-match which bleeds into the next entry's title.
      const rawZone = flat.slice(lastEnd, m.index).trim();
      // The zone before the first match can include page intro copy and a "Highlights" section
      // heading (e.g. "...agencies below ---- HIGHLIGHTS EIGE ..."). Cut everything up to and
      // including the LAST "Highlights" occurrence anywhere in the zone, not just a leading one.
      const hiIdx = rawZone.toLowerCase().lastIndexOf('highlights');
      const cutZone = hiIdx >= 0 ? rawZone.slice(hiIdx + 'highlights'.length).trim() : rawZone;
      const titleZone = cutZone.replace(/^-+\s*/, '');
      const title = toTitleCase(titleZone.split(' ').slice(-12).join(' ').trim());
      lastEnd = blockRe.lastIndex;
      if (!title || title.length < 4) continue;
      items.push({
        id: 'eucareers-' + items.length,
        title,
        org: org.trim(),
        category: 'eu',
        location: location.trim(),
        note: 'Deadline: ' + deadline.trim(),
        url: 'https://eu-careers.europa.eu/en/job-opportunities/traineeships',
        tag: 'live',
        countries: normalizeCountries(location.trim()),
        season: inferSeasonFromDeadline(deadline.trim()),
        paid: 'mixed'
      });
    }
    if (items.length) {
      liveCache = { items, fetchedAt: now };
    }
    return liveCache.items;
  } catch (e) {
    // Never let a live-source hiccup break the whole listings response — just fall back to
    // whatever curated data we have and, if we have a stale live cache, keep serving that.
    return liveCache.items;
  }
}

// --- Live source: SimplifyJobs Summer2027-Internships feed ---
// Public, no-auth JSON feed maintained by SimplifyJobs (raw.githubusercontent.com — GitHub serves
// this to anyone, no ToS or robots.txt issue), updated continuously as postings open and close.
// This is what makes "new internships appear, filled ones disappear" work with no extra plumbing:
// every listing carries an explicit `active` flag, so a fresh fetch each cache cycle naturally
// drops anything that's closed — no snapshot/database needed for removal. "New" is derived the
// same stateless way, from `date_posted`: no persistent storage required, so no GitHub token or
// cron job is needed to make the "New" badge work.
const SIMPLIFY_FEED_URL = 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json';
const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // posted within the last 7 days = "New" badge

let simplifyCache = { items: [], fetchedAt: 0 };

function mapSimplifyCategory(cat) {
  return /quant|finance/i.test(cat || '') ? 'finance' : 'tech';
}

function seasonsFromTerms(terms) {
  if (!Array.isArray(terms) || !terms.length) return ['other'];
  const seasons = new Set();
  terms.forEach((t) => {
    const lower = (t || '').toLowerCase();
    if (lower.includes('summer')) seasons.add('summer');
    else if (lower.includes('spring')) seasons.add('spring');
    else seasons.add('other');
  });
  return Array.from(seasons);
}

// SimplifyJobs locations are an array of free-text strings, and real postings write them far more
// often as "London, UK" or just "Dublin" than "London, United Kingdom" — EUROPEAN_COUNTRIES alone
// (which only matches full country names) misses both. These two lookups cover the gap: common
// abbreviations/nations-within-the-UK, and the European hub cities that show up unqualified.
const COUNTRY_ALIASES = {
  'UK': 'United Kingdom', 'U.K.': 'United Kingdom', 'England': 'United Kingdom',
  'Scotland': 'United Kingdom', 'Wales': 'United Kingdom', 'Northern Ireland': 'United Kingdom'
};
const EU_HUB_CITIES = {
  London: 'United Kingdom', Manchester: 'United Kingdom', Edinburgh: 'United Kingdom', Bristol: 'United Kingdom',
  Cambridge: 'United Kingdom', Oxford: 'United Kingdom', Belfast: 'United Kingdom', Glasgow: 'United Kingdom',
  Dublin: 'Ireland', Cork: 'Ireland',
  Berlin: 'Germany', Munich: 'Germany', Frankfurt: 'Germany', Hamburg: 'Germany', Stuttgart: 'Germany', Walldorf: 'Germany',
  Paris: 'France', Lyon: 'France',
  Amsterdam: 'Netherlands', Rotterdam: 'Netherlands', Eindhoven: 'Netherlands', Veldhoven: 'Netherlands',
  Zurich: 'Switzerland', Geneva: 'Switzerland', Basel: 'Switzerland', Zug: 'Switzerland',
  Madrid: 'Spain', Barcelona: 'Spain', Milan: 'Italy', Rome: 'Italy',
  Stockholm: 'Sweden', Copenhagen: 'Denmark', Oslo: 'Norway', Helsinki: 'Finland',
  Vienna: 'Austria', Brussels: 'Belgium',
  Lisbon: 'Portugal', Athens: 'Greece', Budapest: 'Hungary', Warsaw: 'Poland', Krakow: 'Poland',
  Prague: 'Czech Republic', Bucharest: 'Romania', Sofia: 'Bulgaria'
};

// Returns the matched European country for one location string, or null if it isn't one.
function matchEuropeanCountry(locStr) {
  if (!locStr) return null;
  const direct = EUROPEAN_COUNTRIES.find((c) => locStr.includes(c));
  if (direct) return direct;
  for (const alias of Object.keys(COUNTRY_ALIASES)) {
    if (new RegExp('\\b' + alias.replace(/\./g, '\\.') + '\\b').test(locStr)) return COUNTRY_ALIASES[alias];
  }
  for (const city of Object.keys(EU_HUB_CITIES)) {
    if (locStr.includes(city)) return EU_HUB_CITIES[city];
  }
  return null;
}

// A role only counts as "remote and open to Europe" if it's unrestricted ("Remote") or explicitly
// says Europe — "Remote in USA" / "Remote in Canada" is remote work restricted to that country's
// hires and isn't actually open to someone based in Europe, so it's excluded on purpose.
function isOpenRemote(locStr) {
  const l = (locStr || '').toLowerCase().trim();
  if (!l.includes('remote')) return false;
  if (l === 'remote') return true;
  return l.includes('europe') || l.includes('emea') || l.includes('worldwide') || l.includes('anywhere');
}

function isEuropeOrRemoteLocation(locations) {
  if (!Array.isArray(locations) || !locations.length) return false;
  return locations.some((loc) => matchEuropeanCountry(loc) || isOpenRemote(loc));
}

function countriesFromSimplifyLocations(locations) {
  const found = new Set();
  let hasOpenRemote = false;
  (locations || []).forEach((loc) => {
    const c = matchEuropeanCountry(loc);
    if (c) found.add(c);
    else if (isOpenRemote(loc)) hasOpenRemote = true;
  });
  if (found.size) return Array.from(found);
  if (hasOpenRemote) return ['Remote'];
  return ['Multiple countries'];
}

async function fetchSimplifyJobsListings() {
  const now = Date.now();
  if (simplifyCache.items.length && now - simplifyCache.fetchedAt < LIVE_TTL_MS) {
    return simplifyCache.items;
  }
  try {
    const res = await fetch(SIMPLIFY_FEED_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InternRunBot/1.0)' }
    });
    if (!res.ok) throw new Error('SimplifyJobs fetch failed: ' + res.status);
    const raw = await res.json();
    const items = raw
      .filter((r) => r && r.active && r.is_visible !== false && isEuropeOrRemoteLocation(r.locations))
      .map((r) => {
        const postedMs = (r.date_posted || 0) * 1000;
        return {
          id: 'simplify-' + r.id,
          title: r.title,
          org: r.company_name,
          category: mapSimplifyCategory(r.category),
          location: (r.locations || []).join(' · ') || 'Remote',
          countries: countriesFromSimplifyLocations(r.locations || []),
          season: seasonsFromTerms(r.terms),
          paid: true,
          note: r.sponsorship && !/^other$/i.test(r.sponsorship) ? 'Visa sponsorship: ' + r.sponsorship : undefined,
          url: r.url,
          tag: 'live',
          isNew: postedMs > 0 && (now - postedMs) < NEW_WINDOW_MS
        };
      });
    // A hiccup here shouldn't wipe out a previously-good cache; only replace on a successful parse.
    simplifyCache = { items, fetchedAt: now };
    return items;
  } catch (e) {
    return simplifyCache.items;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const [euLive, simplifyLive] = await Promise.all([
    fetchEuCareersHighlights(),
    fetchSimplifyJobsListings()
  ]);
  const curated = CURATED.map((c) => ({ ...c, tag: 'curated' }));

  res.status(200).json({
    categories: CATEGORIES,
    items: [...euLive, ...simplifyLive, ...curated],
    checkedAt: new Date().toISOString()
  });
};
