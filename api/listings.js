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
    url: 'https://commission.europa.eu/about/organisation/departments-and-executive-agencies/traineeships_en' },
  { id: 'schuman', title: 'Schuman Traineeship', org: 'European Parliament', category: 'eu',
    location: 'Brussels, Belgium / Luxembourg', note: 'Around €1,667/month · ~500 places/round · deadlines mid-May & mid-Oct',
    url: 'https://schuman-application.europarl.europa.eu' },
  { id: 'cjeu', title: 'CJEU Traineeship (stage)', org: 'Court of Justice of the EU', category: 'eu',
    location: 'Luxembourg', note: 'Around €2,400/month, one of the highest-paid EU traineeships',
    url: 'https://curia.europa.eu/jcms/jcms/Jo2_7008/en/' },
  { id: 'ecb', title: 'Graduate & Trainee Programmes', org: 'European Central Bank', category: 'eu',
    location: 'Frankfurt, Germany', note: 'Paid traineeships across ECB departments, rolling intake',
    url: 'https://www.ecb.europa.eu/careers/what-we-offer/graduates-trainees/html/index.en.html' },
  { id: 'eeas', title: 'Traineeships', org: 'European External Action Service', category: 'eu',
    location: 'Brussels, Belgium / EU Delegations worldwide', note: 'Paid & unpaid tracks, twice a year',
    url: 'https://www.eeas.europa.eu/eeas/traineeships_en' },
  { id: 'eucareers-all', title: 'All EU institutions, agencies & bodies', org: 'EU Careers (EPSO)', category: 'eu',
    location: 'Across the EU', note: 'Central directory covering 50+ EU agencies and bodies at once',
    url: 'https://eu-careers.europa.eu/en/job-opportunities/traineeships' },

  // --- Tech ---
  { id: 'google', title: 'Software Engineering & STEP Internships', org: 'Google', category: 'tech',
    location: 'London, Zurich, Munich, Dublin & more', note: 'Summer internships across EMEA offices',
    url: 'https://careers.google.com/students/' },
  { id: 'microsoft', title: 'Explore & Software Engineering Internships', org: 'Microsoft', category: 'tech',
    location: 'Dublin, Munich, London & more', note: 'Undergrad (Explore) and standard SWE tracks',
    url: 'https://careers.microsoft.com/students/us/en/usuniversityhub' },
  { id: 'sap', title: 'iXp Internship Programme', org: 'SAP', category: 'tech',
    location: 'Walldorf, Germany & offices EU-wide', note: 'Rolling intake, most SAP offices across Europe',
    url: 'https://jobs.sap.com/content/Students-and-Graduates/' },
  { id: 'spotify', title: 'Summer Internship', org: 'Spotify', category: 'tech',
    location: 'Stockholm, Sweden', note: 'Engineering, design & data roles, applications open ~Nov-Jan',
    url: 'https://www.lifeatspotify.com/students' },
  { id: 'asml', title: 'Internship Programme', org: 'ASML', category: 'tech',
    location: 'Veldhoven, Netherlands', note: 'Deep-tech / semiconductor internships, rolling intake',
    url: 'https://www.asml.com/en/careers/students' },

  // --- Finance & Consulting ---
  { id: 'gs', title: 'Summer Analyst Programme', org: 'Goldman Sachs', category: 'finance',
    location: 'London, Frankfurt, Warsaw & more', note: 'Applications typically open ~Aug-Sep the year before',
    url: 'https://www.goldmansachs.com/careers/students' },
  { id: 'mckinsey', title: 'Summer Business Analyst', org: 'McKinsey & Company', category: 'finance',
    location: 'Offices across Europe', note: 'Rolling by office, strategy/consulting track',
    url: 'https://www.mckinsey.com/careers/students' },
  { id: 'big4', title: 'Summer & Placement Internships', org: 'Deloitte / EY / PwC / KPMG', category: 'finance',
    location: 'Offices across Europe', note: 'Each Big Four firm runs its own European scheme — check each site',
    url: 'https://www.pwc.com/gx/en/careers/students.html' },
  { id: 'unilever', title: 'Future Leaders Internship', org: 'Unilever', category: 'finance',
    location: 'London, Rotterdam & more', note: 'Marketing, finance & supply chain tracks',
    url: 'https://www.unilever.com/careers/graduates-and-internships/' },

  // --- NGOs & Research ---
  { id: 'cern', title: 'Summer Student & Technical Student Programmes', org: 'CERN', category: 'ngo',
    location: 'Geneva, Switzerland (border FR/CH)', note: 'Physics, engineering & computing, deadlines ~Jan',
    url: 'https://careers.cern/students' },
  { id: 'undp', title: 'Internship Programme', org: 'UNDP', category: 'ngo',
    location: 'Various EU country offices', note: 'Development & policy work, rolling by office',
    url: 'https://www.undp.org/jobs/browse?query=intern' },
  { id: 'unicef', title: 'Internship Programme', org: 'UNICEF', category: 'ngo',
    location: 'Geneva & Brussels', note: 'Child rights & humanitarian work, rolling intake',
    url: 'https://www.unicef.org/careers/internships' },
  { id: 'oecd', title: 'Internship Programme', org: 'OECD', category: 'ngo',
    location: 'Paris, France', note: 'Economics & policy research, rolling intake',
    url: 'https://www.oecd.org/careers/internship-programme/' },

  // --- Platforms & Directories (link out — not individual listings) ---
  { id: 'jobteaser', title: 'JobTeaser', org: 'Platform', category: 'platform',
    location: 'Pan-European', note: 'Official career platform for 800+ European universities',
    url: 'https://www.jobteaser.com' },
  { id: 'goabroad', title: 'GoAbroad', org: 'Platform', category: 'platform',
    location: 'Global, strong EU coverage', note: '17,500+ internship & study-abroad programmes',
    url: 'https://www.goabroad.com/intern-abroad' },
  { id: 'erasmusintern', title: 'ErasmusIntern', org: 'Erasmus Student Network', category: 'platform',
    location: 'Pan-European', note: 'Traineeship portal for Erasmus+ placements',
    url: 'https://erasmusintern.org' },
  { id: 'iaeste', title: 'IAESTE', org: 'Platform', category: 'platform',
    location: '80+ countries', note: 'Paid STEM placements, strong Europe network',
    url: 'https://iaeste.org' },
  { id: 'aiesec', title: 'AIESEC', org: 'Platform', category: 'platform',
    location: '100+ countries', note: 'Internships & volunteer exchanges, leadership focus',
    url: 'https://aiesec.org' },
  { id: 'piktalent', title: 'Piktalent', org: 'Platform', category: 'platform',
    location: 'Pan-European', note: 'Erasmus+ and international mobility placements',
    url: 'https://piktalent.com' },
  { id: 'milkround', title: 'Milkround — Europe', org: 'Platform', category: 'platform',
    location: 'UK-based, Europe-wide listings', note: 'Thousands of graduate internship listings',
    url: 'https://www.milkround.com/jobs/internship/in-europe' },
  { id: 'prosple', title: 'Prosple', org: 'Platform', category: 'platform',
    location: 'UK & Europe', note: 'Graduate job & internship search by employer',
    url: 'https://uk.prosple.com' }
];

// --- Live source: EU Careers "Highlights" (see header comment) ---
let liveCache = { items: [], fetchedAt: 0 };
const LIVE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
      const titleZone = flat.slice(lastEnd, m.index).trim().replace(/^Highlights\s+/i, '');
      const title = titleZone.split(' ').slice(-12).join(' ').trim();
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
        tag: 'live'
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const live = await fetchEuCareersHighlights();
  const curated = CURATED.map((c) => ({ ...c, tag: 'curated' }));

  res.status(200).json({
    categories: CATEGORIES,
    items: [...live, ...curated],
    checkedAt: new Date().toISOString()
  });
};
