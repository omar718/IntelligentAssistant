
import json
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.gridspec import GridSpec
import os

# ── Load results ──────────────────────────────────────────────────────────────

RESULTS_FILE = os.path.join(os.path.dirname(__file__), "comparison_results.json")

with open(RESULTS_FILE) as f:
    data = json.load(f)

results   = data["results"]
cos_meta  = data["cosine"]
euc_meta  = data["euclidean"]

# ── Shared style ──────────────────────────────────────────────────────────────

COSINE_COLOR     = "#185FA5"
EUCLIDEAN_COLOR  = "#1D9E75"
COSINE_FADE      = "#B5D4F4"
EUCLIDEAN_FADE   = "#9FE1CB"
GRAY_TEXT        = "#5F5E5A"
LIGHT_GRAY       = "#F1EFE8"
BORDER_COLOR     = "#D3D1C7"

plt.rcParams.update({
    "font.family":       "DejaVu Sans",
    "font.size":         11,
    "axes.titlesize":    13,
    "axes.titleweight":  "bold",
    "axes.labelsize":    11,
    "axes.spines.top":   False,
    "axes.spines.right": False,
    "axes.grid":         True,
    "grid.color":        BORDER_COLOR,
    "grid.linewidth":    0.5,
    "grid.alpha":        0.7,
    "figure.dpi":        150,
    "savefig.dpi":       300,
    "savefig.bbox":      "tight",
    "savefig.facecolor": "white",
})

short_labels = [
    r[:32] + "…" if len(r) > 32 else r
    for r in [d["error"] for d in results]
]

# ─────────────────────────────────────────────────────────────────────────────
# Chart 1 — Match rate & average score
# ─────────────────────────────────────────────────────────────────────────────

fig1, axes = plt.subplots(1, 2, figsize=(12, 5))
fig1.suptitle(
    "Cosine vs Euclidean Distance — RAG Error Pattern Matching\n"
    "Intelligent Assistant · PFE 2026",
    fontsize=14, fontweight="bold", y=1.02,
)

# ── Left: match rate ──────────────────────────────────────────────────────────
ax = axes[0]
metrics    = ["Cosine", "Euclidean (L2)"]
match_vals = [cos_meta["match_rate"] * 100, euc_meta["match_rate"] * 100]
colors     = [COSINE_COLOR, EUCLIDEAN_COLOR]

bars = ax.bar(metrics, match_vals, color=colors, width=0.45, zorder=3)
for bar, val in zip(bars, match_vals):
    ax.text(
        bar.get_x() + bar.get_width() / 2,
        bar.get_height() + 1.5,
        f"{val:.0f}%",
        ha="center", va="bottom", fontweight="bold", fontsize=13,
    )

ax.axhline(y=100, color=BORDER_COLOR, linewidth=0.8, linestyle="--")
ax.set_ylim(0, 115)
ax.set_ylabel("Match rate (%)")
ax.set_title("Match rate\n(errors matched above threshold)")
ax.set_facecolor("white")

# Annotate difference
diff = match_vals[0] - match_vals[1]
ax.annotate(
    f"+{diff:.0f}% more matches\nwith cosine",
    xy=(0.5, 62), xycoords="data",
    ha="center", va="bottom",
    fontsize=10, color=COSINE_COLOR, fontweight="bold",
    bbox=dict(boxstyle="round,pad=0.3", facecolor="#E6F1FB", edgecolor=COSINE_COLOR, alpha=0.8),
)

# ── Right: average score ──────────────────────────────────────────────────────
ax = axes[1]
score_vals = [cos_meta["avg_score"], euc_meta["avg_score"]]

bars = ax.bar(metrics, score_vals, color=colors, width=0.45, zorder=3)
for bar, val in zip(bars, score_vals):
    ax.text(
        bar.get_x() + bar.get_width() / 2,
        bar.get_height() + 0.01,
        f"{val:.3f}",
        ha="center", va="bottom", fontweight="bold", fontsize=13,
    )

# Threshold lines
ax.axhline(y=cos_meta["threshold"], color=COSINE_COLOR,
           linewidth=1.2, linestyle="--", alpha=0.6, label=f"Cosine threshold ({cos_meta['threshold']})")
ax.axhline(y=euc_meta["threshold"], color=EUCLIDEAN_COLOR,
           linewidth=1.2, linestyle="--", alpha=0.6, label=f"Euclidean threshold ({euc_meta['threshold']})")

