import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";

export function ReportHistory({ projectId }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const { token } = useAuth();

  useEffect(() => {
    fetch(`/api/projects/${projectId}/report/history`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((data) => setReports(data.reports || []))
      .catch((err) => console.error("Error fetching reports:", err))
      .finally(() => setLoading(false));
  }, [projectId, token]);

  const downloadReport = async (reportId, createdAt) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/report/${reportId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `stack-report-${projectId}-${createdAt.slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Download failed:", err);
    }
  };

  if (loading) return <p className="text-gray-500 text-sm">Loading reports...</p>;
  if (!reports.length) return <p className="text-gray-500 text-sm">No reports generated yet.</p>;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
        Stack Reports
      </h3>
      {reports.map((report) => (
        <div
          key={report.id}
          className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200"
        >
          <div>
            <p className="text-sm font-medium text-gray-800">
              Report #{report.id}
            </p>
            <p className="text-xs text-gray-500">
              {new Date(report.created_at).toLocaleString()}
            </p>
          </div>
          <button
            onClick={() => downloadReport(report.id, report.created_at)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-white border border-teal-500 text-teal-600 rounded-md hover:bg-teal-50 transition-colors"
          >
            📥 Download
          </button>
        </div>
      ))}
    </div>
  );
}