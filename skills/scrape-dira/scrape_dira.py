#!/usr/bin/env python3
"""
Dira b'Hanacha lottery scraper.
READ ONLY — fetches public data from dira.moch.gov.il, writes only to local SQLite.
Never submits enrollment forms, never clicks anything, never leaves ProjectsList data.
"""
import gzip
import json
import re
import sqlite3
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

DB_PATH = Path(__file__).parent.parent.parent / "data" / "dira.sqlite"
BASE_URL = "https://www.dira.moch.gov.il"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://dira.moch.gov.il/ProjectsList",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS lotteries (
  project_id                INTEGER NOT NULL,
  lottery_id                INTEGER NOT NULL,
  city                      TEXT,
  neighborhood              TEXT,
  process_name              TEXT,
  apartments_in_project     INTEGER,
  apartments_for_eligible   INTEGER,
  reserve_combat_units      INTEGER,
  reserve_active_units      INTEGER,
  local_housing_units       INTEGER,
  handicapped_units         INTEGER,
  has_handicapped_pref      INTEGER,
  price_per_meter           REAL,
  grant_size                REAL,
  is_religious              INTEGER,
  batch_name                TEXT,
  tender_name               TEXT,
  entitlement               TEXT,
  responsibility            TEXT,
  price_index               TEXT,
  project_name              TEXT,
  developer                 TEXT,
  contractor_email          TEXT,
  contractor_phone          TEXT,
  lottery_status            TEXT,
  signup_start_date         TEXT,
  signup_end_date           TEXT,
  lot_delivery_date         TEXT,
  contractor_win_lot_date   TEXT,
  source_url                TEXT,
  first_seen                TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen                 TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, lottery_id)
);

CREATE TABLE IF NOT EXISTS registration_snapshots (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id                INTEGER NOT NULL,
  lottery_id                INTEGER NOT NULL,
  scraped_at                TEXT NOT NULL DEFAULT (datetime('now')),
  registrants               INTEGER,
  registrants_local         INTEGER,
  registrants_handicapped   INTEGER,
  registrants_reserve_duty  INTEGER,
  registrants_combat        INTEGER,
  participants_count        INTEGER,
  FOREIGN KEY (project_id, lottery_id) REFERENCES lotteries(project_id, lottery_id)
);
CREATE INDEX IF NOT EXISTS idx_snap_lottery
  ON registration_snapshots(project_id, lottery_id, scraped_at);
