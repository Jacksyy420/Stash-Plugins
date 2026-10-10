#!/usr/bin/env python3
"""Bulk Performer Scraper for Stash (raw plugin interface, standard library only).

Note: Field names in the GraphQL queries (e.g. career_length) may differ
depending on the Stash version. On a GraphQL error, adjust the constants
PERFORMER_FIELDS / SCRAPED_FIELDS below.
"""
import difflib
import glob
import json
import os
import re
import signal
import sys
import time
import urllib.request
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
BACKUP_DIR = os.path.join(BASE, "backups")
REPORT_DIR = os.path.join(BASE, "reports")

# Field ID (from the UI) -> key in PerformerUpdateInput
UPDATE_KEY = {"height": "height_cm", "aliases": "alias_list", "tags": "tag_ids"}
LIST_FIELDS = {"aliases", "urls", "tags"}
STRING_KEYS = {
    "disambiguation", "ethnicity", "country", "eye_color", "hair_color",
    "measurements", "fake_tits", "career_length", "tattoos", "piercings",
    "details", "birthdate", "death_date",
}

PERFORMER_FIELDS = (
    "id name disambiguation gender birthdate death_date ethnicity country "
    "eye_color hair_color height_cm weight measurements fake_tits penis_length "
    "circumcised career_length tattoos piercings alias_list urls details image_path tags { id name }"
)
SCRAPED_FIELDS = (
    "stored_id name disambiguation gender url urls birthdate death_date ethnicity "
    "country eye_color hair_color height weight measurements fake_tits penis_length "
    "circumcised career_length tattoos piercings aliases tags { stored_id name } images details"
)

Q_SCRAPERS = "query { listScrapers(types: [PERFORMER]) { id performer { urls supported_scrapes } } }"
Q_FIND = (
    "query($f: FindFilterType, $pf: PerformerFilterType, $ids: [Int!]) {"
    " findPerformers(filter: $f, performer_filter: $pf, performer_ids: $ids) {"
    " count performers { " + PERFORMER_FIELDS + " } } }"
)
Q_SCRAPE = (
    "query($source: ScraperSourceInput!, $input: ScrapeSinglePerformerInput!) {"
    " scrapeSinglePerformer(source: $source, input: $input) { " + SCRAPED_FIELDS + " } }"
)
Q_SCRAPE_URL = "query($url: String!) { scrapePerformerURL(url: $url) { " + SCRAPED_FIELDS + " } }"
Q_UPDATE = "mutation($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }"
Q_FIND_TAG = (
    "query($n: String!) { findTags(tag_filter: {name: {value: $n, modifier: EQUALS}}) {"
    " tags { id } } }"
)
Q_CREATE_TAG = "mutation($n: String!) { tagCreate(input: {name: $n}) { id } }"

GENDERS = {
    "male": "MALE", "female": "FEMALE",
    "transgender male": "TRANSGENDER_MALE", "trans male": "TRANSGENDER_MALE",
    "transgender female": "TRANSGENDER_FEMALE", "trans female": "TRANSGENDER_FEMALE",
    "intersex": "INTERSEX", "non binary": "NON_BINARY", "non-binary": "NON_BINARY",
    "nonbinary": "NON_BINARY",
}
DATE_RE = re.compile(r"^\d{4}(-\d{2}){0,2}$")


# ---------- Logging / Stash-API ----------

def log(level, msg):
    """Stash reads the log level from the prefix: t d i w e p (progress)."""
    print(f"\x01{level}\x02{msg}", file=sys.stderr, flush=True)


class Stash:
    def __init__(self, conn):
        host = conn.get("Host", "localhost")
        if host in ("0.0.0.0", "::"):
            host = "localhost"
        self.url = f"{conn.get('Scheme', 'http')}://{host}:{conn.get('Port', 9999)}/graphql"
        cookie = conn.get("SessionCookie") or {}
        self.headers = {"Content-Type": "application/json"}
        if cookie.get("Name"):
            self.headers["Cookie"] = f"{cookie['Name']}={cookie['Value']}"

    def call(self, query, variables=None):
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        req = urllib.request.Request(self.url, data=body, headers=self.headers)
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.load(r)
        if data.get("errors"):
            raise RuntimeError(data["errors"][0]["message"])
        return data["data"]


