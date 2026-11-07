import argparse
import json
from pathlib import Path

from shapely.geometry import shape


PARKING_KIND = "accessible-parking"
PARKING_LABELS = {
    "03": "身障專用汽車格",
    "04": "身障專用機車格",
    "18": "身障專用機慢車格",
}
SNAPSHOT = Path(__file__).resolve().parents[1] / "data" / "source" / f"facility-{PARKING_KIND}.json"


def export_parking(shp_path, target):
    import shapefile
    from pyproj import CRS, Transformer

    crs = CRS.from_wkt(shp_path.with_suffix(".prj").read_text(encoding="utf-8-sig"))
    project = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    rows = []
    skipped = 0
    with shapefile.Reader(str(shp_path), encoding="utf-8") as source:
        for record in source.iterRecords(fields=["pktype", "pkadrs", "roadname", "pkroad"]):
            parking_label = PARKING_LABELS.get(record["pktype"].strip())
            if not parking_label:
                continue
            slot = source.shape(record.oid)
            if not slot.points:
                skipped += 1
                continue
            center = shape(slot.__geo_interface__).representative_point()
            lon, lat = project.transform(center.x, center.y)
            if not (121.35 <= lon <= 121.75 and 24.86 <= lat <= 25.31):
                skipped += 1
                continue
            location = next((record[key].strip() for key in ("pkadrs", "roadname", "pkroad") if record[key].strip()), "")
            rows.append({
                "kind": PARKING_KIND, "kname": f"{location} · {parking_label}" if location else parking_label,
                "lon": round(lon, 7), "lat": round(lat, 7),
            })
    if not rows:
        raise ValueError("找不到有效的身心障礙停車格")
    target.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"已擷取 {len(rows)} 筆身心障礙停車格，略過 {skipped} 筆無效座標")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="將市府路邊停車格 SHP 轉為 Roll X 本機點位快照")
    parser.add_argument("shp", type=Path)
    parser.add_argument("--output", type=Path, default=SNAPSHOT)
    args = parser.parse_args()
    export_parking(args.shp, args.output)
