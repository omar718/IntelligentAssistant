import { useState, useEffect, useMemo } from 'react'
import { jsPDF } from 'jspdf'
import { userApi } from '../api/client'
import TechBadge from './TechBadge'
import '../styles/ProjectsList.css'

const PINNED_PROJECTS_STORAGE_KEY = 'pinned_project_ids'

// ── Helpers ────────────────────────────────────────────────────────────────────
function parseBackendDate(value) {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value !== 'string') return new Date(value)

  const hasTimezone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
  const normalized = hasTimezone ? value : `${value}Z`
  return new Date(normalized)
}

function formatDate(iso) {
  const date = parseBackendDate(iso)
  if (!date || Number.isNaN(date.getTime())) return 'N/A'

  return date.toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

function normalizeRepositoryUrl(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null

  // Convert SSH-style GitHub URL to a browser-openable https URL.
  const sshMatch = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`
  }

  if (/^https?:\/\//i.test(value)) {
    return value
  }

  if (/^github\.com\//i.test(value)) {
    return `https://${value}`
  }

  return null
}

function resolveRepositoryUrl(project) {
  const metadata = project?.metadata && typeof project.metadata === 'object' ? project.metadata : {}
  const candidates = [
    project?.repository_url,
    project?.source_url,
    project?.git_url,
    project?.url,
    metadata?.source_url,
    metadata?.repository_url,
    metadata?.git_url,
    metadata?.url,
    metadata?.source?.url,
  ]

  for (const candidate of candidates) {
    const normalized = normalizeRepositoryUrl(candidate)
    if (normalized) return normalized
  }

  return null
}

function handleDownload(project) {
  const doc = new jsPDF()
  const pageWidth = doc.internal.pageSize.getWidth()
  const maxTextWidth = pageWidth - 28

  let y = 20
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text(`Project Report - ${project.name}`, 14, y)

  y += 10
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  doc.text(`Generated: ${new Date().toLocaleString()}`, 14, y)

  y += 14
  const sections = [
    ['Type',       project.type    || 'N/A'],
    ['Status',     project.status  || 'N/A'],
    ['Port',       project.port    ? String(project.port) : 'N/A'],
    ['Created at', project.created_at ? formatDate(project.created_at) : 'N/A'],
  ]

  sections.forEach(([label, value]) => {
    const content = `${label}: ${value}`
    const lines = doc.splitTextToSize(content, maxTextWidth)

    if (y + lines.length * 7 > 285) {
      doc.addPage()
      y = 20
    }

    doc.text(lines, 14, y)
    y += lines.length * 7 + 2
  })

  doc.save(`${project.name}-report.pdf`)
}