# ---------- Converting scraper result -> update values ----------

def parse_height(v):
    if not v:
        return None
    s = str(v).lower()
    m = re.match(r"\s*(\d+)\s*(?:'|ft|feet)\s*(\d+)?", s)
    if m:
        return round(int(m.group(1)) * 30.48 + int(m.group(2) or 0) * 2.54)
    m = re.search(r"\d+", s)
    return int(m.group()) if m else None


def parse_weight(v):
    if not v:
        return None
    s = str(v).lower()
    m = re.search(r"\d+", s)
    if not m:
        return None
    n = int(m.group())
    return round(n * 0.4536) if "lb" in s else n


def parse_length(v):
    """Length in cm as a float. Inch values (in, inch, ") are converted."""
    if not v:
        return None
    s = str(v).lower().replace(",", ".")
    m = re.search(r"\d+(?:\.\d+)?", s)
    if not m:
        return None
    n = float(m.group())
    if "in" in s or '"' in s:
        n *= 2.54
    return round(n, 1) if n > 0 else None


def to_circumcised(v):
    """Scraper text -> CircumisedEnum (CUT / UNCUT). Stash spells the enum name with this typo."""
    if not v:
        return None
    s = v.strip().lower().replace("_", " ")
    if s in ("uncut", "uncircumcised", "not circumcised", "intact"):
        return "UNCUT"
    if s in ("cut", "circumcised"):
        return "CUT"
    return None


def to_gender(v):
    return GENDERS.get(v.strip().lower().replace("_", " ")) if v else None


def find_or_create_tag(stash, name, create, cache):
    key = name.lower()
    if key not in cache:
        found = stash.call(Q_FIND_TAG, {"n": name})["findTags"]["tags"]
        if found:
            cache[key] = found[0]["id"]
        elif create:
            cache[key] = stash.call(Q_CREATE_TAG, {"n": name})["tagCreate"]["id"]
        else:
            cache[key] = None
    return cache[key]


def convert(field, sc, stash, create_tags, tag_cache):
    """Returns the value in PerformerUpdateInput format, or None."""
    if field == "image":
        imgs = sc.get("images") or []
        return imgs[0] if imgs else None
    if field == "height":
        return parse_height(sc.get("height"))
    if field == "weight":
        return parse_weight(sc.get("weight"))
    if field == "penis_length":
        return parse_length(sc.get("penis_length"))
    if field == "circumcised":
        return to_circumcised(sc.get("circumcised"))
    if field == "gender":
        return to_gender(sc.get("gender"))
    if field in ("birthdate", "death_date"):
        v = (sc.get(field) or "").strip()
        return v if DATE_RE.match(v) else None
    if field == "aliases":
        return [a.strip() for a in (sc.get("aliases") or "").split(",") if a.strip()] or None
    if field == "urls":
        urls = list(sc.get("urls") or [])
        if sc.get("url") and sc["url"] not in urls:
            urls.append(sc["url"])
        return urls or None
    if field == "tags":
        ids = []
        for t in sc.get("tags") or []:
            tid = t.get("stored_id")
            if not tid and (t.get("name") or "").strip():
                tid = find_or_create_tag(stash, t["name"].strip(), create_tags, tag_cache)
            if tid:
                ids.append(str(tid))
        return ids or None
    v = sc.get(field)
    v = v.strip() if isinstance(v, str) else v
    return v or None


def current_value(field, perf):
    if field == "image":
        return None
    if field == "tags":
        return [t["id"] for t in perf.get("tags") or []]
    if field == "height":
        return perf.get("height_cm")
    if field == "aliases":
        return perf.get("alias_list") or []
    if field == "urls":
        return perf.get("urls") or []
    return perf.get(field)


def is_empty(field, perf):
    if field == "image":
        return "default=true" in (perf.get("image_path") or "default=true")
    v = current_value(field, perf)
    return v is None or v == "" or v == [] or v == 0