ax.set_ylim(0, 1.0)
ax.set_ylabel("Average similarity score")
ax.set_title("Average similarity score\n(matched errors only)")
ax.legend(fontsize=9, loc="upper right")
ax.set_facecolor("white")

plt.tight_layout()
plt.savefig("chart1_match_rate_and_score.png")
plt.close()
print("✓ chart1_match_rate_and_score.png saved")


# ─────────────────────────────────────────────────────────────────────────────
# Chart 2 — Score distribution per error
# ─────────────────────────────────────────────────────────────────────────────

fig2, ax = plt.subplots(figsize=(14, 6))

n      = len(results)
x      = np.arange(n)
width  = 0.35

cosine_scores    = [d["cosine"]["score"]    for d in results]
euclidean_scores = [d["euclidean"]["score"] for d in results]
cosine_matched   = [d["cosine"]["matched"]   for d in results]
euclidean_matched = [d["euclidean"]["matched"] for d in results]

# Color bars by match status
cosine_colors    = [COSINE_COLOR    if m else COSINE_FADE    for m in cosine_matched]
euclidean_colors = [EUCLIDEAN_COLOR if m else EUCLIDEAN_FADE for m in euclidean_matched]

bars1 = ax.bar(x - width / 2, cosine_scores,    width, color=cosine_colors,    zorder=3, label="Cosine")
bars2 = ax.bar(x + width / 2, euclidean_scores, width, color=euclidean_colors, zorder=3, label="Euclidean (L2)")

# Threshold lines
ax.axhline(y=cos_meta["threshold"], color=COSINE_COLOR,
           linewidth=1.5, linestyle="--", alpha=0.8,
           label=f"Cosine threshold ({cos_meta['threshold']})")
ax.axhline(y=euc_meta["threshold"], color=EUCLIDEAN_COLOR,
           linewidth=1.5, linestyle="--", alpha=0.8,
           label=f"Euclidean threshold ({euc_meta['threshold']})")

# Shade region below cosine threshold
ax.axhspan(0, cos_meta["threshold"], alpha=0.04, color="gray", zorder=0)

# Score labels on top of bars
for bar, score, matched in zip(bars1, cosine_scores, cosine_matched):
    ax.text(
        bar.get_x() + bar.get_width() / 2,
        bar.get_height() + 0.01,
        f"{score:.2f}",
        ha="center", va="bottom", fontsize=8,
        color=COSINE_COLOR if matched else GRAY_TEXT,
        fontweight="bold" if matched else "normal",
    )

for bar, score, matched in zip(bars2, euclidean_scores, euclidean_matched):
    ax.text(
        bar.get_x() + bar.get_width() / 2,
        bar.get_height() + 0.01,
        f"{score:.2f}",
        ha="center", va="bottom", fontsize=8,
        color=EUCLIDEAN_COLOR if matched else GRAY_TEXT,
        fontweight="bold" if matched else "normal",
    )

ax.set_xticks(x)
ax.set_xticklabels(short_labels, rotation=35, ha="right", fontsize=9)
ax.set_ylabel("Similarity score (0–1)")
ax.set_ylim(0, 1.15)
ax.set_title(
    "Score distribution per error — Cosine vs Euclidean\n"
    "Faded bars = below threshold (no match) · Solid bars = matched",
    fontsize=13, fontweight="bold",
)
ax.set_facecolor("white")

# Custom legend
legend_elements = [
    mpatches.Patch(color=COSINE_COLOR,    label="Cosine — matched"),
    mpatches.Patch(color=COSINE_FADE,     label="Cosine — below threshold"),
    mpatches.Patch(color=EUCLIDEAN_COLOR, label="Euclidean — matched"),
    mpatches.Patch(color=EUCLIDEAN_FADE,  label="Euclidean — below threshold"),
    plt.Line2D([0], [0], color=COSINE_COLOR,    linestyle="--", label=f"Cosine threshold ({cos_meta['threshold']})"),
    plt.Line2D([0], [0], color=EUCLIDEAN_COLOR, linestyle="--", label=f"Euclidean threshold ({euc_meta['threshold']})"),
]
ax.legend(handles=legend_elements, fontsize=9, loc="upper right", ncol=2)

plt.tight_layout()
plt.savefig("chart2_score_distribution.png")
plt.close()
print("✓ chart2_score_distribution.png saved")


