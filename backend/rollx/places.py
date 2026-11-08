import gzip
import json
import math
import re
import sqlite3
import tempfile
import unicodedata
from contextlib import closing
from pathlib import Path

from .facilities import DEFAULT_DB_PATH

PLACES_DB = DEFAULT_DB_PATH.parent / "places.sqlite"
PLACES_SOURCE = DEFAULT_DB_PATH.parent / "source" / "places.json.gz"


def normalize(text):
    text = unicodedata.normalize("NFKC", text).casefold().replace("臺", "台")
    return "".join(text.split())


TAIPEI_PREFIX = re.compile(
    r"^(?:台灣[,、]*)?(?:[0-9]{3}(?:[0-9]{2,3})?[,、]*)?"
    r"(?:台北市[,、]*)?(?:(?:松山|信義|大安|中山|中正|大同|萬華|文山|南港|內湖|士林|北投)區[,、]*)?"
)
STREET_ADDRESS = re.compile(
    r"^(?P<street>[㐀-鿿]+[路街道](?:[一二三四五六七八九十0-9]+段)?)"
    r"(?P<number>(?:[0-9]+巷)?(?:[0-9]+弄)?[0-9]+(?:[之-][0-9]+)?號(?:之[0-9]+)?)"
    r"(?:[,、]*(?:[0-9]+(?:樓|f)(?:之[0-9]+)?|b[0-9]+))?[,、]*$"
)
SECTION_NUMBERS = "一二三四五六七八九十"


def address_keys(query):
    # The source stores street and house number separately from administrative areas.
    match = STREET_ADDRESS.fullmatch(TAIPEI_PREFIX.sub("", query, count=1))
    if not match:
        return []
    street, number = match["street"], match["number"]
    sections = re.search(r"([0-9]+|[一二三四五六七八九十])段$", street)
    if not sections:
        return [street + number]
    section = sections[1]
    value = int(section) if section.isdecimal() else SECTION_NUMBERS.index(section) + 1
    if not 1 <= value <= len(SECTION_NUMBERS):
        return [street + number]
    prefix = street[:sections.start()]
    return [f"{prefix}{SECTION_NUMBERS[value - 1]}段{number}", f"{prefix}{value}段{number}"]


def bigrams(text):
    return " ".join(text[i:i + 2] for i in range(len(text) - 1))


def build_places():
    with gzip.open(PLACES_SOURCE, "rt", encoding="utf-8") as file:
        records = json.load(file)

    with tempfile.TemporaryDirectory(dir=PLACES_DB.parent) as temp:
        snapshot = Path(temp) / PLACES_DB.name
        with closing(sqlite3.connect(snapshot)) as db, db:
            db.executescript("""
                CREATE TABLE places (name TEXT, address TEXT, lon REAL, lat REAL, road INTEGER,
                                     name_key TEXT, address_key TEXT);
                CREATE VIRTUAL TABLE place_search USING fts5(terms, content='', tokenize='trigram');
                -- Trigram FTS cannot look up two-character terms (天母, 全家) without a table scan.
                CREATE VIRTUAL TABLE place_bigrams USING fts5(terms, content='', tokenize='unicode61');
            """)
            db.executemany("INSERT INTO places VALUES (?, ?, ?, ?, ?, ?, ?)", (
                (name, address, lon, lat, road, normalize(name), normalize(address))
                for name, address, _, lon, lat, road in records
            ))
            db.executemany("INSERT INTO place_search(rowid, terms) VALUES (?, ?)", (
                (i, " ".join((normalize(name), normalize(address), normalize(aliases))))
                for i, (name, address, aliases, *_rest) in enumerate(records, 1)
            ))
            db.executemany("INSERT INTO place_bigrams(rowid, terms) VALUES (?, ?)", (
                (i, bigrams(normalize(name)) + " " + bigrams(normalize(address)))
                for i, (name, address, *_rest) in enumerate(records, 1)
            ))
        snapshot.replace(PLACES_DB)
    print(f"已建立 {len(records)} 筆本機地點索引")