# ---------- Scraping ----------

def sim(a, b):
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


PAREN_RE = re.compile(r"\s*[\(\[]([^\)\]]*)[\)\]]\s*$")
TOKEN_RE = re.compile(r"[a-z0-9äöüß]{2,}")
RESCUE_MARGIN = 0.15       # how far the name may fall below the threshold if the disambiguation clearly matches
RESCUE_MIN_DISAMBIG = 0.6  # minimum disambiguation match for this rescue
TIE_EPS = 0.02             # name scores closer than this count as equally good


def name_score(perf, cand, use_disambig):
    """Similarity between performer and match (name, aliases, name + disambiguation)."""
    if not cand.get("name"):
        return 1.0
    own = [perf["name"]] + list(perf.get("alias_list") or [])
    if use_disambig and perf.get("disambiguation"):
        own.append(f"{perf['name']} ({perf['disambiguation']})")
    # Some scrapers append the disambiguation to the name, e.g. "Anna Smith (actress)"
    theirs = {cand["name"], PAREN_RE.sub("", cand["name"]).strip()}
    return max(sim(a, b) for a in own for b in theirs if b)


def disambig_score(perf, cand):
    """0..1: How well does the performer's disambiguation match the result? None = cannot be judged."""
    d = (perf.get("disambiguation") or "").strip().lower()
    if not d:
        return None
    cd = (cand.get("disambiguation") or "").strip().lower()
    m = PAREN_RE.search(cand.get("name") or "")
    parts = [cd, m.group(1) if m else "", cand.get("birthdate"), cand.get("country"),
             cand.get("ethnicity"), cand.get("hair_color"), cand.get("eye_color")]
    profile = " ".join(str(p) for p in parts if p).lower()
    if not profile.strip():
        return None
    tokens = TOKEN_RE.findall(d)
    token_hit = sum(1 for t in tokens if t in profile) / len(tokens) if tokens else 0.0
    direct = sim(d, cd) if cd else 0.0
    return max(token_hit, direct)


# Countries: Stash usually stores the name ("United States"), scrapers often return ISO codes ("US").
COUNTRY_GROUPS = [
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
]
COUNTRY_CANON = {name: group[0] for group in COUNTRY_GROUPS for name in group}
DATE_PARTS_RE = re.compile(r"^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$")


def canon_country(v):
    t = re.sub(r"^the\s+", "", str(v or "").strip().lower()).replace(".", "")
    return COUNTRY_CANON.get(t, t)


def country_score(a, b):
    x, y = canon_country(a), canon_country(b)
    if not x or not y:
        return None
    return 1.0 if x == y else 0.0


def date_parts(v):
    m = DATE_PARTS_RE.match(str(v or "").strip())
    return [g for g in m.groups() if g] if m else None


def date_score(a, b):
    """Date comparison up to the shared precision (YYYY, YYYY-MM, YYYY-MM-DD)."""
    x, y = date_parts(a), date_parts(b)
    if not x or not y:
        return None
    n = min(len(x), len(y))
    if x[:n] != y[:n]:
        return 0.0
    return 1.0 if n == 3 else 0.9 if n == 2 else 0.7


def identity_score(perf, cand):
    """How well do the performer's birthdate, disambiguation and country match the result?

    The values stored for the performer in Stash are used, regardless of which fields
    are being scraped. None = nothing comparable. Weighting: birthdate 3, disambiguation 2, country 1.
    """
    parts = [
        (date_score(perf.get("birthdate"), cand.get("birthdate")), 3),
        (disambig_score(perf, cand), 2),
        (country_score(perf.get("country"), cand.get("country")), 1),
    ]
    parts = [(v, w) for v, w in parts if v is not None]
    if not parts:
        return None
    # Country alone is weak evidence: it can distinguish same-name results,
    # but is not enough to "rescue" a name (value stays below RESCUE_MIN_DISAMBIG).
    if len(parts) == 1 and parts[0][1] == 1:
        return parts[0][0] * 0.5
    return sum(v * w for v, w in parts) / sum(w for _, w in parts)