# ─────────────────────────────────────────────────────────────────────────────
# Chart 3 — Heatmap: match outcome per error per metric
# ─────────────────────────────────────────────────────────────────────────────

fig3, ax = plt.subplots(figsize=(10, 5))

# Build 2×n matrix: rows = [cosine, euclidean], cols = errors
# Value = similarity score (grey out if no match)
matrix = np.array([
    cosine_scores,
    euclidean_scores,
])

# Custom colormap: white → metric color
import matplotlib.colors as mcolors

# Use a blue-green diverging feel
cmap = plt.cm.YlGnBu

im = ax.imshow(matrix, cmap=cmap, aspect="auto", vmin=0, vmax=1)

# Annotate each cell
for row in range(2):
    for col in range(n):
        score   = matrix[row, col]
        matched = cosine_matched[col] if row == 0 else euclidean_matched[col]
        thresh  = cos_meta["threshold"] if row == 0 else euc_meta["threshold"]
        text    = f"{score:.2f}"
        color   = "white" if score > 0.6 else "black"
        weight  = "bold" if matched else "normal"
        ax.text(col, row, text, ha="center", va="center",
                fontsize=10, color=color, fontweight=weight)
        # Red border on failed cells
        if not matched:
            rect = plt.Rectangle(
                (col - 0.5, row - 0.5), 1, 1,
                linewidth=1.5, edgecolor="#E24B4A", facecolor="none",
            )
            ax.add_patch(rect)

ax.set_xticks(range(n))
ax.set_xticklabels(short_labels, rotation=40, ha="right", fontsize=9)
ax.set_yticks([0, 1])
ax.set_yticklabels(["Cosine distance", "Euclidean (L2)"], fontsize=11, fontweight="bold")
ax.set_title(
    "Similarity score heatmap — per error, per metric\n"
    "Bold = matched · Red border = below threshold (no match)",
    fontsize=13, fontweight="bold",
)

cbar = plt.colorbar(im, ax=ax, orientation="vertical", pad=0.02, fraction=0.02)
cbar.set_label("Similarity score", fontsize=10)

ax.set_facecolor("white")
plt.tight_layout()
plt.savefig("chart3_per_error_heatmap.png")
plt.close()
print("✓ chart3_per_error_heatmap.png saved")


# ─────────────────────────────────────────────────────────────────────────────
# Combined figure — all 3 charts in one file
# ─────────────────────────────────────────────────────────────────────────────

fig = plt.figure(figsize=(16, 15))
gs  = GridSpec(3, 2, figure=fig, hspace=0.55, wspace=0.35)

fig.suptitle(
    "RAG Error Pattern Matching — Cosine vs Euclidean Distance\n"
    "Intelligent Assistant · PFE 2026",
    fontsize=16, fontweight="bold", y=0.98,
)

# ── Panel 1a: match rate ──────────────────────────────────────────────────────
ax1a = fig.add_subplot(gs[0, 0])
bars = ax1a.bar(metrics, match_vals, color=colors, width=0.45, zorder=3)
for bar, val in zip(bars, match_vals):
    ax1a.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 1.5,
              f"{val:.0f}%", ha="center", fontweight="bold", fontsize=12)
ax1a.set_ylim(0, 115)
ax1a.set_ylabel("Match rate (%)")
ax1a.set_title("Chart 1a — Match rate")
ax1a.set_facecolor("white")
ax1a.annotate(
    f"+{match_vals[0]-match_vals[1]:.0f}% more\nwith cosine",
    xy=(0.5, 58), ha="center", fontsize=9, color=COSINE_COLOR, fontweight="bold",
    bbox=dict(boxstyle="round,pad=0.3", facecolor="#E6F1FB", edgecolor=COSINE_COLOR, alpha=0.8),
)

# ── Panel 1b: average score ───────────────────────────────────────────────────
ax1b = fig.add_subplot(gs[0, 1])
bars = ax1b.bar(metrics, score_vals, color=colors, width=0.45, zorder=3)
for bar, val in zip(bars, score_vals):
    ax1b.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.01,
              f"{val:.3f}", ha="center", fontweight="bold", fontsize=12)
ax1b.axhline(y=cos_meta["threshold"], color=COSINE_COLOR, linewidth=1.2,
             linestyle="--", alpha=0.7, label=f"Cosine threshold ({cos_meta['threshold']})")
