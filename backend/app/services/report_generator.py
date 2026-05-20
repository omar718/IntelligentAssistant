"""
app/services/report_generator.py

Generates a styled PDF "Stack Report" after a successful project installation.
Called by the Celery task after launch_and_verify() succeeds.
Saves the PDF to Cloudflare R2 and records the storage key in installation_history.
"""

import io
import uuid
from datetime import datetime, timezone
from typing import Optional

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor, white, black
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT

# ── Brand colours ────────────────────────────────────────────────────────────
DARK_NAVY   = HexColor("#0D1B2A")
TEAL        = HexColor("#00B4A6")
TEAL_LIGHT  = HexColor("#E6F7F6")
AMBER       = HexColor("#F59E0B")
GREEN       = HexColor("#10B981")
RED         = HexColor("#EF4444")
GRAY_100    = HexColor("#F3F4F6")
GRAY_600    = HexColor("#4B5563")
GRAY_800    = HexColor("#1F2937")
PAGE_BG     = HexColor("#FFFFFF")

# ── Page geometry ─────────────────────────────────────────────────────────────
PAGE_W, PAGE_H = A4
MARGIN = 18 * mm


# ─────────────────────────────────────────────────────────────────────────────
#  Style helpers
# ─────────────────────────────────────────────────────────────────────────────

def _styles():
    base = getSampleStyleSheet()
    custom = {}

    custom["h1"] = ParagraphStyle(
        "h1", parent=base["Heading1"],
        fontSize=22, textColor=white, leading=28,
        spaceAfter=0, spaceBefore=0,
    )
    custom["h2"] = ParagraphStyle(
        "h2", parent=base["Heading2"],
        fontSize=13, textColor=DARK_NAVY, leading=18,
        spaceBefore=8, spaceAfter=4, fontName="Helvetica-Bold",
    )
    custom["h3"] = ParagraphStyle(
        "h3", parent=base["Heading3"],
        fontSize=10, textColor=GRAY_800, leading=14,
        spaceBefore=6, spaceAfter=2, fontName="Helvetica-Bold",
    )
    custom["body"] = ParagraphStyle(
        "body", parent=base["Normal"],
        fontSize=9.5, textColor=GRAY_800, leading=14,
    )
    custom["small"] = ParagraphStyle(
        "small", parent=base["Normal"],
        fontSize=8, textColor=GRAY_600, leading=11,
    )
    custom["mono"] = ParagraphStyle(
        "mono", parent=base["Code"],
        fontSize=8.5, textColor=DARK_NAVY, leading=12,
        backColor=GRAY_100, borderPadding=(3, 6, 3, 6),
    )
    custom["badge_ok"] = ParagraphStyle(
        "badge_ok", parent=base["Normal"],
        fontSize=8, textColor=white, backColor=GREEN,
        borderPadding=(2, 6, 2, 6), alignment=TA_CENTER,
    )
    custom["badge_warn"] = ParagraphStyle(
        "badge_warn", parent=base["Normal"],
        fontSize=8, textColor=white, backColor=AMBER,
        borderPadding=(2, 6, 2, 6), alignment=TA_CENTER,
    )
    custom["footer"] = ParagraphStyle(
        "footer", parent=base["Normal"],
        fontSize=7.5, textColor=GRAY_600, alignment=TA_CENTER,
    )
    return custom


# ─────────────────────────────────────────────────────────────────────────────
#  Section builders
# ─────────────────────────────────────────────────────────────────────────────