def has_strong_identity(perf, cand):
    """Rescue of a narrowly missed name only via birthdate or disambiguation, not via country alone."""
    return date_score(perf.get("birthdate"), cand.get("birthdate")) is not None or disambig_score(perf, cand) is not None


def pick(results, perf, threshold, use_disambig):
    """Picks the best match. Returns (candidate, unsure)."""
    scored = []
    for r in results or []:
        if not r:
            continue
        ds = identity_score(perf, r) if use_disambig else None
        scored.append((r, name_score(perf, r, use_disambig), ds))
    if not scored:
        return None, False

    ok = [x for x in scored if x[1] >= threshold]
    if not ok and use_disambig:
        # Name just missed, but the disambiguation clearly matches -> accept anyway
        ok = [x for x in scored
              if x[1] >= threshold - RESCUE_MARGIN and x[2] is not None and x[2] >= RESCUE_MIN_DISAMBIG
                    and has_strong_identity(perf, x[0])]
    if not ok:
        return None, True

    ok.sort(key=lambda x: x[1] + 0.25 * (x[2] or 0), reverse=True)
    if use_disambig and len(ok) > 1 and abs(ok[0][1] - ok[1][1]) < TIE_EPS:
        d0, d1 = ok[0][2], ok[1][2]
        if d0 is None or d1 is None or abs(d0 - d1) < 0.2:
            return None, True  # several equally good matches, disambiguation cannot decide
    return ok[0][0], False


def fetch_details(stash, source_id, spec, raw):
    """Search results often contain only name and URL. As in the Stash UI, the match is therefore
    passed to the scraper again, which then returns the full data."""
    if source_id.startswith("stashbox:"):
        return raw
    url = raw.get("url") or (raw.get("urls") or [""])[0]
    base = {"name": raw.get("name")}
    if raw.get("disambiguation"):
        base["disambiguation"] = raw["disambiguation"]
    # Depending on the Stash version the field is called "urls" or (deprecated) "url": try several variants
    inputs = [dict(base, urls=[url]), dict(base, url=url)] if url else []
    inputs.append(base)
    details = None
    for inp in inputs:
        answered = False
        try:
            res = stash.call(Q_SCRAPE, {"source": {"scraper_id": source_id}, "input": {"performer_input": inp}})["scrapeSinglePerformer"]
            answered = True
            if res:
                details = res[0]
        except Exception:
            pass
        if details or answered:
            break
    if not details and url and any(p in url for p in spec.get("urls") or []):
        try:
            details = stash.call(Q_SCRAPE_URL, {"url": url})["scrapePerformerURL"]
        except Exception:
            details = None
    if not details:
        return raw
    merged = dict(raw)
    merged.update({k: v for k, v in details.items() if v not in (None, "", [])})
    return merged


def scrape(stash, source_id, spec, perf, threshold, use_disambig):
    """Returns (result, unsure). unsure = there were matches, but the name does not fit."""
    unsure = False
    candidates = []  # list of result lists

    if source_id.startswith("stashbox:"):
        source = {"stash_box_endpoint": source_id[len("stashbox:"):]}
        supported = ["FRAGMENT", "NAME"]
    else:
        source = {"scraper_id": source_id}
        supported = spec.get("supported_scrapes") or []

    inputs = []
    if "FRAGMENT" in supported:
        inputs.append(("FRAGMENT", {"performer_id": perf["id"]}))
    if "NAME" in supported:
        inputs.append(("NAME", {"query": perf["name"]}))
    for kind, inp in inputs:
        res = stash.call(Q_SCRAPE, {"source": source, "input": inp})["scrapeSinglePerformer"]
        candidates.append((kind, res))

    if "URL" in supported:
        patterns = spec.get("urls") or []
        for u in perf.get("urls") or []:
            if any(p in u for p in patterns):
                res = stash.call(Q_SCRAPE_URL, {"url": u})["scrapePerformerURL"]
                candidates.append(("URL", [res] if res else []))

    for kind, res in candidates:
        cand, uns = pick(res, perf, threshold, use_disambig)
        if cand:
            if kind == "NAME":
                # Name search usually returns only brief data: fetch the full data of the match
                cand = fetch_details(stash, source_id, spec, cand)
            return cand, False
        unsure = unsure or uns
    return None, unsure