def fts_phrase(value):
    return '"' + value.replace('"', '""') + '"'


def strict_rows(db, query, alternate=None, address=False, names_only=False, limit=50):
    """Contiguous-substring match, best tier first (the original search)."""
    alternate = alternate or query
    match = " OR ".join(fts_phrase(value) for value in dict.fromkeys((query, alternate)))
    if len(query) >= 3:
        source = "place_search JOIN places AS p ON p.rowid = place_search.rowid WHERE place_search MATCH :match"
    elif query.isalnum():
        source = "place_bigrams JOIN places AS p ON p.rowid = place_bigrams.rowid WHERE place_bigrams MATCH :match"
    else:
        source = "places AS p WHERE (instr(name_key, :query) > 0 OR instr(address_key, :query) > 0)"
    return db.execute(f"""
        SELECT name, address, lon, lat, road
        FROM {source}
        AND (:address = 0 OR name_key IN (:query, :alternate) OR address_key IN (:query, :alternate))
        AND (:names = 0 OR instr(name_key, :query) > 0)
        ORDER BY CASE
            WHEN name_key IN (:query, :alternate) THEN 0
            WHEN address_key IN (:query, :alternate) THEN 1
            WHEN instr(name_key, :query) = 1 OR instr(address_key, :query) = 1 THEN 2
            WHEN instr(name_key, :query) > 0 OR instr(address_key, :query) > 0 THEN 3
            ELSE 4 END,
            length(name_key), (address = '' OR instr(address, ';') > 0), p.rowid
        LIMIT :limit
    """, {"query": query, "alternate": alternate, "match": match, "address": address,
          "names": names_only, "limit": limit}).fetchall()


STATION_PATTERNS = [
    # 士林捷運站 / 捷運士林 / 士林捷運 / 士林站 → 捷運士林站 (how Metro stations are named in the data)
    (re.compile(r"(?:台北|北)?捷運(.{2,}?)站?"), r"捷運\1站"),
    (re.compile(r"(.{2,}?)捷運站?"), r"捷運\1站"),
    (re.compile(r"(.{2,}?)(?:火車|高鐵|台鐵)站"), r"\1車站"),
    (re.compile(r"(.{2,}?)站"), r"捷運\1站"),
]
# Shortest first: 台北市長官邸 should become 市長官邸 before 長官邸.
CITY_PREFIXES = ("台北", "新北", "台北市", "新北市", "台北市立", "新北市立", "市立", "國立")


def without_city_prefix(query):
    return [query[len(prefix):] for prefix in CITY_PREFIXES
            if query.startswith(prefix) and len(query) - len(prefix) >= 2]


def query_variants(query):
    variants = [query]
    for pattern, template in STATION_PATTERNS:
        match = pattern.fullmatch(query)
        if match:
            variants.append(match.expand(template))
    return list(dict.fromkeys(variants))


def match_tier(row, query):
    name, address = normalize(row[0]), normalize(row[1])
    if query == name:
        return 0
    if query == address:
        return 1
    return 2 if name.startswith(query) or address.startswith(query) else 3


def collect_strict(db, query):
    # 台北火車站 → the rewritten 台北車站's exact hits outrank 臺北火車站郵局; ties keep the query's own order.
    ranked = [
        (match_tier(row, variant), index, order, row)
        for index, variant in enumerate(query_variants(query))
        for order, row in enumerate(strict_rows(db, variant))
    ]
    return [row for *_, row in sorted(ranked, key=lambda item: item[:3])]


FUZZY_MIN_SHARE = 0.6