def _header_block(s, project_name: str, generated_at: str, user_email: str):
    """Dark-navy header banner with project name + meta."""
    usable = PAGE_W - 2 * MARGIN

    # Inner table: left = title/subtitle, right = metadata
    left_cell = [
        Paragraph(f"Stack Report", ParagraphStyle(
            "label", fontSize=9, textColor=TEAL, fontName="Helvetica-Bold",
            spaceBefore=0, spaceAfter=2,
        )),
        Paragraph(project_name, s["h1"]),
        Spacer(1, 4),
        Paragraph("Intelligent Assistant", ParagraphStyle(
            "sub", fontSize=9, textColor=HexColor("#94A3B8"), leading=12,
        )),
    ]
    right_cell = [
        Paragraph(f"<b>Generated</b>", ParagraphStyle(
            "rm", fontSize=8, textColor=HexColor("#94A3B8"), alignment=TA_RIGHT,
        )),
        Paragraph(generated_at, ParagraphStyle(
            "rv", fontSize=8.5, textColor=white, alignment=TA_RIGHT,
        )),
        Spacer(1, 6),
        Paragraph(f"<b>User</b>", ParagraphStyle(
            "rm2", fontSize=8, textColor=HexColor("#94A3B8"), alignment=TA_RIGHT,
        )),
        Paragraph(user_email, ParagraphStyle(
            "rv2", fontSize=8.5, textColor=white, alignment=TA_RIGHT,
        )),
    ]

    inner = Table(
        [[left_cell, right_cell]],
        colWidths=[usable * 0.65, usable * 0.35],
    )
    inner.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (0, 0), (-1, -1), DARK_NAVY),
        ("TOPPADDING", (0, 0), (-1, -1), 14),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
        ("LEFTPADDING", (0, 0), (0, -1), 16),
        ("RIGHTPADDING", (1, 0), (1, -1), 16),
    ]))
    return [inner, Spacer(1, 10)]


def _section_title(s, text: str):
    return [
        HRFlowable(width="100%", thickness=1, color=TEAL, spaceAfter=4),
        Paragraph(text.upper(), s["h2"]),
    ]


def _kv_table(rows: list[tuple[str, str]], col_widths=None):
    """Two-column key/value table with alternating row shading."""
    usable = PAGE_W - 2 * MARGIN
    if col_widths is None:
        col_widths = [usable * 0.32, usable * 0.68]

    s = _styles()
    data = []
    for k, v in rows:
        data.append([
            Paragraph(f"<b>{k}</b>", s["small"]),
            Paragraph(str(v), s["body"]),
        ])

    tbl = Table(data, colWidths=col_widths, repeatRows=0)
    style = [
        ("BACKGROUND", (0, 0), (-1, -1), PAGE_BG),
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [GRAY_100, PAGE_BG]),
        ("GRID", (0, 0), (-1, -1), 0.3, HexColor("#E5E7EB")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]
    tbl.setStyle(TableStyle(style))
    return [tbl, Spacer(1, 8)]


def _dependency_table(deps: list[dict]):
    """
    deps: [{"name": "express", "version": "4.18.2", "status": "installed"}]
    """
    s = _styles()
    usable = PAGE_W - 2 * MARGIN
    header = [
        Paragraph("<b>Package</b>", s["small"]),
        Paragraph("<b>Version</b>", s["small"]),
        Paragraph("<b>Status</b>", s["small"]),
    ]
    rows = [header]
    for d in deps:
        status = d.get("status", "installed")
        badge_style = ParagraphStyle(
            "bs", fontSize=8, textColor=white,
            backColor=GREEN if status == "installed" else AMBER,
            alignment=TA_CENTER, leading=10,
        )
        rows.append([
            Paragraph(d["name"], s["body"]),
            Paragraph(d.get("version", "latest"), s["mono"]),
            Paragraph(status, badge_style),
        ])

    tbl = Table(rows, colWidths=[usable * 0.50, usable * 0.25, usable * 0.25])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), DARK_NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [GRAY_100, PAGE_BG]),
        ("GRID", (0, 0), (-1, -1), 0.3, HexColor("#E5E7EB")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8.5),
    ]))
    return [tbl, Spacer(1, 8)]


def _health_table(checks: list[dict]):
    """
    checks: [{"name": "process", "detail": "PID 1234 running", "passed": True}]
    """
    s = _styles()
    usable = PAGE_W - 2 * MARGIN
    rows = [[
        Paragraph("<b>Check</b>", s["small"]),
        Paragraph("<b>Detail</b>", s["small"]),
        Paragraph("<b>Result</b>", s["small"]),
    ]]
    for c in checks:
        passed = c.get("passed", True)
        badge_style = ParagraphStyle(
            "bs2", fontSize=8, textColor=white,
            backColor=GREEN if passed else RED,
            alignment=TA_CENTER, leading=10,
        )
        rows.append([
            Paragraph(c["name"].title(), s["body"]),
            Paragraph(c.get("detail", ""), s["small"]),
            Paragraph("PASS" if passed else "FAIL", badge_style),
        ])

    tbl = Table(rows, colWidths=[usable * 0.25, usable * 0.55, usable * 0.20])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), DARK_NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [GRAY_100, PAGE_BG]),
        ("GRID", (0, 0), (-1, -1), 0.3, HexColor("#E5E7EB")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8.5),
    ]))
    return [tbl, Spacer(1, 8)]


