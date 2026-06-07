#!/usr/bin/env python3
"""
Read-only exporter: dira.sqlite → webapp/data.json
Run after scrape_dira.py to refresh the dashboard.

READ ONLY — never writes to the DB, never touches the website.
"""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent.parent.parent / "data" / "dira.sqlite"
OUT_PATH = Path(__file__).parent.parent.parent / "webapp" / "data.json"


def main():
    if not DB_PATH.exists():
        raise SystemExit(f"DB not found: {DB_PATH} — run scrape_dira.py first")

    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    rows = conn.execute("""
        SELECT
            l.project_id, l.lottery_id,
            l.city, l.neighborhood,
            l.process_name,
            l.apartments_in_project,
            l.apartments_for_eligible,
            l.reserve_combat_units,
            l.reserve_active_units,
            l.local_housing_units,
            l.handicapped_units,
            l.has_handicapped_pref,
            l.price_per_meter,
            l.is_religious,
            l.batch_name,
            l.tender_name,
            l.signup_start_date,
            l.signup_end_date,
            l.lot_delivery_date,
            l.developer,
            l.lottery_status,
            l.source_url,
            s.registrants,
            s.registrants_local,
            s.registrants_handicapped,
            s.registrants_reserve_duty,
            s.registrants_combat,
            s.participants_count,
            s.scraped_at
        FROM lotteries l
        LEFT JOIN (
            SELECT project_id, lottery_id,
                   registrants, registrants_local, registrants_handicapped,
                   registrants_reserve_duty, registrants_combat, participants_count,
                   scraped_at
            FROM registration_snapshots
            WHERE (project_id, lottery_id, scraped_at) IN (
                SELECT project_id, lottery_id, MAX(scraped_at)
                FROM registration_snapshots
                GROUP BY project_id, lottery_id
            )
        ) s USING (project_id, lottery_id)
        ORDER BY l.city, l.price_per_meter
    """).fetchall()

    lotteries = []
    cities = set()

    for r in rows:
        A  = r["apartments_for_eligible"] or 0
        ah = r["handicapped_units"] or 0
        ac = r["reserve_combat_units"] or 0
        ar = r["reserve_active_units"] or 0
        al = r["local_housing_units"] or 0
        a_open = max(0, A - (ah + ac + ar + al))

        cities.add(r["city"])
        lotteries.append({
            "project_id":           r["project_id"],
            "lottery_id":           r["lottery_id"],
            "city":                 r["city"],
            "neighborhood":         r["neighborhood"],
            "process_name":         r["process_name"],
            "apartments_in_project":r["apartments_in_project"],
            "apartments_for_eligible": A,
            "reserve_combat_units": ac,
            "reserve_active_units": ar,
            "local_housing_units":  al,
            "handicapped_units":    ah,
            "has_handicapped_pref": bool(r["has_handicapped_pref"]),
            "a_open":               a_open,
            "price_per_meter":      r["price_per_meter"],
            "is_religious":         bool(r["is_religious"]),
            "batch_name":           r["batch_name"],
            "tender_name":          r["tender_name"],
            "signup_start_date":    r["signup_start_date"],
            "signup_end_date":      r["signup_end_date"],
            "lot_delivery_date":    r["lot_delivery_date"],
            "developer":            r["developer"],
            "lottery_status":       r["lottery_status"],
            "source_url":           r["source_url"],
            "registrants":          r["registrants"],
            "registrants_local":    r["registrants_local"],
            "registrants_handicapped": r["registrants_handicapped"],
            "registrants_reserve_duty": r["registrants_reserve_duty"],
            "registrants_combat":   r["registrants_combat"],
            "participants_count":   r["participants_count"],
            "scraped_at":           r["scraped_at"],
        })

    conn.close()

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cities": sorted(cities - {None}),
        "lotteries": lotteries,
    }
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"Wrote {len(lotteries)} lotteries to {OUT_PATH}")
    print(f"Cities: {sorted(cities - {None})}")


if __name__ == "__main__":
    main()