def fuzzy_rows(db, query):
    """Rows sharing most of the query's trigrams (tolerates typos and small insertions)."""
    grams = list(dict.fromkeys(query[i:i + 3] for i in range(len(query) - 2)))
    if len(grams) < 2:
        return []
    needed = max(2, math.ceil(len(grams) * FUZZY_MIN_SHARE))
    union = " UNION ALL ".join("SELECT rowid FROM place_search WHERE place_search MATCH ?" for _ in grams)
    # Hits in the name outrank hits that only come from aliases or the address.
    name_hits = " + ".join("(instr(name_key, ?) > 0)" for _ in grams)
    return db.execute(f"""
        SELECT name, address, lon, lat, road
        FROM (SELECT rowid, count(*) AS hits FROM ({union}) GROUP BY rowid HAVING hits >= ?) AS m
        JOIN places AS p ON p.rowid = m.rowid
        ORDER BY {name_hits} DESC, hits DESC, length(name_key),
                 (address = '' OR instr(address, ';') > 0), p.rowid
        LIMIT 50
    """, [fts_phrase(gram) for gram in grams] + [needed] + grams).fetchall()


NEAR_CELL = 0.005  # degrees (~500 m); a target counts area anchors in its 3x3 cell block (~1.5 km)
BRANCH_SUFFIX = re.compile(r"(?:分店|門市|店)$")


def nearby_rows(db, query):
    """「天母體育館」→ 體育館 among places called 天母; 「新光三越天母店」→ 新光三越 among 天母."""
    splits = []
    branch = BRANCH_SUFFIX.search(query)
    if branch:
        stem = query[:branch.start()]
        splits += [(stem[:i], stem[i:]) for i in range(len(stem) - 2, 1, -1)]
    splits += [(query[i:], query[:i]) for i in range(2, len(query) - 1)]
    for target, area in splits:
        # Two-character parts must be indexable as bigrams; anything else would scan the table.
        if any(len(part) < 2 or len(part) == 2 and not part.isalnum() for part in (target, area)):
            continue
        targets = strict_rows(db, target, names_only=True, limit=3000)
        if not targets:
            continue
        # Both parts in the name, in the other order (信義誠品 → 誠品信義店).
        both = [row for row in targets if area in normalize(row[0])]
        if both:
            return both
        anchors = strict_rows(db, area, limit=3000)
        if not anchors:
            continue
        cells = {}
        for *_, lon, lat, _road in anchors:
            key = (int(lon // NEAR_CELL), int(lat // NEAR_CELL))
            cells[key] = cells.get(key, 0) + 1
        scored = []
        for order, row in enumerate(targets):
            x, y = int(row[2] // NEAR_CELL), int(row[3] // NEAR_CELL)
            score = sum(cells.get((x + dx, y + dy), 0) for dx in (-1, 0, 1) for dy in (-1, 0, 1))
            scored.append((-score, order, row))
        scored.sort()
        # Keep only the area's main cluster, not targets next to one stray namesake.
        needed = max(1, len(anchors) // 20, -scored[0][0] // 4)
        near = [row for score, _, row in scored if -score >= needed]
        if near:
            return near
    return []


def search_places(query):
    query = normalize(query)
    if len(query) < 2:
        return []
    with closing(sqlite3.connect(f"{PLACES_DB.as_uri()}?mode=ro", uri=True)) as db:
        keys = address_keys(query)
        if keys:
            rows = strict_rows(db, keys[0], keys[-1], address=True)
        else:
            rows = collect_strict(db, query)
            if not rows:
                # Nothing contains the query verbatim: try looser forms, most literal first.
                stripped = without_city_prefix(query)
                for shorter in stripped:
                    rows = collect_strict(db, shorter)
                    if rows:
                        break
                core = stripped[-1] if stripped else query
                rows = rows or fuzzy_rows(db, query) or (core != query and fuzzy_rows(db, core)) \
                    or nearby_rows(db, core)
    results = []
    for name, address, lon, lat, road in rows:
        if ';' in address:
            address = ''
        if any(
            normalize(name) == normalize(item["name"])
            and (not address or not item["address"] or normalize(address) == normalize(item["address"]))
            and abs(lon - item["coordinates"][0]) < 0.0015
            and abs(lat - item["coordinates"][1]) < 0.0015
            for item in results
        ):
            continue
        results.append({
            "name": name, "address": address if address != name else "",
            "coordinates": [lon, lat], "is_road": bool(road),
        })
        if len(results) == 10:
            break
    return results


if __name__ == "__main__":
    build_places()