ax1b.axhline(y=euc_meta["threshold"], color=EUCLIDEAN_COLOR, linewidth=1.2,
             linestyle="--", alpha=0.7, label=f"Euclidean threshold ({euc_meta['threshold']})")
ax1b.set_ylim(0, 1.0)
ax1b.set_ylabel("Avg similarity score")
ax1b.set_title("Chart 1b — Average score")
ax1b.legend(fontsize=8)
ax1b.set_facecolor("white")

# ── Panel 2: score distribution ──────────────────────────────────────────────
ax2 = fig.add_subplot(gs[1, :])
x   = np.arange(n)
b1  = ax2.bar(x - width/2, cosine_scores, width, color=cosine_colors, zorder=3)
b2  = ax2.bar(x + width/2, euclidean_scores, width, color=euclidean_colors, zorder=3)
ax2.axhline(y=cos_meta["threshold"], color=COSINE_COLOR, linewidth=1.4,
            linestyle="--", alpha=0.8, label=f"Cosine threshold ({cos_meta['threshold']})")
ax2.axhline(y=euc_meta["threshold"], color=EUCLIDEAN_COLOR, linewidth=1.4,
            linestyle="--", alpha=0.8, label=f"Euclidean threshold ({euc_meta['threshold']})")
ax2.axhspan(0, min(cos_meta["threshold"], euc_meta["threshold"]), alpha=0.04, color="gray")
for bar, score in zip(b1, cosine_scores):
    ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.01,
             f"{score:.2f}", ha="center", fontsize=7.5, color=COSINE_COLOR)
for bar, score in zip(b2, euclidean_scores):
    ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.01,
             f"{score:.2f}", ha="center", fontsize=7.5, color=EUCLIDEAN_COLOR)
ax2.set_xticks(x)
ax2.set_xticklabels(short_labels, rotation=30, ha="right", fontsize=8.5)
ax2.set_ylabel("Similarity score")
ax2.set_ylim(0, 1.15)
ax2.set_title("Chart 2 — Score distribution per error (faded = below threshold)")
ax2.legend(handles=[
    mpatches.Patch(color=COSINE_COLOR,    label="Cosine matched"),
    mpatches.Patch(color=COSINE_FADE,     label="Cosine no match"),
    mpatches.Patch(color=EUCLIDEAN_COLOR, label="Euclidean matched"),
    mpatches.Patch(color=EUCLIDEAN_FADE,  label="Euclidean no match"),
    plt.Line2D([0],[0], color=COSINE_COLOR,    linestyle="--", label=f"Cosine threshold"),
    plt.Line2D([0],[0], color=EUCLIDEAN_COLOR, linestyle="--", label=f"Euclidean threshold"),
], fontsize=8, ncol=3, loc="upper right")
ax2.set_facecolor("white")

# ── Panel 3: heatmap ──────────────────────────────────────────────────────────
ax3 = fig.add_subplot(gs[2, :])
im  = ax3.imshow(matrix, cmap=plt.cm.YlGnBu, aspect="auto", vmin=0, vmax=1)
for row in range(2):
    for col in range(n):
        score   = matrix[row, col]
        matched = cosine_matched[col] if row == 0 else euclidean_matched[col]
        color   = "white" if score > 0.6 else "black"
        ax3.text(col, row, f"{score:.2f}", ha="center", va="center",
                 fontsize=10, color=color, fontweight="bold" if matched else "normal")
        if not matched:
            ax3.add_patch(plt.Rectangle(
                (col - 0.5, row - 0.5), 1, 1,
                linewidth=2, edgecolor="#E24B4A", facecolor="none",
            ))
ax3.set_xticks(range(n))
ax3.set_xticklabels(short_labels, rotation=35, ha="right", fontsize=8.5)
ax3.set_yticks([0, 1])
ax3.set_yticklabels(["Cosine", "Euclidean (L2)"], fontsize=11, fontweight="bold")
ax3.set_title("Chart 3 — Heatmap (bold = matched · red border = no match)")
plt.colorbar(im, ax=ax3, orientation="vertical", pad=0.01,
             fraction=0.015, label="Similarity score")
ax3.set_facecolor("white")

plt.savefig("all_charts_combined.png")
plt.close()
print("✓ all_charts_combined.png saved")
print("\nAll charts generated successfully.")
print("Replace comparison_results.json with your real DB output to get actual numbers.")