"""

# Columns added after initial release — handled via ALTER TABLE migration
MIGRATION_COLUMNS = {
    "lotteries": [
        ("process_name", "TEXT"),
        ("local_housing_units", "INTEGER"),
        ("handicapped_units", "INTEGER"),
        ("has_handicapped_pref", "INTEGER"),
        ("grant_size", "REAL"),
        ("is_religious", "INTEGER"),
        ("batch_name", "TEXT"),
        ("tender_name", "TEXT"),
        ("entitlement", "TEXT"),
        ("responsibility", "TEXT"),
        ("price_index", "TEXT"),
        ("signup_start_date", "TEXT"),
        ("lot_delivery_date", "TEXT"),
        ("contractor_win_lot_date", "TEXT"),
        ("contractor_email", "TEXT"),
        ("contractor_phone", "TEXT"),
        ("lottery_date", "TEXT"),
    ],
    "registration_snapshots": [
        ("registrants_local", "INTEGER"),
        ("registrants_handicapped", "INTEGER"),
        ("registrants_reserve_duty", "INTEGER"),
        ("registrants_combat", "INTEGER"),
        ("participants_count", "INTEGER"),
    ],
}


def _get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
    except urllib.error.HTTPError as e:
        if e.code == 471:
            raise RuntimeError("RATE_LIMITED: IP temporarily blocked by site WAF (471). Wait ~30 min.") from e
        raise
    try:
        body = gzip.decompress(body)
    except Exception:
        pass
    return json.loads(body)


def fetch_lotteries_by_status(status, page_size=200):
    param = quote(
        f"?firstApplicantIdentityNumber=&secondApplicantIdentityNumber="
        f"&ProjectStatus={status}&Entitlement=1&PageNumber=1&PageSize={page_size}&IsInit=true&",
        safe="",
    )
    try:
        data = _get(f"{BASE_URL}/api/Invoker?method=Projects&param={param}")
        if data and data.get("ActionStatus") == 1:
            return data.get("ProjectItems", [])
    except Exception as e:
        print(f"Error fetching status {status}: {e}")
    return []


def fetch_participants_count(project_id, lottery_id):
    """Return verified-eligible participant count from LotteryResult, or None on failure."""
    try:
        param = quote(f"?ProjectNumber={project_id}&LotteryNumber={lottery_id}&", safe="")
        data = _get(f"{BASE_URL}/api/Invoker?method=LotteryResult&param={param}")
        result = data.get("MyLotteryResult") or {}
        count = result.get("ParticipantsCount")
        return count if isinstance(count, int) and count > 0 else None
    except Exception:
        return None


def _strip_html(html):
    if not html:
        return None
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"&quot;", '"', text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"&nbsp;", " ", text)
    return re.sub(r"\s+", " ", text).strip() or None


def open_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    # Apply any missing columns from migrations
    for table, cols in MIGRATION_COLUMNS.items():
        existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        for col, typ in cols:
            if col not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
    conn.commit()
    return conn


def upsert_lottery(conn, item, participants_count, now):
    project_id = int(item["ProjectNumber"])
    lottery_id = int(item["LotteryNumber"])
    source_url = f"{BASE_URL}/{project_id}/{lottery_id}/ProjectInfo"
    bool_to_int = lambda v: None if v is None else int(bool(v))

    conn.execute(
        """
        INSERT INTO lotteries (
          project_id, lottery_id, city, neighborhood, process_name,
          apartments_in_project, apartments_for_eligible,
          reserve_combat_units, reserve_active_units,
          local_housing_units, handicapped_units, has_handicapped_pref,
          price_per_meter, grant_size, is_religious,
          batch_name, tender_name, entitlement, responsibility, price_index,
          project_name, developer, contractor_email, contractor_phone,
          lottery_status, signup_start_date, signup_end_date,
          lot_delivery_date, contractor_win_lot_date,
          source_url, first_seen, last_seen
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id, lottery_id) DO UPDATE SET
          city=excluded.city, neighborhood=excluded.neighborhood,
          process_name=excluded.process_name,
          apartments_in_project=excluded.apartments_in_project,
          apartments_for_eligible=excluded.apartments_for_eligible,
          reserve_combat_units=excluded.reserve_combat_units,
          reserve_active_units=excluded.reserve_active_units,
          local_housing_units=excluded.local_housing_units,
          handicapped_units=excluded.handicapped_units,
          has_handicapped_pref=excluded.has_handicapped_pref,
          price_per_meter=excluded.price_per_meter,
          grant_size=excluded.grant_size,
          is_religious=excluded.is_religious,
          batch_name=excluded.batch_name,
          tender_name=excluded.tender_name,
          entitlement=excluded.entitlement,
          responsibility=excluded.responsibility,
          price_index=excluded.price_index,
          project_name=excluded.project_name,
          developer=excluded.developer,
          contractor_email=excluded.contractor_email,
          contractor_phone=excluded.contractor_phone,
          lottery_status=excluded.lottery_status,
          signup_start_date=excluded.signup_start_date,
          signup_end_date=excluded.signup_end_date,
          lot_delivery_date=excluded.lot_delivery_date,
          contractor_win_lot_date=excluded.contractor_win_lot_date,
          source_url=excluded.source_url,
          last_seen=excluded.last_seen
        """,
        (
            project_id, lottery_id,
            item.get("CityDescription"),
            item.get("NeighborhoodName"),
            item.get("ProcessName"),
            item.get("HousingUnits"),
            item.get("LotteryApparmentsNum"),
            item.get("HU_CombatReservist_L"),
            item.get("HU_Reservists_L"),
            item.get("LocalHousing"),
            item.get("HousingUnitsForHandicapped"),
            bool_to_int(item.get("IsPreferenceForHandicapped")),
            item.get("PricePerUnit"),
            item.get("GrantSize"),
            bool_to_int(item.get("IsReligious")),
            item.get("SpecialLotteryDescription"),
            item.get("TenderName"),
            item.get("EntitlementDescription"),
            item.get("ResponsibilityDescription"),
            item.get("PriceIndexDescription"),
            item.get("ProjectName"),
            (item.get("ContractorDescription") or "").strip() or None,
            item.get("ContractorEmail"),
            item.get("ContractorPhone"),
            item.get("PermitStatus"),
            item.get("ApplicationStartDate"),
            item.get("ApplicationEndDate"),
            item.get("LotDeliveryDate"),
            item.get("ContractorWinLotDate"),
            source_url,
            now, now,
        ),
    )
    conn.execute(
        """INSERT INTO registration_snapshots (
             project_id, lottery_id, scraped_at,
             registrants, registrants_local, registrants_handicapped,
             registrants_reserve_duty, registrants_combat, participants_count
           ) VALUES (?,?,?,?,?,?,?,?,?)""",
        (
            project_id, lottery_id, now,
            item.get("TotalSubscribers"),
            item.get("TotalLocalSubscribers"),
            item.get("TotalHandicappedSubscribers"),
            item.get("TotalReservedDutySubscribers"),
            item.get("TotalCombatReservistSubscribers"),
            participants_count,
        ),
    )
    return project_id, lottery_id


def update_completed_lottery_dates(conn, now):
    # Find all closed lotteries in DB that don't have lottery_date
    # Limit to 30 to avoid rate limits
    rows = conn.execute("""
        SELECT project_id, lottery_id, city, neighborhood
        FROM lotteries
        WHERE signup_end_date <= ? AND lottery_date IS NULL
        ORDER BY signup_end_date DESC
        LIMIT 30
    """, (now,)).fetchall()

    if not rows:
        return

    print(f"Checking {len(rows)} closed lotteries for execution dates...")
    updated_count = 0
    for r in rows:
        pid, lid = r[0], r[1]
        try:
            param = quote(f"?ProjectNumber={pid}&LotteryNumber={lid}&", safe="")
            data = _get(f"{BASE_URL}/api/Invoker?method=LotteryResult&param={param}")
            result = data.get("MyLotteryResult") or {}
            lot_date = result.get("LotteryDate")
            part_count = result.get("ParticipantsCount")
            if lot_date:
                # Update lottery_date and lottery_status
                conn.execute("""
                    UPDATE lotteries
                    SET lottery_date = ?, lottery_status = 'פורסמו תוצאות'
                    WHERE project_id = ? AND lottery_id = ?
                """, (lot_date, pid, lid))
                
                # Update participants_count in the latest snapshot
                if part_count:
                    conn.execute("""
                        UPDATE registration_snapshots
                        SET participants_count = ?
                        WHERE project_id = ? AND lottery_id = ?
                        AND scraped_at = (
                            SELECT MAX(scraped_at)
                            FROM registration_snapshots
                            WHERE project_id = ? AND lottery_id = ?
                        )
                    """, (part_count, pid, lid, pid, lid))
                
                print(f"  Lottery {lid} ({r[2]}): drawn on {lot_date}, participants: {part_count}")
                updated_count += 1
        except Exception as e:
            print(f"  Error checking lottery {lid}: {e}")
    
    print(f"Updated {updated_count} lottery execution dates.")


def main():
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    
    print(f"Fetching open lotteries (status 4) from {BASE_URL} ...")
    items = fetch_lotteries_by_status(4)
    print(f"  Got {len(items)} open lotteries")

    print(f"Fetching recently closed lotteries (status 3) from {BASE_URL} ...")
    closed_items = fetch_lotteries_by_status(3)
    print(f"  Got {len(closed_items)} closed lotteries")
    items.extend(closed_items)

    print(f"Fetching recently drawn lotteries (status 5) from {BASE_URL} ...")
    drawn_items = fetch_lotteries_by_status(5)
    print(f"  Got {len(drawn_items)} drawn lotteries")
    items.extend(drawn_items)

    # De-duplicate by (ProjectNumber, LotteryNumber)
    unique_items = {}
    for item in items:
        key = (int(item["ProjectNumber"]), int(item["LotteryNumber"]))
        unique_items[key] = item
    items = list(unique_items.values())
    print(f"Total unique lotteries fetched: {len(items)}")

    conn = open_db()
    # Get set of already drawn lottery IDs to skip redundant scrapes
    drawn_keys = {
        (row[0], row[1])
        for row in conn.execute("SELECT project_id, lottery_id FROM lotteries WHERE lottery_date IS NOT NULL").fetchall()
    }

    scraped, failed = [], []
    for item in items:
        pid = int(item.get("ProjectNumber"))
        lid = int(item.get("LotteryNumber"))
        if (pid, lid) in drawn_keys:
            continue
        try:
            upsert_lottery(conn, item, None, now)
            scraped.append((pid, lid))
        except Exception as e:
            failed.append({"project": pid, "lottery": lid, "error": str(e)})

    print(f"Scraped/updated {len(scraped)} active or recently closed lotteries.")

    # Query and update drawing dates for recently closed lotteries
    update_completed_lottery_dates(conn, now)

    conn.commit()
    conn.close()

    summary = {
        "scraped_at": now,
        "scraped": len(scraped),
        "failed": len(failed),
        "failures": failed,
        "db": str(DB_PATH),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