# ---------- Tasks ----------

class Cancelled(BaseException):
    """Raised when Stash cancels the task. BaseException so that 'except Exception' does not swallow it."""


_SIGNALS = [getattr(signal, n) for n in ("SIGTERM", "SIGINT", "SIGBREAK") if hasattr(signal, n)]


def _raise_cancelled(signum, frame):
    raise Cancelled()


def set_signal_handlers(handler):
    for sig in _SIGNALS:
        try:
            signal.signal(sig, handler)
        except (ValueError, OSError):
            pass


class Report:
    """Writes each entry immediately to a .jsonl file. finalize() turns it into the final .json report.

    If only the .jsonl remains after a hard kill (process terminated without Python being able to react),
    it is finalized by finalize_orphans() on the next start.
    """

    def __init__(self, stamp, dry, total, meta):
        os.makedirs(REPORT_DIR, exist_ok=True)
        self.base = os.path.join(REPORT_DIR, f"report_{stamp}{'_dry' if dry else ''}")
        self.live, self.final = self.base + ".jsonl", self.base + ".json"
        self.total = total
        self.entries = []
        self.counts = {"updated": 0, "unchanged": 0, "no_data": 0, "skipped": 0, "unsure": 0, "error": 0}
        self.fh = open(self.live, "a", encoding="utf-8")
        self._line({"type": "header", "total": total,
                    "started": datetime.now().isoformat(timespec="seconds"), **meta})

    def _line(self, obj):
        self.fh.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.fh.flush()

    def add(self, status, perf, **extra):
        entry = {"id": perf["id"], "name": perf["name"], "status": status, **extra}
        self.counts["unchanged" if status == "no_result" else status] += 1
        self.entries.append(entry)
        self._line(entry)

    def finalize(self, status, interrupted_at=None):
        self.fh.close()
        data = {"status": status, "total": self.total,
                "processed": len(self.entries), "counts": self.counts}
        if interrupted_at:
            data["interrupted_at"] = interrupted_at
        data["entries"] = self.entries
        write_json_atomic(self.final, data)
        try:
            os.remove(self.live)
        except OSError:
            pass
        return self.final


