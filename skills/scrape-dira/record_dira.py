#!/usr/bin/env python3
"""
Read helpers for dira.sqlite. Read-only — no writes.

Usage:
  python3 record_dira.py list [--sort odds|price|city]
  python3 record_dira.py get --project 79632 --lottery 2711
  python3 record_dira.py stats
"""
import argparse
import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent.parent / "data" / "dira.sqlite"


def connect():
    if not DB_PATH.exists():
        raise SystemExit(f"DB not found: {DB_PATH}  — run scrape_dira.py first")
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)


def _latest_snap_query():
    return """
        LEFT JOIN (
            SELECT project_id, lottery_id,
                   registrants, registrants_local, registrants_handicapped,
                   registrants_reserve_duty, registrants_combat, participants_count
            FROM registration_snapshots
            WHERE (project_id, lottery_id, scraped_at) IN (
                SELECT project_id, lottery_id, MAX(scraped_at)
                FROM registration_snapshots GROUP BY project_id, lottery_id
            )
        ) s USING (project_id, lottery_id)
    """


def cmd_list(args):
    sort = getattr(args, "sort", "odds")
    order = {
        "odds": "odds_pct DESC NULLS LAST",
        "price": "l.price_per_meter ASC",
        "city": "l.city, l.neighborhood",
    }.get(sort, "odds_pct DESC NULLS LAST")

    conn = connect()
    rows = conn.execute(f"""
        SELECT l.project_id, l.lottery_id, l.city, l.neighborhood,
               l.process_name, l.apartments_for_eligible, l.price_per_meter,
               l.reserve_combat_units, l.reserve_active_units, l.local_housing_units,
               s.registrants, s.participants_count,
               ROUND(CAST(l.apartments_for_eligible AS REAL)
                     / NULLIF(COALESCE(s.participants_count, s.registrants), 0) * 100, 2) AS odds_pct,
               l.signup_end_date
        FROM lotteries l
        {_latest_snap_query()}
        ORDER BY {order}
    """).fetchall()
    conn.close()
    hdr = f"{'proj/lot':12} {'city':<20} {'neighborhood':<25} {'type':<16} {'apt':>4} {'price':>7} {'reg':>6} {'part':>6} {'odds%':>6} {'combat':>6} {'reserv':>6} {'local':>5}"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print(
            f"{r[0]}/{r[1]:<6} {(r[2] or ''):<20} {(r[3] or ''):<25} {(r[4] or ''):<16} "
            f"{(r[5] or 0):>4} {(r[6] or 0):>7.0f} {(r[10] or 0):>6} {(r[11] or '?'):>6} "
            f"{(r[12] or 0):>6} {(r[7] or 0):>6} {(r[8] or 0):>6} {(r[9] or 0):>5}"
        )


def cmd_get(args):
    conn = connect()
    row = conn.execute(
        f"""
        SELECT l.*, s.registrants, s.registrants_local, s.registrants_handicapped,
               s.registrants_reserve_duty, s.registrants_combat, s.participants_count
        FROM lotteries l
        {_latest_snap_query()}
        WHERE l.project_id=? AND l.lottery_id=?
        """,
        (args.project, args.lottery),
    ).fetchone()
    if not row:
        raise SystemExit("Lottery not found")
    cols = [d[0] for d in conn.execute(
        "SELECT l.*, s.registrants, s.registrants_local, s.registrants_handicapped, "
        "s.registrants_reserve_duty, s.registrants_combat, s.participants_count "
        "FROM lotteries l LEFT JOIN registration_snapshots s USING(project_id,lottery_id) LIMIT 0"
    ).description]
    print(json.dumps(dict(zip(cols, row)), ensure_ascii=False, indent=2))

    snaps = conn.execute(
        """SELECT scraped_at, registrants, registrants_local, registrants_handicapped,
                  registrants_combat, participants_count
           FROM registration_snapshots
           WHERE project_id=? AND lottery_id=? ORDER BY scraped_at""",
        (args.project, args.lottery),
    ).fetchall()
    conn.close()
    print(f"\nRegistration history ({len(snaps)} snapshots):")
    print(f"  {'time':<22} {'total':>7} {'local':>7} {'handic':>7} {'combat':>7} {'part':>7}")
    for s in snaps:
        print(f"  {s[0]:<22} {(s[1] or 0):>7} {(s[2] or 0):>7} {(s[3] or 0):>7} {(s[4] or 0):>7} {(s[5] or '?'):>7}")


def cmd_stats(args):
    conn = connect()
    total, = conn.execute("SELECT COUNT(*) FROM lotteries").fetchone()
    snaps, = conn.execute("SELECT COUNT(*) FROM registration_snapshots").fetchone()
    latest_run, = conn.execute("SELECT MAX(scraped_at) FROM registration_snapshots").fetchone()

    best = conn.execute(f"""
        SELECT l.city, l.neighborhood, l.process_name,
               l.apartments_for_eligible, s.participants_count, s.registrants,
               ROUND(CAST(l.apartments_for_eligible AS REAL)
                     / NULLIF(COALESCE(s.participants_count, s.registrants), 0) * 100, 4) AS odds_pct,
               l.price_per_meter, l.project_id, l.lottery_id
        FROM lotteries l {_latest_snap_query()}
        ORDER BY odds_pct DESC NULLS LAST LIMIT 10
    """).fetchall()

    religious = conn.execute("SELECT COUNT(*) FROM lotteries WHERE is_religious=1").fetchone()[0]
    by_type = conn.execute(
        "SELECT process_name, COUNT(*) FROM lotteries GROUP BY process_name ORDER BY 2 DESC"
    ).fetchall()

    conn.close()
    print(f"Lotteries: {total}  |  Snapshots: {snaps}  |  Last run: {latest_run}")
    print(f"Religious community lotteries: {religious}")
    print(f"By type: {dict(by_type)}")
    print(f"\nTop 10 best odds (using participants_count when available):")
    print(f"  {'city':<20} {'neighborhood':<25} {'type':<14} {'apts':>4} {'part':>6} {'reg':>6} {'odds%':>7} {'₪/m²':>6}")
    for r in best:
        print(f"  {(r[0] or ''):<20} {(r[1] or ''):<25} {(r[2] or ''):<14} "
              f"{(r[3] or 0):>4} {(r[4] or '?'):>6} {(r[5] or 0):>6} {(r[6] or 0):>7} {(r[7] or 0):>6.0f}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd")
    ls = sub.add_parser("list")
    ls.add_argument("--sort", choices=["odds", "price", "city"], default="odds")
    g = sub.add_parser("get")
    g.add_argument("--project", type=int, required=True)
    g.add_argument("--lottery", type=int, required=True)
    sub.add_parser("stats")
    args = p.parse_args()
    {"list": cmd_list, "get": cmd_get, "stats": cmd_stats}.get(
        args.cmd, lambda _: p.print_help()
    )(args)


if __name__ == "__main__":
    main()