// ── Project card ───────────────────────────────────────────────────────────────
function ProjectCard({ project, onDeleteRequest, isPinned, onTogglePin }) {
  const [open, setOpen] = useState(false)
  const repositoryUrl = resolveRepositoryUrl(project)

  return (
    <div className={`project-card ${open ? 'project-card--open' : ''}`}>
      {/* ── Top row ── */}
      <div className="project-card-top">
        <div className="project-card-left">
          <div className="project-card-name-row">
            <svg viewBox="0 0 24 24" fill="currentColor" className="project-card-gh-icon">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.79-.26.79-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 016.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.19.7.8.58C20.57 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            {repositoryUrl ? (
              <a
                className="project-card-name project-card-name-link"
                href={repositoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open GitHub repository"
              >
                {project.name}
              </a>
            ) : (
              <span className="project-card-name" title="Repository URL unavailable for this project">
                {project.name}
              </span>
            )}
            <button
              className={`pin-btn ${isPinned ? 'pin-btn--active' : ''}`}
              onClick={() => onTogglePin(project.id)}
              title={isPinned ? 'Unpin project' : 'Pin project'}
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 9V4l1-1V2H7v1l1 1v5l-2 2v1h5v8h2v-8h5v-1z"/>
              </svg>
              {isPinned ? 'Pinned' : 'Pin'}
            </button>
          </div>
          {repositoryUrl && (
            <a
              className="project-card-url"
              href={repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {repositoryUrl}
            </a>
          )}
        </div>

        <div className="project-card-right">
          <span className="project-card-date">
            <svg viewBox="0 0 24 24" fill="currentColor" className="date-clock-icon">
              <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/>
            </svg>
            Created at {project.created_at ? formatDate(project.created_at) : '—'}
          </span>
          <div className="project-card-actions">
            <button
              className="project-action-btn download-btn"
              title="Download report"
              onClick={() => handleDownload(project)}
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zm-14 9v2h14v-2H5z"/>
              </svg>
              Download
            </button>
            <button
              className={`project-action-btn more-btn ${open ? 'more-btn--active' : ''}`}
              onClick={() => setOpen(v => !v)}
            >
              More info
              <svg viewBox="0 0 24 24" fill="currentColor" className={`more-chevron ${open ? 'open' : ''}`}>
                <path d="M7 10l5 5 5-5z"/>
              </svg>
            </button>
            <button
              className="project-action-btn delete-btn"
              title="Delete project"
              onClick={() => onDeleteRequest(project)}
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── More info dropdown ── */}
      {open && (
        <div className="project-more-info">
          <div className="more-info-grid">
            {project.type && (
              <div className="more-info-row">
                <span className="more-info-label">Runtime</span>
                <TechBadge name={project.type} />
              </div>
            )}
            {project.status && (
              <div className="more-info-row">
                <span className="more-info-label">Status</span>
                <span className="more-info-value">{project.status}</span>
              </div>
            )}
            {project.port ? (
              <div className="more-info-row">
                <span className="more-info-label">Port</span>
                <span className="more-info-value">{project.port}</span>
              </div>
            ) : null}
            {!project.type && !project.status && (
              <p className="more-info-pending">
                Stack details coming in the next update.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Delete Confirm Modal ───────────────────────────────────────────────────────
function DeleteConfirmModal({ project, onCancel, onConfirm }) {
  return (
    <div className="delete-modal-overlay" onClick={onCancel}>
      <div className="delete-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="delete-modal-icon">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
          </svg>
        </div>
        <h2 className="delete-modal-title">Delete project?</h2>
        <p className="delete-modal-message">
          Are you sure you want to delete <strong>{project.name}</strong>?<br/>
          This action cannot be undone.
        </p>
        <div className="delete-modal-actions">
          <button className="delete-modal-btn cancel" onClick={onCancel}>Cancel</button>
          <button className="delete-modal-btn confirm" onClick={() => onConfirm(project.id)}>Delete</button>
        </div>
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────
function ProjectsList({ onBack }) {
  const [projects, setProjects] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [pinnedProjectIds, setPinnedProjectIds] = useState(() => {
    try {
      const raw = localStorage.getItem(PINNED_PROJECTS_STORAGE_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [projectToDelete, setProjectToDelete] = useState(null)

  // Fetch real projects from the backend on mount
  useEffect(() => {
    userApi.getMyProjects()
      .then(data => setProjects(data.items || []))
      .catch(() => setError('Could not load projects. Please try again.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    localStorage.setItem(PINNED_PROJECTS_STORAGE_KEY, JSON.stringify(pinnedProjectIds))
  }, [pinnedProjectIds])

  const visibleProjects = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    const filtered = term
      ? projects.filter((project) => project.name.toLowerCase().includes(term))
      : projects

    return [...filtered].sort((a, b) => {
      const aPinned = pinnedProjectIds.includes(a.id)
      const bPinned = pinnedProjectIds.includes(b.id)

      if (aPinned !== bPinned) {
        return aPinned ? -1 : 1
      }

      const aDate = parseBackendDate(a.created_at)?.getTime() ?? 0
      const bDate = parseBackendDate(b.created_at)?.getTime() ?? 0
      return bDate - aDate
    })
  }, [projects, searchTerm, pinnedProjectIds])

  const handleTogglePin = (projectId) => {
    setPinnedProjectIds((prev) => (
      prev.includes(projectId)
        ? prev.filter((id) => id !== projectId)
        : [...prev, projectId]
    ))
  }

  const handleDeleteRequest = (project) => {
    setProjectToDelete(project)
  }

  const handleDeleteConfirm = (id) => {
    // Remove from UI immediately
    // TODO: call delete API endpoint once backend adds it
    setProjects(prev => prev.filter(p => p.id !== id))
    setPinnedProjectIds(prev => prev.filter(pinnedId => pinnedId !== id))
    setProjectToDelete(null)
  }

  return (
    <div className="projects-container">
      <header className="projects-header">
        <button className="back-button" onClick={onBack} title="Back">
          <svg viewBox="0 0 24 24" fill="currentColor" className="back-icon">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
          </svg>
          Back
        </button>

        <div className="projects-logo">
          <svg className="logo-icon-svg" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="50" cy="50" r="48" fill="none" stroke="#fff" strokeWidth="2"/>
            <rect x="25" y="20" width="50" height="35" rx="2" fill="none" stroke="#fff" strokeWidth="2"/>
            <rect x="28" y="23" width="44" height="29" fill="none" stroke="#fff" strokeWidth="1.5"/>
            <circle cx="33" cy="28" r="2.5" fill="#fff"/>
            <circle cx="33" cy="33" r="2.5" fill="#fff"/>
            <circle cx="33" cy="38" r="2.5" fill="#fff"/>
            <line x1="36" y1="28" x2="44" y2="28" stroke="#fff" strokeWidth="1.5"/>
            <line x1="36" y1="33" x2="44" y2="33" stroke="#fff" strokeWidth="1.5"/>
            <line x1="36" y1="38" x2="44" y2="38" stroke="#fff" strokeWidth="1.5"/>
            <rect x="46" y="35" width="3" height="10" fill="#fff"/>
            <rect x="51" y="31" width="3" height="14" fill="#fff"/>
            <rect x="56" y="27" width="3" height="18" fill="#fff"/>
            <rect x="61" y="24" width="3" height="21" fill="#fff"/>
            <path d="M20 58C20 58 20 60 22 60H78C80 60 80 58 80 58M28 60H72C72 63 70 65 67 65H33C30 65 28 63 28 60" fill="none" stroke="#fff" strokeWidth="2"/>
          </svg>
        </div>
      </header>

      <main className="projects-main">
        <div className="projects-title-row">
          <div className="projects-title-block">
            <h1 className="projects-title">Projects History</h1>
            {!loading && <span className="projects-count">{visibleProjects.length} project{visibleProjects.length !== 1 ? 's' : ''}</span>}
          </div>
          <div className="projects-search-wrap">
            <svg viewBox="0 0 24 24" fill="none" className="projects-search-icon">
              <path d="M11 19a8 8 0 100-16 8 8 0 000 16z" stroke="currentColor" strokeWidth="1.8"/>
              <path d="M21 21l-4.2-4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              className="projects-search-input"
              placeholder="Search projects..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </div>
        <p className="projects-subtitle">
          {loading
            ? 'Loading your projects...'
            : projects.length > 0
              ? 'Your launched project history with detected stack details.'
              : 'Your project history will appear here.'}
        </p>

        {/* Loading state */}
        {loading && (
          <div className="projects-empty">
            <p className="empty-label">Loading...</p>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="projects-empty">
            <p className="empty-label" style={{ color: '#f87171' }}>{error}</p>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && projects.length === 0 && (
          <div className="projects-empty">
            <svg viewBox="0 0 24 24" fill="none" className="empty-icon">
              <rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="13" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="13" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
            <p className="empty-label">No projects yet</p>
          </div>
        )}

        {!loading && !error && projects.length > 0 && visibleProjects.length === 0 && (
          <div className="projects-empty">
            <p className="empty-label">No project matches "{searchTerm}"</p>
          </div>
        )}

        {/* Projects list */}
        {!loading && !error && visibleProjects.length > 0 && (
          <div className="projects-list">
            {visibleProjects.map(p => (
              <ProjectCard
                key={p.id}
                project={p}
                onDeleteRequest={handleDeleteRequest}
                isPinned={pinnedProjectIds.includes(p.id)}
                onTogglePin={handleTogglePin}
              />
            ))}
          </div>
        )}
      </main>

      {projectToDelete && (
        <DeleteConfirmModal
          project={projectToDelete}
          onCancel={() => setProjectToDelete(null)}
          onConfirm={handleDeleteConfirm}
        />
      )}
    </div>
  )
}

export default ProjectsList