def write_json_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def finalize_orphans():
    """Finalizes reports left over from a run that was killed hard."""
    for live in sorted(glob.glob(os.path.join(REPORT_DIR, "report_*.jsonl"))):
        header, entries = {}, []
        with open(live, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue  # the last line may be half-written after an abort
                if row.get("type") == "header":
                    header = row
                else:
                    entries.append(row)
        counts = {"updated": 0, "unchanged": 0, "no_data": 0, "skipped": 0, "unsure": 0, "error": 0}
        for e in entries:
            counts["unchanged" if e.get("status") == "no_result" else e.get("status", "error")] += 1
        data = {"status": "aborted", "total": header.get("total"), "processed": len(entries),
                "counts": counts, "started": header.get("started"), "entries": entries}
        write_json_atomic(live[:-1], data)  # .jsonl -> .json
        os.remove(live)
        log("w", f"Finalized report of an aborted run: {os.path.basename(live[:-1])}")


def run(stash, cfg):
    fields = cfg["fields"]
    scraper_ids = cfg["scrapers"]
    overwrite = bool(cfg.get("overwrite"))
    dry = bool(cfg.get("dry_run"))
    delay = float(cfg.get("delay", 1.0))
    threshold = float(cfg.get("threshold", 0.85))
    use_disambig = bool(cfg.get("use_disambiguation", True))
    genders = cfg.get("genders") or None  # None = all; "NONE" = unspecified
    create_tags = bool(cfg.get("create_tags")) and not dry
    scope = cfg.get("scope") or {"type": "all"}

    specs = {s["id"]: (s.get("performer") or {})
             for s in stash.call(Q_SCRAPERS)["listScrapers"]}

    pf, ids = {}, None
    if scope["type"] == "tag":
        pf["tags"] = {"value": [scope["tag_id"]], "modifier": "INCLUDES"}
    elif scope["type"] == "ids":
        ids = [int(i) for i in scope["ids"]]
    pf = pf or None
    performers = stash.call(
        Q_FIND, {"f": {"per_page": -1, "sort": "name"}, "pf": pf, "ids": ids}
    )["findPerformers"]["performers"]

    if genders:
        performers = [p for p in performers if (p.get("gender") or "NONE") in genders]

    total = len(performers)
    log("i", f"{total} performers, scrapers: {', '.join(scraper_ids)}, genders: {', '.join(genders) if genders else 'all'}, "
             f"Disambiguation: {use_disambig}, Dry Run: {dry}")

    finalize_orphans()
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_file = None
    if not dry:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        backup_file = os.path.join(BACKUP_DIR, f"backup_{stamp}.jsonl")

    report = Report(stamp, dry, total, {"dry_run": dry, "scrapers": scraper_ids, "fields": fields,
                                        "overwrite": overwrite, "genders": genders, "scope": scope})
    tag_cache = {}
    status, current = "completed", None

    try:
        for i, perf in enumerate(performers):
            current = perf["name"]
            log("p", f"{i / max(total, 1):.4f}")
            try:
                wanted = [f for f in fields if overwrite or is_empty(f, perf)]
                if not wanted:
                    report.add("skipped", perf)  # no request, no delay
                    continue

                changes, unsure, matched = {}, False, False
                for sid in scraper_ids:
                    remaining = [f for f in wanted if f not in changes]
                    if not remaining:
                        break
                    sc, uns = scrape(stash, sid, specs.get(sid, {}), perf, threshold, use_disambig)
                    unsure = unsure or uns
                    if sc:
                        matched = True
                        for f in remaining:
                            v = convert(f, sc, stash, create_tags, tag_cache)
                            if v is not None:
                                changes[f] = v
                    time.sleep(delay)

                update, old = {"id": perf["id"]}, {}
                for f, v in changes.items():
                    cur = current_value(f, perf)
                    if f in LIST_FIELDS:
                        # Lists are merged, never replaced
                        merged = list(cur) + [x for x in v if x not in cur]
                        if merged == cur:
                            continue
                        v = merged
                    elif v == cur:
                        continue
                    key = UPDATE_KEY.get(f, f)
                    update[key] = v
                    if f != "image":
                        old[key] = cur

                if len(update) == 1:
                    if unsure:
                        report.add("unsure", perf)
                        log("w", f"{perf['name']}: only uncertain matches (name does not fit or is ambiguous) – skipped")
                    elif matched and not changes:
                        report.add("no_data", perf)
                        log("w", f"{perf['name']}: performer found, but the scraper does not return the requested values")
                    else:
                        report.add("no_result", perf)
                    continue

                changed = [k for k in update if k != "id"]
                if dry:
                    log("i", f"[Dry Run] {perf['name']}: {', '.join(changed)}")
                else:
                    with open(backup_file, "a", encoding="utf-8") as fh:
                        fh.write(json.dumps({"id": perf["id"], "name": perf["name"], "values": old}) + "\n")
                    stash.call(Q_UPDATE, {"input": update})
                    log("i", f"{perf['name']}: {', '.join(changed)}")
                report.add("updated", perf, fields=changed, dry_run=dry)
            except Exception as e:  # catch per performer, continue the run
                report.add("error", perf, error=str(e))
                log("e", f"{perf['name']}: {e}")
                time.sleep(delay)
    except Cancelled:
        status = "cancelled"
        set_signal_handlers(signal.SIG_IGN)  # finish writing the report undisturbed
        log("w", f"Task cancelled (last processed: {current}). Writing report …")

    report_file = report.finalize(status, current if status == "cancelled" else None)
    c = report.counts
    if status == "completed":
        log("p", "1")
    summary = (f"{'Completed' if status == 'completed' else 'Cancelled'}. Updated: {c['updated']}, "
               f"no result/unchanged: {c['unchanged']}, found without values: {c['no_data']}, skipped: {c['skipped']}, "
               f"unsure: {c['unsure']}, errors: {c['error']}. Report: {report_file}")
    log("i", summary)
    return summary


def apply(stash, args):
    """Applies the results selected in the UI review (backup + report as in a normal run)."""
    payload = json.loads(args["payload"])
    items = payload["items"]
    create_tags = bool(payload.get("create_tags"))
    total = len(items)

    finalize_orphans()
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup_file = os.path.join(BACKUP_DIR, f"backup_{stamp}.jsonl")
    report = Report(stamp, False, total, {"mode": "apply"})
    tag_cache, status, current = {}, "completed", None
    log("i", f"Applying {total} performers from the review")

    try:
        for i, item in enumerate(items):
            current = item["name"]
            log("p", f"{i / max(total, 1):.4f}")
            try:
                update = dict(item["update"])
                update["id"] = item["id"]
                old = dict(item.get("old") or {})

                new_ids = []
                if create_tags:
                    for name in item.get("new_tags") or []:
                        tid = find_or_create_tag(stash, name, True, tag_cache)
                        if tid:
                            new_ids.append(str(tid))
                if new_ids:
                    base = list(update.get("tag_ids", old.get("tag_ids", [])))
                    old.setdefault("tag_ids", list(base))
                    update["tag_ids"] = base + [t for t in new_ids if t not in base]

                with open(backup_file, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"id": item["id"], "name": item["name"], "values": old}) + "\n")
                stash.call(Q_UPDATE, {"input": update})
                changed = [k for k in update if k != "id"]
                log("i", f"{item['name']}: {', '.join(changed)}")
                report.add("updated", item, fields=changed, dry_run=False)
            except Exception as e:
                report.add("error", item, error=str(e))
                log("e", f"{item['name']}: {e}")
    except Cancelled:
        status = "cancelled"
        set_signal_handlers(signal.SIG_IGN)
        log("w", f"Task cancelled (last processed: {current}). Writing report …")

    report_file = report.finalize(status, current if status == "cancelled" else None)
    c = report.counts
    if status == "completed":
        log("p", "1")
    summary = (f"{'Completed' if status == 'completed' else 'Cancelled'}. Applied: {c['updated']} of {total}, "
               f"Errors: {c['error']}. Report: {report_file}")
    log("i", summary)
    return summary


