import gzip
import json
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
            """)
            db.executemany("INSERT INTO places VALUES (?, ?, ?, ?, ?, ?, ?)", (
                (name, address, lon, lat, road, normalize(name), normalize(address))
                for name, address, _, lon, lat, road in records
            ))
            db.executemany("INSERT INTO place_search(rowid, terms) VALUES (?, ?)", (
                (i, " ".join((normalize(name), normalize(address), normalize(aliases))))
                for i, (name, address, aliases, *_rest) in enumerate(records, 1)
            ))
        snapshot.replace(PLACES_DB)
    print(f"已建立 {len(records)} 筆本機地點索引")


def search_places(query):
    query = normalize(query)
    if len(query) < 2:
        return []
    keys = address_keys(query)
    if keys:
        query = keys[0]
    alternate = keys[-1] if keys else query
    match = " OR ".join('"' + value.replace('"', '""') + '"' for value in dict.fromkeys((query, alternate)))
    with closing(sqlite3.connect(f"{PLACES_DB.as_uri()}?mode=ro", uri=True)) as db:
        if len(query) >= 3:
            source = "place_search JOIN places AS p ON p.rowid = place_search.rowid WHERE place_search MATCH :match"
        else:
            source = "places AS p WHERE (instr(name_key, :query) > 0 OR instr(address_key, :query) > 0)"
        rows = db.execute(f"""
            SELECT name, address, lon, lat, road
            FROM {source}
            AND (:address = 0 OR name_key IN (:query, :alternate) OR address_key IN (:query, :alternate))
            ORDER BY CASE
                WHEN name_key IN (:query, :alternate) THEN 0
                WHEN address_key IN (:query, :alternate) THEN 1
                WHEN instr(name_key, :query) = 1 OR instr(address_key, :query) = 1 THEN 2
                WHEN instr(name_key, :query) > 0 OR instr(address_key, :query) > 0 THEN 3
                ELSE 4 END,
                length(name_key), (address = '' OR instr(address, ';') > 0), p.rowid
            LIMIT 50
        """, {"query": query, "alternate": alternate, "match": match, "address": bool(keys)}).fetchall()
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