def _installation_steps_table(steps: list[dict]):
    """
    steps: [{"order": 1, "action": "install_packages", "status": "success", "duration_s": 12}]
    """
    s = _styles()
    usable = PAGE_W - 2 * MARGIN
    rows = [[
        Paragraph("<b>#</b>", s["small"]),
        Paragraph("<b>Action</b>", s["small"]),
        Paragraph("<b>Status</b>", s["small"]),
        Paragraph("<b>Duration</b>", s["small"]),
    ]]
    for step in steps:
        status = step.get("status", "success")
        badge_style = ParagraphStyle(
            "bss", fontSize=8, textColor=white,
            backColor=GREEN if status == "success" else RED,
            alignment=TA_CENTER, leading=10,
        )
        dur = step.get("duration_s")
        dur_str = f"{dur}s" if dur is not None else "—"
        rows.append([
            Paragraph(str(step.get("order", "")), s["body"]),
            Paragraph(step.get("action", "").replace("_", " ").title(), s["body"]),
            Paragraph(status.upper(), badge_style),
            Paragraph(dur_str, s["small"]),
        ])

    tbl = Table(rows, colWidths=[usable * 0.08, usable * 0.52, usable * 0.22, usable * 0.18])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), DARK_NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [GRAY_100, PAGE_BG]),
        ("GRID", (0, 0), (-1, -1), 0.3, HexColor("#E5E7EB")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8.5),
    ]))
    return [tbl, Spacer(1, 8)]


def _footer_canvas(canvas_obj, doc):
    """Page number footer on every page."""
    canvas_obj.saveState()
    canvas_obj.setFont("Helvetica", 7.5)
    canvas_obj.setFillColor(GRAY_600)
    text = f"Intelligent Assistant · Stack Report · Page {doc.page}"
    canvas_obj.drawCentredString(PAGE_W / 2, 10 * mm, text)
    # Teal bottom rule
    canvas_obj.setStrokeColor(TEAL)
    canvas_obj.setLineWidth(1.5)
    canvas_obj.line(MARGIN, 14 * mm, PAGE_W - MARGIN, 14 * mm)
    canvas_obj.restoreState()


# ─────────────────────────────────────────────────────────────────────────────
#  Public API
# ─────────────────────────────────────────────────────────────────────────────