def restore(stash, args):
    path = args.get("backup_file")
    if not path:
        files = sorted(glob.glob(os.path.join(BACKUP_DIR, "backup_*.jsonl")))
        if not files:
            raise RuntimeError("No backup found.")
        path = files[-1]
    with open(path, encoding="utf-8") as fh:
        rows = [json.loads(line) for line in fh if line.strip()]
    log("i", f"Restoring {len(rows)} performers from {os.path.basename(path)}")
    done = 0
    for i, row in enumerate(rows):
        log("p", f"{i / max(len(rows), 1):.4f}")
        update = {"id": row["id"]}
        for key, v in row["values"].items():
            if v is None:
                if key in STRING_KEYS:
                    v = ""
                else:
                    continue  # empty numbers/enums cannot be cleared via null
            update[key] = v
        try:
            stash.call(Q_UPDATE, {"input": update})
            done += 1
        except Exception as e:
            log("e", f"{row.get('name', row['id'])}: {e}")
    log("p", "1")
    return f"{done} of {len(rows)} performers restored (images are not reverted)."


def main():
    set_signal_handlers(_raise_cancelled)
    raw = json.load(sys.stdin)
    stash = Stash(raw["server_connection"])
    args = raw.get("args") or {}
    try:
        if args.get("mode") == "restore":
            out = restore(stash, args)
        elif args.get("mode") == "apply":
            out = apply(stash, args)
        else:
            if not args.get("config"):
                raise RuntimeError('No configuration provided. Please use the "Bulk Performer Scraper" page in the menu.')
            out = run(stash, json.loads(args["config"]))
        print(json.dumps({"output": out}))
    except Cancelled:
        log("w", "Task cancelled.")
        print(json.dumps({"output": "Cancelled."}))
    except Exception as e:
        log("e", str(e))
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
