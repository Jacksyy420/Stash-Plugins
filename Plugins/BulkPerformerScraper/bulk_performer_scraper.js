(function () {
  "use strict";

  const PLUGIN_ID = "bulk_performer_scraper";
  const ROUTE = "/plugin/bulk-performer-scraper";
  const TASK_RUN = "Bulk scrape performers";
  const TASK_APPLY = "Apply bulk scrape results";
  const TASK_RESTORE = "Restore last bulk scrape";
  const STORE_KEY = "bulk_performer_scraper_settings";

  const FIELDS = [
    ["image", "Image"],
    ["disambiguation", "Disambiguation"],
    ["gender", "Gender"],
    ["birthdate", "Birthdate"],
    ["death_date", "Death date"],
    ["ethnicity", "Ethnicity"],
    ["country", "Country"],
    ["eye_color", "Eye color"],
    ["hair_color", "Hair color"],
    ["height", "Height"],
    ["weight", "Weight"],
    ["measurements", "Measurements"],
    ["fake_tits", "Fake tits"],
    ["penis_length", "Penis length"],
    ["circumcised", "Circumcised"],
    ["career_length", "Career length"],
    ["tattoos", "Tattoos"],
    ["piercings", "Piercings"],
    ["aliases", "Aliases"],
    ["urls", "URLs"],
    ["tags", "Tags"],
    ["details", "Details"],
  ];
  const FIELD_LABEL = {};
  FIELDS.forEach((f) => (FIELD_LABEL[f[0]] = f[1]));

  // Genders supported by Stash (GenderEnum) plus "Not specified"
  const GENDER_OPTIONS = [
    ["MALE", "Male"],
    ["FEMALE", "Female"],
    ["TRANSGENDER_MALE", "Transgender male"],
    ["TRANSGENDER_FEMALE", "Transgender female"],
    ["INTERSEX", "Intersex"],
    ["NON_BINARY", "Non-binary"],
    ["NONE", "Not specified"],
  ];

  // ======================================================================
  // GraphQL
  // ======================================================================

  const PERFORMER_FIELDS =
    "id name disambiguation gender birthdate death_date ethnicity country eye_color hair_color " +
    "height_cm weight measurements fake_tits penis_length circumcised career_length tattoos piercings " +
    "alias_list urls details image_path scene_count image_count tags { id name }";
  const SCRAPED_FIELDS =
    "stored_id name disambiguation gender url urls birthdate death_date ethnicity country eye_color " +
    "hair_color height weight measurements fake_tits penis_length circumcised career_length tattoos " +
    "piercings aliases tags { stored_id name } images details";

  const Q_SCRAPERS = "query { listScrapers(types: [PERFORMER]) { id performer { urls supported_scrapes } } }";
  const Q_FIND =
    "query($f: FindFilterType, $pf: PerformerFilterType, $ids: [Int!]) { findPerformers(filter: $f, performer_filter: $pf, performer_ids: $ids) { count performers { " +
    PERFORMER_FIELDS +
    " } } }";
  const Q_SCRAPE =
    "query($source: ScraperSourceInput!, $input: ScrapeSinglePerformerInput!) { scrapeSinglePerformer(source: $source, input: $input) { " +
    SCRAPED_FIELDS +
    " } }";
  const Q_SCRAPE_URL = "query($url: String!) { scrapePerformerURL(url: $url) { " + SCRAPED_FIELDS + " } }";
  const Q_FIND_TAG =
    "query($n: String!) { findTags(tag_filter: {name: {value: $n, modifier: EQUALS}}) { tags { id name } } }";

  function stashBase() {
    return (window.STASH_BASE_URL || "/").replace(/\/?$/, "/");
  }
  function profileUrl(id) {
    return stashBase() + "performers/" + id;
  }

  async function gql(query, variables) {
    const res = await window.fetch(stashBase() + "graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
    return json.data;
  }

  async function startTask(taskName, args, description) {
    await gql(
      "mutation($pid: ID!, $name: String, $desc: String, $args: Map) { runPluginTask(plugin_id: $pid, task_name: $name, description: $desc, args_map: $args) }",
      { pid: PLUGIN_ID, name: taskName, desc: description, args }
    );
  }

  // ======================================================================
  // Engine: Review (scrape + matching, writes nothing)
  // ======================================================================

  const UPDATE_KEY = { height: "height_cm", aliases: "alias_list", tags: "tag_ids" };
  const GENDERS = {
    male: "MALE",
    female: "FEMALE",
    "transgender male": "TRANSGENDER_MALE",
    "trans male": "TRANSGENDER_MALE",
    "transgender female": "TRANSGENDER_FEMALE",
    "trans female": "TRANSGENDER_FEMALE",
    intersex: "INTERSEX",
    "non binary": "NON_BINARY",
    "non-binary": "NON_BINARY",
    nonbinary: "NON_BINARY",
  };
  const DATE_RE = /^\d{4}(-\d{2}){0,2}$/;
  const PAREN_RE = /\s*[(\[]([^)\]]*)[)\]]\s*$/;
  const TOKEN_RE = /[a-z0-9äöüß]{2,}/g;
  const RESCUE_MARGIN = 0.15;
  const RESCUE_MIN_DISAMBIG = 0.6;
  const TIE_EPS = 0.02;
  const MAX_CANDIDATES = 6;
  // Higher value = more important; "Descending" therefore lists Changes first and Skipped last
  const STATUS_ORDER = { changes: 5, unsure: 4, error: 3, no_data: 2, no_result: 1, skipped: 0 };

  // Similarity like Python difflib.SequenceMatcher.ratio()
  function longestMatch(a, alo, ahi, b, blo, bhi) {
    let bi = alo,
      bj = blo,
      bk = 0;
    let prev = new Array(bhi - blo + 1).fill(0);
    for (let i = alo; i < ahi; i++) {
      const cur = new Array(bhi - blo + 1).fill(0);
      for (let j = blo; j < bhi; j++) {
        if (a[i] === b[j]) {
          const k = prev[j - blo] + 1;
          cur[j - blo + 1] = k;
          if (k > bk) {
            bk = k;
            bi = i - k + 1;
            bj = j - k + 1;
          }
        }
      }
      prev = cur;
    }
    return [bi, bj, bk];
  }
  function matchCount(a, alo, ahi, b, blo, bhi) {
    if (alo >= ahi || blo >= bhi) return 0;
    const m = longestMatch(a, alo, ahi, b, blo, bhi);
    if (!m[2]) return 0;
    return m[2] + matchCount(a, alo, m[0], b, blo, m[1]) + matchCount(a, m[0] + m[2], ahi, b, m[1] + m[2], bhi);
  }
  function sim(x, y) {
    const a = String(x).toLowerCase(),
      b = String(y).toLowerCase();
    if (!a.length && !b.length) return 1;
    return (2 * matchCount(a, 0, a.length, b, 0, b.length)) / (a.length + b.length);
  }

  function parseHeight(v) {
    if (v == null || v === "") return null;
    const s = String(v).toLowerCase();
    let m = s.match(/^\s*(\d+)\s*(?:'|ft|feet)\s*(\d+)?/);
    if (m) return Math.round(parseInt(m[1], 10) * 30.48 + parseInt(m[2] || "0", 10) * 2.54);
    m = s.match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  }
  function parseWeight(v) {
    if (v == null || v === "") return null;
    const s = String(v).toLowerCase();
    const m = s.match(/\d+/);
    if (!m) return null;
    const n = parseInt(m[0], 10);
    return s.includes("lb") ? Math.round(n * 0.4536) : n;
  }
  function parseLength(v) {
    if (v == null || v === "") return null;
    const s = String(v).toLowerCase().replace(",", ".");
    const m = s.match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    let n = parseFloat(m[0]);
    if (s.includes("in") || s.includes('"')) n *= 2.54;
    return n > 0 ? Math.round(n * 10) / 10 : null;
  }
  function toGender(v) {
    return v ? GENDERS[String(v).trim().toLowerCase().replace(/_/g, " ")] || null : null;
  }
  function toCircumcised(v) {
    if (!v) return null;
    const s = String(v).trim().toLowerCase().replace(/_/g, " ");
    if (["uncut", "uncircumcised", "not circumcised", "intact"].includes(s)) return "UNCUT";
    if (["cut", "circumcised"].includes(s)) return "CUT";
    return null;
  }

  function convertSimple(field, sc) {
    switch (field) {
      case "image": {
        const imgs = sc.images || [];
        return imgs.length ? imgs[0] : null;
      }
      case "height":
        return parseHeight(sc.height);
      case "weight":
        return parseWeight(sc.weight);
      case "penis_length":
        return parseLength(sc.penis_length);
      case "circumcised":
        return toCircumcised(sc.circumcised);
      case "gender":
        return toGender(sc.gender);
      case "birthdate":
      case "death_date": {
        const v = String(sc[field] || "").trim();
        return DATE_RE.test(v) ? v : null;
      }
      case "aliases": {
        const a = String(sc.aliases || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        return a.length ? a : null;
      }
      case "urls": {
        const urls = (sc.urls || []).slice();
        if (sc.url && !urls.includes(sc.url)) urls.push(sc.url);
        return urls.length ? urls : null;
      }
      default: {
        let v = sc[field];
        if (typeof v === "string") v = v.trim();
        return v || null;
      }
    }
  }

  async function resolveTags(sc, ctx) {
    const existing = [],
      newNames = [];
    for (const t of sc.tags || []) {
      if (t.stored_id) {
        existing.push({ id: String(t.stored_id), name: t.name });
        continue;
      }
      const name = (t.name || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!ctx.tagCache.has(key)) {
        const found = (await gql(Q_FIND_TAG, { n: name })).findTags.tags;
        ctx.tagCache.set(key, found.length ? { id: String(found[0].id), name: found[0].name } : null);
      }
      const hit = ctx.tagCache.get(key);
      if (hit) existing.push(hit);
      else if (!newNames.includes(name)) newNames.push(name);
    }
    return existing.length || newNames.length ? { existing, newNames } : null;
  }

  function currentValue(field, perf) {
    switch (field) {
      case "image":
        return null;
      case "tags":
        return (perf.tags || []).map((t) => String(t.id));
      case "height":
        return perf.height_cm;
      case "aliases":
        return perf.alias_list || [];
      case "urls":
        return perf.urls || [];
      default:
        return perf[field];
    }
  }
  function isEmpty(field, perf) {
    if (field === "image") return (perf.image_path || "default=true").includes("default=true");
    const v = currentValue(field, perf);
    return v == null || v === "" || v === 0 || (Array.isArray(v) && v.length === 0);
  }

  function nameScore(perf, cand, useDisambig) {
    if (!cand.name) return 1;
    const own = [perf.name].concat(perf.alias_list || []);
    if (useDisambig && perf.disambiguation) own.push(perf.name + " (" + perf.disambiguation + ")");
    const theirs = [cand.name];
    const stripped = cand.name.replace(PAREN_RE, "").trim();
    if (stripped && stripped !== cand.name) theirs.push(stripped);
    let best = 0;
    own.forEach((a) => theirs.forEach((b) => (best = Math.max(best, sim(a, b)))));
    return best;
  }
  function disambigScore(perf, cand) {
    const d = String(perf.disambiguation || "").trim().toLowerCase();
    if (!d) return null;
    const cd = String(cand.disambiguation || "").trim().toLowerCase();
    const m = (cand.name || "").match(PAREN_RE);
    const parts = [cd, m ? m[1] : "", cand.birthdate, cand.country, cand.ethnicity, cand.hair_color, cand.eye_color];
    const profile = parts.filter(Boolean).map(String).join(" ").toLowerCase();
    if (!profile.trim()) return null;
    const tokens = d.match(TOKEN_RE) || [];
    const hit = tokens.length ? tokens.filter((t) => profile.includes(t)).length / tokens.length : 0;
    return Math.max(hit, cd ? sim(d, cd) : 0);
  }

  // Countries: Stash usually stores the name ("United States"), scrapers often return ISO codes ("US").
  const COUNTRY_GROUPS = [
    ["united states", "us", "usa", "united states of america", "america"],
    ["united kingdom", "uk", "gb", "great britain", "england", "scotland", "wales", "northern ireland"],
    ["germany", "de", "deutschland"], ["france", "fr"], ["spain", "es", "españa"], ["italy", "it", "italia"],
    ["netherlands", "nl", "holland"], ["belgium", "be"], ["switzerland", "ch"], ["austria", "at"],
    ["sweden", "se"], ["norway", "no"], ["denmark", "dk"], ["finland", "fi"], ["poland", "pl"],
    ["czech republic", "cz", "czechia"], ["slovakia", "sk"], ["hungary", "hu"], ["romania", "ro"],
    ["bulgaria", "bg"], ["russia", "ru", "russian federation"], ["ukraine", "ua"], ["brazil", "br", "brasil"],
    ["argentina", "ar"], ["mexico", "mx"], ["colombia", "co"], ["canada", "ca"], ["australia", "au"],
    ["new zealand", "nz"], ["japan", "jp"], ["south korea", "kr", "korea", "republic of korea"],
    ["china", "cn"], ["thailand", "th"], ["philippines", "ph"], ["india", "in"], ["south africa", "za"],
    ["ireland", "ie"], ["portugal", "pt"], ["greece", "gr"], ["turkey", "tr", "türkiye", "turkiye"],
    ["israel", "il"], ["venezuela", "ve"], ["chile", "cl"], ["peru", "pe"], ["cuba", "cu"], ["croatia", "hr"],
    ["serbia", "rs"], ["lithuania", "lt"], ["latvia", "lv"], ["estonia", "ee"], ["slovenia", "si"],
    ["dominican republic", "do"], ["puerto rico", "pr"],
  ];
  const COUNTRY_CANON = {};
  COUNTRY_GROUPS.forEach((g) => g.forEach((n) => (COUNTRY_CANON[n] = g[0])));
  function canonCountry(v) {
    const t = String(v || "").trim().toLowerCase().replace(/^the\s+/, "").replace(/\./g, "");
    return COUNTRY_CANON[t] || t;
  }
  function countryScore(a, b) {
    const x = canonCountry(a),
      y = canonCountry(b);
    if (!x || !y) return null;
    return x === y ? 1 : 0;
  }

  // Date comparison up to the shared precision (YYYY, YYYY-MM, YYYY-MM-DD)
  function dateParts(v) {
    const m = String(v || "").trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
    return m ? [m[1], m[2], m[3]].filter(Boolean) : null;
  }
  function dateScore(a, b) {
    const x = dateParts(a),
      y = dateParts(b);
    if (!x || !y) return null;
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return 0;
    return n === 3 ? 1 : n === 2 ? 0.9 : 0.7;
  }

  // How well do the performer's birthdate, disambiguation and country match the result?
  // Only the values stored for the performer in Stash count, regardless of which fields are scraped.
  // null = nothing comparable. Weights: birthdate 3, disambiguation 2, country 1.
  function identityScore(perf, cand) {
    const parts = [
      [dateScore(perf.birthdate, cand.birthdate), 3],
      [disambigScore(perf, cand), 2],
      [countryScore(perf.country, cand.country), 1],
    ].filter((p) => p[0] != null);
    if (!parts.length) return null;
    // Country alone is a weak signal: it can tell same-named results apart,
    // but is not enough to "rescue" a name (value stays below RESCUE_MIN_DISAMBIG).
    if (parts.length === 1 && parts[0][1] === 1) return parts[0][0] * 0.5;
    const weight = parts.reduce((a, p) => a + p[1], 0);
    return parts.reduce((a, p) => a + p[0] * p[1], 0) / weight;
  }

  // A result may only be rescued despite too low name similarity if birthdate or
  // disambiguation are comparable. Country alone is too unspecific for that.
  function hasStrongIdentity(perf, cand) {
    return dateScore(perf.birthdate, cand.birthdate) != null || disambigScore(perf, cand) != null;
  }

  // Picks the best result. -> { cand, unsure, best: {name, score}, reason, scored: [{r, ns, ds}] }
  function pick(results, perf, threshold, useDisambig) {
    const scored = [];
    (results || []).forEach((r) => {
      if (r) scored.push({ r, ns: nameScore(perf, r, useDisambig), ds: useDisambig ? identityScore(perf, r) : null });
    });
    if (!scored.length) return { cand: null, unsure: false, best: null, reason: null, scored };
    scored.sort((p, q) => q.ns + 0.25 * (q.ds || 0) - (p.ns + 0.25 * (p.ds || 0)));
    const info = (x) => ({ name: x.r.name || "", score: x.ns });

    let ok = scored.filter((x) => x.ns >= threshold);
    if (!ok.length && useDisambig) {
      ok = scored.filter((x) => x.ns >= threshold - RESCUE_MARGIN && x.ds != null && x.ds >= RESCUE_MIN_DISAMBIG && hasStrongIdentity(perf, x.r));
    }
    if (!ok.length) return { cand: null, unsure: true, best: info(scored[0]), reason: "Name does not match", scored };
    if (useDisambig && ok.length > 1 && Math.abs(ok[0].ns - ok[1].ns) < TIE_EPS) {
      const d0 = ok[0].ds,
        d1 = ok[1].ds;
      if (d0 == null || d1 == null || Math.abs(d0 - d1) < 0.2) {
        return { cand: null, unsure: true, best: info(ok[0]), reason: "multiple equally good results", scored };
      }
    }
    return { cand: ok[0].r, unsure: false, best: info(ok[0]), reason: null, scored };
  }

  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  function summarizeCandidate(x, sourceId) {
    const c = x.r;
    return {
      source: sourceId,
      name: c.name || "",
      disambiguation: c.disambiguation || "",
      birthdate: c.birthdate || "",
      country: c.country || "",
      url: c.url || (c.urls && c.urls[0]) || "",
      image: (c.images && c.images[0]) || "",
      score: x.ns,
      raw: c, // full scraper result so it can be applied manually later
    };
  }

  // Scraper specs (incl. supported scrape types and URL patterns), loaded once per review
  let specsCache = null;
  async function getSpecs(refresh) {
    if (!specsCache || refresh) {
      const specs = {};
      (await gql(Q_SCRAPERS)).listScrapers.forEach((s) => (specs[s.id] = s.performer || {}));
      specsCache = specs;
    }
    return specsCache;
  }

  const isEmptyValue = (v) => v == null || v === "" || (Array.isArray(v) && !v.length);

  // With many scrapers, search results contain only a few details (often just name and URL). As in the
  // Stash UI, the selected result is therefore passed to the scraper again, which then returns the
  // full data. Stash-Box results are already complete.
  async function enrichRaw(sourceId, spec, raw) {
    if (sourceId.startsWith("stashbox:")) return { raw, note: "Stash-Box results already contain all data." };
    const url = raw.url || (raw.urls && raw.urls[0]) || "";
    const base = { name: raw.name };
    if (raw.disambiguation) base.disambiguation = raw.disambiguation;
    // Depending on the Stash version the field is called "urls" or (deprecated) "url": try several variants
    const inputs = url ? [Object.assign({}, base, { urls: [url] }), Object.assign({}, base, { url })] : [];
    inputs.push(base);
    let details = null,
      lastError = null;
    for (const input of inputs) {
      let answered = false;
      try {
        const res = (await gql(Q_SCRAPE, { source: { scraper_id: sourceId }, input: { performer_input: input } })).scrapeSinglePerformer;
        answered = true;
        if (res && res[0]) details = res[0];
      } catch (e) {
        lastError = e.message || String(e);
      }
      if (details || answered) break;
    }
    if (!details && url && (spec.urls || []).some((p) => url.includes(p))) {
      try {
        details = (await gql(Q_SCRAPE_URL, { url })).scrapePerformerURL;
      } catch (e) {
        lastError = e.message || String(e);
      }
    }
    if (!details) return { raw, note: "Could not load details" + (lastError ? " (" + lastError + ")" : "") + "." };
    const merged = Object.assign({}, raw);
    Object.keys(details).forEach((k) => {
      if (!isEmptyValue(details[k])) merged[k] = details[k];
    });
    return { raw: merged, note: "Details were loaded from the scraper." };
  }

  async function scrapeOne(sourceId, spec, perf, cfg) {
    let source, supported;
    if (sourceId.startsWith("stashbox:")) {
      source = { stash_box_endpoint: sourceId.slice("stashbox:".length) };
      supported = ["FRAGMENT", "NAME"];
    } else {
      source = { scraper_id: sourceId };
      supported = spec.supported_scrapes || [];
    }
    const lists = [];
    if (supported.includes("FRAGMENT")) {
      lists.push({ kind: "FRAGMENT", res: (await gql(Q_SCRAPE, { source, input: { performer_id: perf.id } })).scrapeSinglePerformer });
    }
    if (supported.includes("NAME")) {
      lists.push({ kind: "NAME", res: (await gql(Q_SCRAPE, { source, input: { query: perf.name } })).scrapeSinglePerformer });
    }
    if (supported.includes("URL")) {
      const patterns = spec.urls || [];
      for (const u of perf.urls || []) {
        if (patterns.some((p) => u.includes(p))) {
          const res = (await gql(Q_SCRAPE_URL, { url: u })).scrapePerformerURL;
          lists.push({ kind: "URL", res: res ? [res] : [] });
        }
      }
    }
    let unsure = false,
      best = null,
      reason = null;
    const candidates = [];
    for (const { kind, res } of lists) {
      const r = pick(res, perf, cfg.threshold, cfg.useDisambig);
      if (r.cand) {
        let cand = r.cand;
        if (kind === "NAME" && !sourceId.startsWith("stashbox:")) {
          // Name search usually returns only brief data: load the full data of the result
          await sleep(cfg.delay * 1000);
          cand = (await enrichRaw(sourceId, spec, cand)).raw;
        }
        return { cand, unsure: false, best: r.best, reason: null, candidates: [] };
      }
      if (r.unsure && !unsure) reason = r.reason;
      unsure = unsure || r.unsure;
      best = best || r.best;
      r.scored.forEach((x) => candidates.push(summarizeCandidate(x, sourceId)));
    }
    return { cand: null, unsure, best, reason, candidates };
  }

  function fmt(v) {
    if (v == null || v === "") return "—";
    if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
    return String(v);
  }

  function emptyResult(perf) {
    return {
      perf,
      id: perf.id,
      name: perf.name,
      disambiguation: perf.disambiguation || "",
      aliases: perf.alias_list || [],
      status: "no_result",
      sceneCount: perf.scene_count || 0,
      imageCount: perf.image_count || 0,
      image: perf.image_path || null,
      changes: [],
      update: {},
      old: {},
      newTags: [],
      scrapers: [],
      matches: [],
      best: null,
      candidates: [],
      message: null,
    };
  }

  // Builds the changes (update, old, changes) for a result from the found values.
  function buildChanges(res, perf, cfg, found, used) {
    FIELDS.forEach(([f, label]) => {
      if (!(f in found)) return;
      const v = found[f];
      const cur = currentValue(f, perf);
      const key = UPDATE_KEY[f] || f;
      let row = null;

      if (f === "tags") {
        const add = v.existing.filter((t) => !cur.includes(t.id));
        const addNew = cfg.createTags ? v.newNames : [];
        if (!add.length && !addNew.length) return;
        res.update[key] = cur.concat(add.map((t) => t.id));
        res.old[key] = cur;
        res.newTags = addNew;
        row = { old: (perf.tags || []).map((t) => t.name), new: add.map((t) => t.name).concat(addNew.map((n) => n + " (new)")) };
      } else if (f === "aliases" || f === "urls") {
        const add = v.filter((x) => !cur.includes(x));
        if (!add.length) return;
        res.update[key] = cur.concat(add);
        res.old[key] = cur;
        row = { old: cur, new: add };
      } else {
        if (v === cur) return;
        res.update[key] = v;
        if (f !== "image") res.old[key] = cur == null ? null : cur;
        row =
          f === "image"
            ? { old: isEmpty("image", perf) ? "no image" : "existing image", new: v }
            : { old: cur, new: v };
      }
      res.changes.push({ field: f, label, old: row.old, new: row.new, scraper: used[f] });
    });

    res.scrapers = Array.from(new Set(Object.values(used)));
  }

  // Checks one performer.
  async function checkPerformer(perf, cfg, specs, ctx) {
    const wanted = cfg.fields.filter((f) => cfg.overwrite || isEmpty(f, perf));
    const res = emptyResult(perf);

    // All selected fields are already filled: no scraper request and no delay.
    if (!wanted.length) {
      res.status = "skipped";
      res.message = "All selected fields are already filled; no request was sent.";
      return res;
    }

    const found = {};
    const used = {};
    const errors = [];
    const candidates = [];
    const matches = [];
    let found_any = false;
    let unsure = false,
      best = null,
      reason = null;

    for (const sid of cfg.scrapers) {
      const remaining = wanted.filter((f) => !(f in found));
      if (!remaining.length) break;
      try {
        const r = await scrapeOne(sid, specs[sid] || {}, perf, cfg);
        if (r.unsure && !unsure) reason = r.reason;
        unsure = unsure || r.unsure;
        best = best || r.best;
        r.candidates.forEach((c) => candidates.push(c));
        if (r.cand) {
          found_any = true;
          matches.push({ source: sid, name: r.cand.name || "", url: r.cand.url || (r.cand.urls && r.cand.urls[0]) || "" });
          for (const f of remaining) {
            const v = f === "tags" ? await resolveTags(r.cand, ctx) : convertSimple(f, r.cand);
            if (v != null) {
              found[f] = v;
              used[f] = sid;
            }
          }
        }
      } catch (e) {
        errors.push(e.message || String(e));
      }
      await sleep(cfg.delay * 1000);
    }

    buildChanges(res, perf, cfg, found, used);
    if (res.changes.length) {
      res.status = "changes";
      // only show matches that actually provided values
      res.matches = matches.filter((m) => res.scrapers.includes(m.source));
    } else if (unsure) {
      res.status = "unsure";
      res.best = best;
      const seen = new Set();
      res.candidates = candidates
        .sort((a, b) => b.score - a.score)
        .filter((c) => {
          const k = [c.source, c.name, c.birthdate, c.url].join("|");
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, MAX_CANDIDATES);
      res.message =
        "No result confident enough" +
        (reason ? " (" + reason + ")" : "") +
        (best ? ". Best result: " + (best.name || "unnamed") + " (" + Math.round(best.score * 100) + " %)" : "");
    } else if (found_any && !Object.keys(found).length) {
      res.status = "no_data";
      res.matches = matches;
      res.message =
        "Performer found, but the scraper returns none of the requested values (" +
        wanted.map((f) => (FIELDS.find((x) => x[0] === f) || [f, f])[1]).join(", ") + ")." +
        (errors.length ? " Other errors: " + errors.join("; ") : "");
    } else if (errors.length) {
      res.status = "error";
      res.message = errors.join("; ");
    } else {
      res.message = found_any ? "The returned values already match the existing ones." : "The selected scrapers found no matching performer.";
    }
    return res;
  }

  // Applies one of the listed results of an unsure performer. Returns a new result.
  async function chooseCandidate(res, index, cfg) {
    let cand = res.candidates[index];
    let candidates = res.candidates;
    const perf = res.perf;

    // Search results are often incomplete: load the result's details from the scraper (once per result)
    if (!cand.detailed) {
      const specs = await getSpecs();
      const e = await enrichRaw(cand.source, specs[cand.source] || {}, cand.raw);
      cand = Object.assign({}, cand, {
        raw: e.raw,
        detailed: true,
        detailNote: e.note,
        disambiguation: e.raw.disambiguation || cand.disambiguation,
        birthdate: e.raw.birthdate || cand.birthdate,
        country: e.raw.country || cand.country,
        image: (e.raw.images && e.raw.images[0]) || cand.image,
        url: cand.url || e.raw.url || "",
      });
      candidates = candidates.map((c, i) => (i === index ? cand : c));
    }

    const wanted = cfg.fields.filter((f) => cfg.overwrite || isEmpty(f, perf));
    const ctx = { tagCache: new Map() };
    const found = {},
      used = {};
    for (const f of wanted) {
      const v = f === "tags" ? await resolveTags(cand.raw, ctx) : convertSimple(f, cand.raw);
      if (v != null) {
        found[f] = v;
        used[f] = cand.source;
      }
    }
    const next = Object.assign({}, res, { candidates, update: {}, old: {}, changes: [], newTags: [], scrapers: [], matches: [], choiceNote: null });
    buildChanges(next, perf, cfg, found, used);
    if (!next.changes.length) {
      // Result provides nothing new: leave the result unchanged, but explain what was requested and what was available
      const have = FIELDS.filter(([f]) => (f === "tags" ? (cand.raw.tags || []).length > 0 : convertSimple(f, cand.raw) != null)).map((x) => x[1]);
      return Object.assign({}, res, {
        candidates,
        choiceNote:
          "The result \"" + (cand.name || "unnamed") + "\" provides no changes for the selected fields. Requested: " +
          (wanted.map((f) => FIELD_LABEL[f]).join(", ") || "–") + ". Available in result: " + (have.join(", ") || "nothing") + ". " + (cand.detailNote || ""),
      });
    }
    next.origStatus = res.origStatus || res.status;
    next.origMessage = res.origMessage || res.message;
    next.status = "changes";
    next.matches = [{ source: cand.source, name: cand.name || "", url: cand.url || "" }];
    next.chosen = index;
    next.message = "Manually selected result: " + (cand.name || "unnamed");
    return next;
  }

  // Undoes a manual selection (the performer is "unsure" again afterwards).
  function clearChoice(res) {
    return Object.assign({}, res, {
      status: res.origStatus || "unsure",
      message: res.origMessage || res.message,
      update: {},
      old: {},
      matches: [],
      changes: [],
      newTags: [],
      scrapers: [],
      chosen: null,
      choiceNote: null,
    });
  }

  async function loadPerformers(cfg) {
    const pf = {};
    let ids = null;
    const scope = cfg.scope || { type: "all" };
    if (scope.type === "tag") pf.tags = { value: [scope.tag_id], modifier: "INCLUDES" };
    else if (scope.type === "ids") ids = scope.ids.map((i) => parseInt(i, 10));
    const data = await gql(Q_FIND, {
      f: { per_page: -1, sort: "name" },
      pf: Object.keys(pf).length ? pf : null,
      ids,
    });
    let list = data.findPerformers.performers;
    // Gender filter on the client side (independent of the Stash version); null = all
    if (cfg.genders && cfg.genders.length) list = list.filter((p) => cfg.genders.includes(p.gender || "NONE"));
    return list;
  }

  // hooks: onStart(total), shouldStop(), onProgress(done, result)
  async function runCheck(cfg, hooks) {
    const specs = await getSpecs(true);
    const performers = await loadPerformers(cfg);
    hooks.onStart(performers.length);
    const ctx = { tagCache: new Map() };
    for (let i = 0; i < performers.length; i++) {
      if (hooks.shouldStop()) return "stopped";
      // Skipped performers need no network request; yield to the event loop now and then
      // so the window does not freeze on long runs.
      if (i % 100 === 99) await new Promise((r) => setTimeout(r, 0));
      let res;
      try {
        res = await checkPerformer(performers[i], cfg, specs, ctx);
      } catch (e) {
        res = emptyResult(performers[i]);
        res.status = "error";
        res.message = e.message || String(e);
      }
      hooks.onProgress(i + 1, res);
    }
    return "done";
  }

  const SORT_OPTIONS = [
    ["activity", "Scenes + Images"],
    ["scenes", "Scenes"],
    ["images", "Images"],
    ["name", "Name"],
    ["changes", "Number of changes"],
    ["status", "Status"],
  ];
  function sortResults(list, key, dir) {
    const mul = dir === "asc" ? 1 : -1;
    const val = {
      activity: (r) => r.sceneCount + r.imageCount,
      scenes: (r) => r.sceneCount,
      images: (r) => r.imageCount,
      changes: (r) => r.changes.length,
      status: (r) => STATUS_ORDER[r.status],
    }[key];
    return list.slice().sort((a, b) => {
      const d = key === "name" || !val ? a.name.localeCompare(b.name) : val(a) - val(b);
      return d !== 0 ? mul * d : a.name.localeCompare(b.name);
    });
  }

  // ======================================================================
  // Session: the running review lives outside the components and
  // therefore keeps running when the window is closed or the page is changed.
  // ======================================================================

  const session = { state: null, listeners: [], stop: false };

  function emitSession() {
    session.listeners.slice().forEach((fn) => fn(session.state));
  }
  function patchSession(patch) {
    session.state = Object.assign({}, session.state, patch);
    emitSession();
  }
  function patchSessionUi(patch) {
    if (session.state) patchSession({ ui: Object.assign({}, session.state.ui, patch) });
  }
  function resetSession() {
    if (session.state && session.state.running) return;
    session.state = null;
    emitSession();
  }
  function stopSession() {
    session.stop = true;
  }
  function startSession(cfg) {
    if (session.state && session.state.running) return;
    session.stop = false;
    session.state = {
      cfg,
      results: [],
      total: 0,
      done: 0,
      running: true,
      outcome: null,
      error: null,
      applied: false,
      ui: { sortKey: "status", sortDir: "desc", filter: "all", excluded: {} },
    };
    emitSession();

    const buffer = [];
    const counters = { done: 0, total: 0 };
    const flush = () => {
      const add = buffer.splice(0);
      const st = session.state;
      if (!add.length && counters.done === st.done && counters.total === st.total) return;
      session.state = Object.assign({}, st, {
        results: add.length ? st.results.concat(add) : st.results,
        done: counters.done,
        total: counters.total,
      });
      emitSession();
    };
    const timer = setInterval(flush, 250);
    runCheck(cfg, {
      onStart: (n) => (counters.total = n),
      shouldStop: () => session.stop,
      onProgress: (done, res) => {
        counters.done = done;
        if (res) buffer.push(res);
      },
    })
      .then((outcome) => {
        clearInterval(timer);
        flush();
        patchSession({ running: false, outcome });
      })
      .catch((e) => {
        clearInterval(timer);
        flush();
        patchSession({ running: false, error: e.message || String(e) });
      });
  }

  window.BulkPerformerScraper = {
    engine: { sim, pick, parseHeight, parseWeight, parseLength, toCircumcised, toGender, checkPerformer, chooseCandidate, clearChoice, runCheck, sortResults, dateScore, countryScore, identityScore },
    session: { get: () => session.state, start: startSession, stop: stopSession, reset: resetSession },
  };

  // ======================================================================
  // UI
  // ======================================================================

  const PluginApi = window.PluginApi;
  if (!PluginApi) return;

  const React = PluginApi.React;
  const h = React.createElement;
  const { useState, useEffect, useMemo } = React;
  const { Button, Modal } = PluginApi.libraries.Bootstrap;
  const { Link } = PluginApi.libraries.ReactRouterDOM;

  window.addEventListener("beforeunload", function (e) {
    if (session.state && session.state.running) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  function useSession() {
    const [st, setSt] = useState(session.state);
    useEffect(() => {
      const fn = (s) => setSt(s);
      session.listeners.push(fn);
      setSt(session.state);
      return () => {
        session.listeners = session.listeners.filter((x) => x !== fn);
      };
    }, []);
    return st;
  }

  const DEFAULTS = {
    selected: [],
    fields: FIELDS.map((f) => f[0]),
    overwrite: false,
    delay: 1,
    threshold: 0.85,
    createTags: false,
    scopeType: "all",
    tagId: "",
    genders: GENDER_OPTIONS.map((g) => g[0]),
    useDisambig: true,
  };

  function loadSettings() {
    try {
      const saved = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORE_KEY) || "{}"));
      saved.selected = (saved.selected || []).slice(0, 1); // only one scraper at a time
      return saved;
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function Check(props) {
    return h(
      "label",
      { className: "bs-check" },
      h("input", { type: "checkbox", checked: props.checked, onChange: (e) => props.onChange(e.target.checked) }),
      h("span", null, props.label)
    );
  }

  function Section(props) {
    return h("section", { className: "bs-section" }, h("h5", null, props.title), props.children);
  }

  // Shows progress while a review is running in the background (navigation, Performers button)
  function ProgressLabel(props) {
    const st = useSession();
    return props.label + (st && st.running ? " (" + st.done + "/" + st.total + ")" : "");
  }

  // ---------------------------------------------------------------- Settings

  function SetupView(props) {
    const { s, set, sources, tags } = props;
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);

    const nameOf = (id) => (sources.find((x) => x.id === id) || { name: id }).name;
    const toggle = (key, id, on) => set({ [key]: on ? s[key].concat(id) : s[key].filter((x) => x !== id) });

    function validate() {
      if (!s.selected.length) return "Select a scraper.";
      if (!s.fields.length) return "Select at least one field.";
      if (!s.genders.length) return "Select at least one gender.";
      if (s.scopeType === "tag" && !s.tagId) return "Select a tag.";
      return null;
    }
    const scope = () => (s.scopeType === "tag" ? { type: "tag", tag_id: s.tagId } : { type: "all" });
    const genders = () => (s.genders.length === GENDER_OPTIONS.length ? null : s.genders);

    function start() {
      const err = validate();
      if (err) return setMessage({ error: true, text: err });
      const sourceNames = {};
      s.selected.forEach((id) => (sourceNames[id] = nameOf(id)));
      startSession({
        scrapers: s.selected,
        sourceNames,
        fields: s.fields,
        overwrite: s.overwrite,
        delay: Number(s.delay),
        threshold: Number(s.threshold),
        createTags: s.createTags,
        useDisambig: s.useDisambig,
        genders: genders(),
        scope: scope(),
      });
    }

    async function runDirect() {
      const err = validate();
      if (err) return setMessage({ error: true, text: err });
      if (!window.confirm("Without review: changes are written directly (with backup). Continue?")) return;
      const config = {
        scrapers: s.selected,
        fields: s.fields,
        overwrite: s.overwrite,
        dry_run: false,
        delay: Number(s.delay),
        threshold: Number(s.threshold),
        create_tags: s.createTags,
        genders: genders(),
        use_disambiguation: s.useDisambig,
        scope: scope(),
      };
      setBusy(true);
      try {
        await startTask(TASK_RUN, { mode: "run", config: JSON.stringify(config) }, "Bulk scrape (direct)");
        setMessage({ text: "Task started. See progress and result under Settings → Tasks." });
      } catch (e) {
        setMessage({ error: true, text: e.message });
      }
      setBusy(false);
    }

    return h(
      React.Fragment,
      null,
      h(
        Modal.Body,
        { className: "bs-modal-body" },

        h(
          Section,
          { title: "Scraper" },
          h(
            "select",
            {
              className: "form-control bs-select",
              value: s.selected[0] || "",
              onChange: (e) => set({ selected: e.target.value ? [e.target.value] : [] }),
            },
            h("option", { value: "" }, "Select scraper …"),
            sources.map((x) => h("option", { key: x.id, value: x.id }, x.name))
          ),
          h("p", { className: "text-muted bs-hint" }, "One scraper is used per run.")
        ),

        h(
          Section,
          { title: "Fields" },
          h(
            "div",
            { className: "bs-actions" },
            h(Button, { size: "sm", variant: "secondary", onClick: () => set({ fields: FIELDS.map((f) => f[0]) }) }, "Select all"),
            h(Button, { size: "sm", variant: "secondary", onClick: () => set({ fields: [] }) }, "Select none")
          ),
          h(
            "div",
            { className: "bs-grid" },
            FIELDS.map((f) => h(Check, { key: f[0], label: f[1], checked: s.fields.includes(f[0]), onChange: (on) => toggle("fields", f[0], on) }))
          )
        ),

        h(
          Section,
          { title: "Performers" },
          h(
            "select",
            { className: "form-control bs-select", value: s.scopeType, onChange: (e) => set({ scopeType: e.target.value }) },
            h("option", { value: "all" }, "All performers"),
            h("option", { value: "tag" }, "Only performers with tag …")
          ),
          s.scopeType === "tag" &&
            h(
              "select",
              { className: "form-control bs-select", value: s.tagId, onChange: (e) => set({ tagId: e.target.value }) },
              h("option", { value: "" }, "Select tag …"),
              tags.map((t) => h("option", { key: t.id, value: t.id }, t.name))
            ),
          h("h6", { className: "bs-subtitle" }, "Genders"),
          h(
            "div",
            { className: "bs-actions" },
            h(Button, { size: "sm", variant: "secondary", onClick: () => set({ genders: GENDER_OPTIONS.map((g) => g[0]) }) }, "Select all"),
            h(Button, { size: "sm", variant: "secondary", onClick: () => set({ genders: [] }) }, "Select none")
          ),
          h(
            "div",
            { className: "bs-grid bs-gender-grid" },
            GENDER_OPTIONS.map((g) =>
              h(Check, { key: g[0], label: g[1], checked: s.genders.includes(g[0]), onChange: (on) => toggle("genders", g[0], on) })
            )
          )
        ),

        h(
          Section,
          { title: "Options" },
          h(Check, {
            label: "Overwrite existing values (otherwise performers whose selected fields are all filled are skipped)",
            checked: s.overwrite,
            onChange: (v) => set({ overwrite: v }),
          }),
          h(Check, {
            label: "Use disambiguation, birthdate and country for matching (fewer unsure results)",
            checked: s.useDisambig,
            onChange: (v) => set({ useDisambig: v }),
          }),
          h(Check, { label: "Create missing tags", checked: s.createTags, onChange: (v) => set({ createTags: v }) }),
          h(
            "div",
            { className: "bs-inline" },
            h("label", null, "Delay between requests (seconds)"),
            h("input", { type: "number", min: 0, step: 0.5, className: "form-control", value: s.delay, onChange: (e) => set({ delay: e.target.value }) })
          ),
          h(
            "div",
            { className: "bs-inline" },
            h("label", null, "Minimum name similarity (0–1)"),
            h("input", { type: "number", min: 0, max: 1, step: 0.05, className: "form-control", value: s.threshold, onChange: (e) => set({ threshold: e.target.value }) })
          )
        ),

        message && h("div", { className: "alert " + (message.error ? "alert-danger" : "alert-success") }, message.text),
        h(
          "p",
          { className: "text-muted bs-hint" },
          "\"Start review\" collects the results without writing anything. The review keeps running if you close the window, as long as this browser tab stays open."
        )
      ),
      h(
        Modal.Footer,
        { className: "bs-modal-footer" },
        h(Button, { variant: "primary", disabled: busy, onClick: start }, "Start review"),
        h(Button, { variant: "secondary", disabled: busy, onClick: runDirect, title: "Runs as a background task, without review" }, "Run directly"),
        h(Button, { variant: "secondary", onClick: props.onClose }, "Close")
      )
    );
  }

  // ---------------------------------------------------------------- Results

  const STATUS_INFO = {
    changes: ["Changes", "success"],
    unsure: ["Unsure", "warning"],
    no_data: ["No values", "bs-nodata"],
    no_result: ["No result", "secondary"],
    error: ["Error", "danger"],
    skipped: ["Skipped", "info"],
  };

  function CandidateTable(props) {
    return h(
      "div",
      { className: "bs-table-wrap" },
      h("h6", { className: "bs-subtitle" }, "Possible matches"),
      h(
        "table",
        { className: "table table-sm bs-table bs-candidates" },
        h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "Name"), h("th", null, "Details"), h("th", null, "Similarity"), h("th", null, "Source"), h("th", null, ""))),
        h(
          "tbody",
          null,
          props.candidates.map((c, i) =>
            h(
              "tr",
              { key: i, className: props.chosen === i ? "bs-cand-chosen" : null },
              h(
                "td",
                null,
                c.image
                  ? h("img", { className: "bs-cand-img", src: c.image, referrerPolicy: "no-referrer", loading: "lazy", alt: "", onError: (e) => (e.target.style.display = "none") })
                  : null
              ),
              h(
                "td",
                null,
                c.url ? h("a", { href: c.url, target: "_blank", rel: "noopener noreferrer" }, c.name || "(unnamed)") : c.name || "(unnamed)"
              ),
              h("td", null, [c.disambiguation, c.birthdate, c.country].filter(Boolean).join(" · ") || "—"),
              h("td", null, Math.round(c.score * 100) + " %"),
              h("td", null, props.sourceNames[c.source] || c.source),
              h(
                "td",
                { className: "bs-cand-action" },
                props.chosen === i
                  ? h(Button, { size: "sm", variant: "secondary", disabled: props.busy, onClick: props.onClear }, "✓ Selected – undo")
                  : h(Button, { size: "sm", variant: "outline-primary", disabled: props.busy, onClick: () => props.onChoose(i), title: "Use this result for the performer" }, props.busyIndex === i ? "Loading details …" : "Select")
              )
            )
          )
        )
      )
    );
  }

  function ResultRow(props) {
    const r = props.r;
    const info = STATUS_INFO[r.status];
    const url = profileUrl(r.id);
    const linkProps = { href: url, target: "_blank", rel: "noopener noreferrer", title: "Open profile in new tab" };
    const meta =
      r.sceneCount + " Scenes · " + r.imageCount + " Images · Σ " + (r.sceneCount + r.imageCount) +
      (r.candidates.length ? " · " + r.candidates.length + " possible matches" : "");
    return h(
      "div",
      { className: "bs-result" },
      h(
        "div",
        { className: "bs-result-head" },
        r.status === "changes"
          ? h("input", {
              type: "checkbox",
              className: "bs-result-check",
              checked: props.checked,
              onChange: (e) => props.onToggle(r.id, e.target.checked),
            })
          : h("span", { className: "bs-result-check" }),
        r.image ? h("a", Object.assign({ className: "bs-thumb-link" }, linkProps), h("img", { className: "bs-thumb", src: r.image, loading: "lazy", alt: "" })) : null,
        h(
          "div",
          { className: "bs-result-main" },
          h(
            "div",
            { className: "bs-result-title" },
            h("a", Object.assign({ className: "bs-result-name" }, linkProps), r.name),
            r.disambiguation ? h("span", { className: "bs-disambig" }, "(" + r.disambiguation + ")") : null
          ),
          h("div", { className: "bs-result-meta", onClick: () => props.onExpand(r.id) }, meta)
        ),
        h("span", { className: "badge badge-" + info[1] }, info[0]),
        r.chosen != null ? h("span", { className: "badge badge-light bs-manual", title: "Result selected manually" }, "manual") : null,
        h("button", { type: "button", className: "btn btn-sm btn-link", onClick: () => props.onExpand(r.id), title: "Details" }, props.expanded ? "▴" : "▾")
      ),
      props.expanded &&
        h(
          "div",
          { className: "bs-result-body" },
          h(
            "p",
            { className: "bs-aliases" },
            h("strong", null, "Aliases: "),
            r.aliases.length ? r.aliases.join(", ") : h("span", { className: "text-muted" }, "none stored")
          ),
          r.changes.length
            ? h(
                "div",
                { className: "bs-table-wrap" },
                h(
                  "table",
                  { className: "table table-sm bs-table" },
                  h("thead", null, h("tr", null, h("th", null, "Field"), h("th", null, "Before"), h("th", null, "New"))),
                  h(
                    "tbody",
                    null,
                    r.changes.map((c) =>
                      h(
                        "tr",
                        { key: c.field },
                        h("td", null, c.label),
                        h("td", null, fmt(c.old)),
                        h(
                          "td",
                          null,
                          c.field === "image"
                            ? h("img", { className: "bs-preview", src: c.new, referrerPolicy: "no-referrer", alt: "", onError: (e) => (e.target.style.display = "none") })
                            : fmt(c.new)
                        )
                      )
                    )
                  )
                )
              )
            : null,
          r.message ? h("p", { className: "text-muted bs-hint" }, r.message) : null,
          r.choiceNote ? h("p", { className: "text-warning bs-hint" }, r.choiceNote) : null,
          r.candidates.length
            ? h(CandidateTable, {
                candidates: r.candidates,
                sourceNames: props.sourceNames,
                chosen: r.chosen,
                busy: props.busy,
                busyIndex: props.busyIndex,
                onChoose: (i) => props.onChoose(r, i),
                onClear: () => props.onClear(r),
              })
            : null,
          r.matches && r.matches.length
            ? h(
                "p",
                { className: "text-muted bs-hint bs-source" },
                "Source: ",
                r.matches.map((m, i) =>
                  h(
                    React.Fragment,
                    { key: i },
                    i ? ", " : null,
                    (props.sourceNames[m.source] || m.source) + " – ",
                    m.url ? h("a", { href: m.url, target: "_blank", rel: "noopener noreferrer" }, m.name || m.url) : m.name || "unnamed"
                  )
                )
              )
            : r.scrapers.length
            ? h("p", { className: "text-muted bs-hint" }, "Source: " + r.scrapers.map((id) => props.sourceNames[id] || id).join(", "))
            : null
        )
    );
  }

  function ResultsView(props) {
    const st = props.st;
    const ui = st.ui;
    const cfg = st.cfg;
    const [expanded, setExpanded] = useState({});
    const [limit, setLimit] = useState(100);
    const [message, setMessage] = useState(null);

    const counts = useMemo(() => {
      const c = { all: st.results.length, changes: 0, unsure: 0, no_data: 0, no_result: 0, error: 0, skipped: 0 };
      st.results.forEach((r) => c[r.status]++);
      return c;
    }, [st.results]);

    const visible = useMemo(
      () => sortResults(ui.filter === "all" ? st.results : st.results.filter((r) => r.status === ui.filter), ui.sortKey, ui.sortDir),
      [st.results, ui.filter, ui.sortKey, ui.sortDir]
    );

    const selectable = st.results.filter((r) => r.status === "changes");
    const selectedItems = selectable.filter((r) => !ui.excluded[r.id]);

    async function apply() {
      if (!selectedItems.length) return;
      if (!window.confirm(selectedItems.length + " performers will be changed (with backup). Continue?")) return;
      try {
        await startTask(
          TASK_APPLY,
          {
            mode: "apply",
            payload: JSON.stringify({
              create_tags: cfg.createTags,
              items: selectedItems.map((r) => ({ id: r.id, name: r.name, update: r.update, old: r.old, new_tags: r.newTags })),
            }),
          },
          "Bulk scrape: apply results"
        );
        patchSession({ applied: true });
        setMessage({ text: "Apply started. See progress and report under Settings → Tasks." });
      } catch (e) {
        setMessage({ error: true, text: e.message });
      }
    }

    const [choosing, setChoosing] = useState(null); // { id, index } while details are being loaded
    // Replace a performer's result in the session state (always work on the latest state)
    function replaceResult(next) {
      patchSession({ results: session.state.results.map((x) => (x.id === next.id ? next : x)) });
    }
    async function chooseOne(r, index) {
      setChoosing({ id: r.id, index });
      try {
        replaceResult(await chooseCandidate(r, index, cfg));
      } catch (e) {
        setMessage({ error: true, text: "Could not apply result: " + e.message });
      }
      setChoosing(null);
    }
    function clearOne(r) {
      replaceResult(clearChoice(r));
    }

    function exportJson() {
      const data = st.results.map((r) => ({
        id: r.id,
        name: r.name,
        disambiguation: r.disambiguation,
        aliases: r.aliases,
        status: r.status,
        scenes: r.sceneCount,
        images: r.imageCount,
        changes: r.changes,
        candidates: r.candidates.map((c) => Object.assign({}, c, { raw: undefined })),
        chosen: r.chosen == null ? null : r.chosen,
        message: r.message,
      }));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "bulk_performer_scraper_review.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    const statusText = st.error
      ? "Error: " + st.error
      : st.running
      ? "Checking " + st.done + " / " + st.total + " …"
      : (st.outcome === "stopped" ? "Stopped: " : "Done: ") + st.done + " of " + st.total + " checked";

    return h(
      React.Fragment,
      null,
      h(
        Modal.Body,
        { className: "bs-modal-body" },
        h("div", { className: "bs-progress" }, h("div", { className: "bs-progress-bar", style: { width: pct + "%" } })),
        h(
          "p",
          { className: "bs-hint" },
          statusText,
          " · Nothing is written yet.",
          st.running ? " You can close the window; the review keeps running as long as this tab stays open." : ""
        ),
        h(
          "div",
          { className: "bs-toolbar" },
          h(
            "select",
            { className: "form-control", value: ui.sortKey, onChange: (e) => patchSessionUi({ sortKey: e.target.value }), title: "Sort by" },
            SORT_OPTIONS.map((o) => h("option", { key: o[0], value: o[0] }, "Sort: " + o[1]))
          ),
          h(
            Button,
            { variant: "secondary", title: "Reverse order", onClick: () => patchSessionUi({ sortDir: ui.sortDir === "desc" ? "asc" : "desc" }) },
            ui.sortDir === "desc" ? "↓ Descending" : "↑ Ascending"
          ),
          h(
            "select",
            { className: "form-control", value: ui.filter, onChange: (e) => (patchSessionUi({ filter: e.target.value }), setLimit(100)), title: "Filter" },
            h("option", { value: "all" }, "All (" + counts.all + ")"),
            h("option", { value: "changes" }, "Changes (" + counts.changes + ")"),
            h("option", { value: "unsure" }, "Unsure (" + counts.unsure + ")"),
            h("option", { value: "no_data" }, "No values (" + counts.no_data + ")"),
            h("option", { value: "no_result" }, "No result (" + counts.no_result + ")"),
            h("option", { value: "skipped" }, "Skipped (" + counts.skipped + ")"),
            h("option", { value: "error" }, "Error (" + counts.error + ")")
          )
        ),
        visible.length === 0 && h("p", { className: "text-muted" }, st.running ? "Waiting for results …" : "No entries."),
        visible.slice(0, limit).map((r) =>
          h(ResultRow, {
            key: r.id,
            r,
            sourceNames: cfg.sourceNames || {},
            checked: !ui.excluded[r.id],
            expanded: !!expanded[r.id],
            onToggle: (id, on) => patchSessionUi({ excluded: Object.assign({}, ui.excluded, { [id]: !on }) }),
            onExpand: (id) => setExpanded((prev) => Object.assign({}, prev, { [id]: !prev[id] })),
            busy: choosing != null || st.applied,
            busyIndex: choosing && choosing.id === r.id ? choosing.index : null,
            onChoose: chooseOne,
            onClear: clearOne,
          })
        ),
        visible.length > limit &&
          h(Button, { variant: "secondary", className: "bs-more", onClick: () => setLimit(limit + 100) }, "Show more (" + (visible.length - limit) + ")"),
        message && h("div", { className: "alert mt-3 " + (message.error ? "alert-danger" : "alert-success") }, message.text)
      ),
      h(
        Modal.Footer,
        { className: "bs-modal-footer" },
        st.running && h(Button, { variant: "danger", onClick: stopSession }, "Stop"),
        !st.running && h(Button, { variant: "secondary", onClick: resetSession }, "New review"),
        h(Button, { variant: "secondary", size: "sm", onClick: () => patchSessionUi({ excluded: {} }) }, "Select all"),
        h(
          Button,
          { variant: "secondary", size: "sm", onClick: () => patchSessionUi({ excluded: Object.fromEntries(selectable.map((r) => [r.id, true])) }) },
          "Select none"
        ),
        h(Button, { variant: "secondary", size: "sm", disabled: !st.results.length, onClick: exportJson }, "Export (JSON)"),
        h(
          Button,
          { variant: "primary", disabled: st.running || st.applied || !selectedItems.length, onClick: apply },
          "Apply " + selectedItems.length
        ),
        h(Button, { variant: "secondary", onClick: props.onClose }, "Close")
      )
    );
  }

  // ---------------------------------------------------------------- Modal + page

  function BulkModal(props) {
    const st = useSession();
    const [s, setS] = useState(loadSettings);
    const [sources, setSources] = useState([]);
    const [tags, setTags] = useState([]);
    const [loadError, setLoadError] = useState(null);
    const set = (patch) => setS((prev) => Object.assign({}, prev, patch));

    useEffect(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(s));
      } catch (e) {}
    }, [s]);

    useEffect(() => {
      gql(
        'query { listScrapers(types: [PERFORMER]) { id name } configuration { general { stashBoxes { endpoint name } } } findTags(filter: {per_page: -1, sort: "name"}) { tags { id name } } }'
      )
        .then((d) => {
          const boxes = d.configuration.general.stashBoxes.map((b) => ({
            id: "stashbox:" + b.endpoint,
            name: b.name + " (Stash-Box)",
          }));
          setSources(boxes.concat(d.listScrapers.map((x) => ({ id: x.id, name: x.name }))));
          setTags(d.findTags.tags);
        })
        .catch((e) => setLoadError("Loading failed: " + e.message));
    }, []);

    return h(
      Modal,
      { show: true, onHide: props.onClose, size: "xl", backdrop: "static", dialogClassName: "bs-modal-dialog" },
      h(Modal.Header, { closeButton: true }, h(Modal.Title, null, st ? "Review" : "Bulk Performer Scraper – Settings")),
      loadError && !st && h("div", { className: "alert alert-danger m-3" }, loadError),
      st ? h(ResultsView, { st, onClose: props.onClose }) : h(SetupView, { s, set, sources, tags, onClose: props.onClose })
    );
  }

  function BulkPerformerScraperPage() {
    const st = useSession();
    const [open, setOpen] = useState(true); // show the window right away when the plugin is opened
    const [message, setMessage] = useState(null);

    async function restore() {
      if (!window.confirm("Restore the last backup? (Images are not restored)")) return;
      try {
        await startTask(TASK_RESTORE, { mode: "restore" }, "Undo bulk scrape");
        setMessage({ text: "Task started. See progress and result under Settings → Tasks." });
      } catch (e) {
        setMessage({ error: true, text: e.message });
      }
    }

    return h(
      "div",
      { className: "bs-page container" },
      h("h2", null, "Bulk Performer Scraper"),
      h(
        "p",
        { className: "text-muted" },
        st
          ? st.running
            ? "A review is running: " + st.done + " / " + st.total
            : "A review is finished and can be viewed."
          : "No review active."
      ),
      message && h("div", { className: "alert " + (message.error ? "alert-danger" : "alert-success") }, message.text),
      h(
        "div",
        { className: "bs-actions" },
        h(Button, { variant: "primary", onClick: () => setOpen(true) }, st ? "Open review" : "Open settings"),
        h(Button, { variant: "secondary", onClick: restore }, "Undo last run")
      ),
      open && h(BulkModal, { onClose: () => setOpen(false) })
    );
  }

  PluginApi.register.route(ROUTE, BulkPerformerScraperPage);

  // Button above the performer list ("Performers" tab), following the Librarian pattern:
  // the list component is replaced, a toolbar is put in front and the original is rendered below it.
  function PerformersToolbar() {
    return h(
      "div",
      { className: "bs-performers-toolbar" },
      h(Button, { as: Link, to: ROUTE, variant: "secondary", title: "Open Bulk Performer Scraper" }, h(ProgressLabel, { label: "Bulk Scraper" }))
    );
  }

  try {
    PluginApi.patch.instead("FilteredPerformerList", function () {
      const args = Array.prototype.slice.call(arguments);
      const next = args[args.length - 1];
      return h(React.Fragment, null, h(PerformersToolbar), next.apply(null, args.slice(0, -1)));
    });
  } catch (e) {
    console.error("[bulk_performer_scraper] patch.instead(FilteredPerformerList) failed", e);
  }
})();