def generate_stack_report(report_data: dict) -> bytes:
    """
    Build the PDF and return raw bytes.

    report_data schema
    ------------------
    {
      "project_name": "my-web-app",
      "project_id":   "proj_abc123",
      "user_email":   "omar@example.com",
      "generated_at": "2026-05-12T14:30:00Z",   # ISO-8601, optional

      "stack": {
        "type":          "Node.js",
        "framework":     "Express 4.18",
        "language":      "JavaScript / TypeScript",
        "package_manager": "npm",
        "node_version":  "20.11.0",
        "entry_point":   "npm run start",
        "port":          3000,
        "resolution":    "local"          # local | venv | docker
      },

      "environment": {          # key-value env vars written to .env
        "NODE_ENV":   "production",
        "DATABASE_URL": "postgres://...",
        ...
      },

      "dependencies": [         # top-level packages
        {"name": "express", "version": "4.18.2", "status": "installed"},
        ...
      ],

      "installation_steps": [
        {"order": 1, "action": "nvm_setup",       "status": "success", "duration_s": 3},
        {"order": 2, "action": "install_packages", "status": "success", "duration_s": 42},
        {"order": 3, "action": "env_setup",        "status": "success", "duration_s": 1},
        {"order": 4, "action": "launch",           "status": "success", "duration_s": 2},
      ],

      "health_checks": [
        {"name": "process", "detail": "PID 9182 running",           "passed": True},
        {"name": "port",    "detail": "Port 3000 accessible",       "passed": True},
        {"name": "http",    "detail": "HTTP 200 on /",              "passed": True},
        {"name": "logs",    "detail": "No errors in last 50 lines", "passed": True},
      ],

      "conflicts_resolved": [   # optional
        {"component": "node", "required": "20.x", "actual": "18.x", "strategy": "nvm install 20"}
      ],

      "notes": "Optional free-text notes from the AI layer."
    }
    """
    s = _styles()

    now_str = report_data.get(
        "generated_at",
        datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    )

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=22 * mm,
        title=f"Stack Report – {report_data['project_name']}",
        author="Intelligent Assistant",
    )

    story = []

    # ── Header ────────────────────────────────────────────────────────────────
    story += _header_block(s, report_data["project_name"], now_str,
                            report_data.get("user_email", "authenticated user"))
    story.append(Spacer(1, 6))

    # ── Summary strip (3-column KPIs) ─────────────────────────────────────────
    stack = report_data.get("stack", {})
    health = report_data.get("health_checks", [])
    deps   = report_data.get("dependencies", [])
    steps  = report_data.get("installation_steps", [])

    total_checks  = len(health)
    passed_checks = sum(1 for c in health if c.get("passed"))
    total_deps    = len(deps)
    total_dur     = sum(st.get("duration_s", 0) for st in steps if st.get("duration_s"))

    kpi_style_val = ParagraphStyle(
        "kpiv", fontSize=20, textColor=TEAL,
        fontName="Helvetica-Bold", alignment=TA_CENTER, leading=24,
    )
    kpi_style_lbl = ParagraphStyle(
        "kpil", fontSize=8, textColor=GRAY_600,
        alignment=TA_CENTER, leading=10,
    )

    def _kpi_cell(val, lbl):
        return [Paragraph(str(val), kpi_style_val), Paragraph(lbl, kpi_style_lbl)]

    kpi_table = Table(
        [[
            _kpi_cell(f"{passed_checks}/{total_checks}", "Health Checks Passed"),
            _kpi_cell(total_deps, "Dependencies Installed"),
            _kpi_cell(f"{total_dur}s", "Total Install Time"),
            _kpi_cell(stack.get("port", "—"), "Running on Port"),
        ]],
        colWidths=[(PAGE_W - 2 * MARGIN) / 4] * 4,
    )
    kpi_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), TEAL_LIGHT),
        ("BOX", (0, 0), (-1, -1), 0.5, TEAL),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, HexColor("#B2E5E2")),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story += [kpi_table, Spacer(1, 14)]

    # ── 1. Project & Stack Info ───────────────────────────────────────────────
    story += _section_title(s, "1 · Project & Stack")
    story += _kv_table([
        ("Project ID",       report_data.get("project_id", "—")),
        ("Type",             stack.get("type", "—")),
        ("Framework",        stack.get("framework", "—")),
        ("Language",         stack.get("language", "—")),
        ("Package Manager",  stack.get("package_manager", "—")),
        ("Runtime Version",  stack.get("node_version") or stack.get("python_version") or "—"),
        ("Entry Point",      stack.get("entry_point", "—")),
        ("Port",             str(stack.get("port", "—"))),
        ("Install Strategy", stack.get("resolution", "local")),
    ])

    # ── 2. Environment Variables ──────────────────────────────────────────────
    env = report_data.get("environment", {})
    if env:
        story += _section_title(s, "2 · Environment Variables (.env)")
        masked = {k: ("*" * 8 if any(x in k.upper() for x in
                       ["SECRET", "KEY", "PASSWORD", "TOKEN", "PASS"]) else v)
                  for k, v in env.items()}
        story += _kv_table(list(masked.items()))

    # ── 3. Dependencies ───────────────────────────────────────────────────────
    if deps:
        story += _section_title(s, "3 · Dependencies")
        story += _dependency_table(deps)

    # ── 4. Installation Steps ─────────────────────────────────────────────────
    if steps:
        story += _section_title(s, "4 · Installation Steps")
        story += _installation_steps_table(steps)

    # ── 5. Health Checks ─────────────────────────────────────────────────────
    if health:
        story += _section_title(s, "5 · Health Checks")
        story += _health_table(health)

    # ── 6. Conflicts Resolved ─────────────────────────────────────────────────
    conflicts = report_data.get("conflicts_resolved", [])
    if conflicts:
        story += _section_title(s, "6 · Conflicts Resolved")
        story += _kv_table([
            (f"{c['component']} conflict",
             f"Required {c['required']}, found {c['actual']} → {c['strategy']}")
            for c in conflicts
        ])

    # ── 7. AI Notes ───────────────────────────────────────────────────────────
    notes = report_data.get("notes", "")
    if notes:
        story += _section_title(s,"")
        story.append(Paragraph(notes, s["body"]))
        story.append(Spacer(1, 8))

    doc.build(story, onFirstPage=_footer_canvas, onLaterPages=_footer_canvas)
    return buf.getvalue()