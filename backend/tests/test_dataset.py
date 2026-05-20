import csv
import os
from datetime import datetime

CSV_FILE = "test_dataset.csv"

FIELDNAMES = [
    "project_name",
    "tech_stack",
    "phase",
    "error_type",
    "error_message",
    "resolution",
    "resolved",
    "tested_on",
]

PHASES = ["env_detection", "package_install", "config_gen", "launch", "health_check"]


def init_csv():
    """Create the CSV with headers if it doesn't exist."""
    if not os.path.exists(CSV_FILE):
        with open(CSV_FILE, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
            writer.writeheader()
        print(f"Created {CSV_FILE}")
    else:
        print(f"{CSV_FILE} already exists — appending.")


def add_entry(
    project_name: str,
    tech_stack: str,
    phase: str,
    error_type: str,
    error_message: str,
    resolution: str = "",
    resolved: bool = False,
):
    """Append a single error entry to the CSV."""
    with open(CSV_FILE, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writerow({
            "project_name": project_name,
            "tech_stack": tech_stack,
            "phase": phase,
            "error_type": error_type,
            "error_message": error_message,
            "resolution": resolution,
            "resolved": resolved,
            "tested_on": datetime.now().strftime("%Y-%m-%d"),
        })
    print(f"Added entry: {project_name} — {error_type}")


def list_entries():
    """Print all entries in a readable table."""
    if not os.path.exists(CSV_FILE):
        print("No dataset file found. Run init_csv() first.")
        return
    with open(CSV_FILE, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    if not rows:
        print("No entries yet.")
        return
    print(f"\n{'#':<4} {'Project':<25} {'Phase':<18} {'Error Type':<25} {'Resolved'}")
    print("-" * 90)
    for i, row in enumerate(rows, 1):
        print(f"{i:<4} {row['project_name']:<25} {row['phase']:<18} {row['error_type']:<25} {row['resolved']}")
    print(f"\nTotal: {len(rows)} entries\n")


def mark_resolved(index: int, resolution: str):
    """Mark an entry as resolved by its 1-based index."""
    if not os.path.exists(CSV_FILE):
        print("No dataset found.")
        return
    with open(CSV_FILE, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if index < 1 or index > len(rows):
        print(f"Index {index} out of range.")
        return
    rows[index - 1]["resolved"] = True
    rows[index - 1]["resolution"] = resolution
    with open(CSV_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Marked entry #{index} as resolved.")


def delete_entry(index: int):
    with open(CSV_FILE, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    removed = rows.pop(index - 1)
    with open(CSV_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Deleted: {removed['project_name']} — {removed['error_type']}")

    
def export_summary():
    """Print a summary grouped by error_type."""
    if not os.path.exists(CSV_FILE):
        print("No dataset found.")
        return
    with open(CSV_FILE, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    from collections import Counter
    types = Counter(r["error_type"] for r in rows)
    phases = Counter(r["phase"] for r in rows)
    resolved = sum(1 for r in rows if r["resolved"] in ("True", "true", "1"))
    print("\n=== Dataset Summary ===")
    print(f"Total errors: {len(rows)}  |  Resolved: {resolved}  |  Unresolved: {len(rows) - resolved}")
    print("\nBy error type:")
    for t, count in types.most_common():
        print(f"  {count:>3}x  {t}")
    print("\nBy phase:")
    for p, count in phases.most_common():
        print(f"  {count:>3}x  {p}")


# ── Seed with known errors from project history ──────────────────────────────

if __name__ == "__main__":
    init_csv()
    list_entries()
    export_summary()