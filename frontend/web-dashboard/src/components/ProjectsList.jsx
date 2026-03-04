import { useState } from 'react'
import TechBadge from './TechBadge'
import '../styles/ProjectsList.css'

// ── Mock data – replace with real API call once backend is ready ───────────────
const MOCK_PROJECTS = [
  {
    id: 1,
    name: 'e-commerce-api',
    url: 'https://github.com/user/e-commerce-api',
    date: '2026-03-02',
    detected_type: 'Node.js',
    detected_pm: 'npm',
    framework: 'Express',
    databases: ['PostgreSQL', 'Redis'],
  },
  {
    id: 2,
    name: 'ml-dashboard',
    url: 'https://github.com/user/ml-dashboard',
    date: '2026-03-01',
    detected_type: 'Python',
    detected_pm: 'pip',
    framework: 'FastAPI',
    databases: ['MongoDB'],
  },
  {
    id: 3,
    name: 'corporate-site',
    url: 'https://github.com/user/corporate-site',
    date: '2026-02-28',
    detected_type: 'PHP',
    detected_pm: 'composer',
    framework: 'Laravel',
    databases: ['MySQL'],
  },
  {
    id: 4,
    name: 'realtime-chat',
    url: 'https://github.com/user/realtime-chat',
    date: '2026-02-27',
    detected_type: 'Node.js',
    detected_pm: 'pnpm',
    framework: 'NestJS',
    databases: ['PostgreSQL', 'Redis', 'MongoDB'],
  },
]

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

function repoName(url) {
  try { return new URL(url).pathname.replace(/^\//, '') } catch { return url }
}

function handleDownload(project) {
  const lines = [
    `Project Report – ${project.name}`,
    `Generated: ${new Date().toLocaleString()}`,
    '',
    `Repository:     ${project.url}`,
    `Detected type:  ${project.detected_type}`,
    `Package mgr:    ${project.detected_pm}`,
    project.framework           ? `Framework:      ${project.framework}`                : null,
    project.databases?.length   ? `Databases:      ${project.databases.join(', ')}`     : null,
  ].filter(Boolean).join('\n')

  const blob = new Blob([lines], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${project.name}-report.txt`
  a.click()
  URL.revokeObjectURL(a.href)
}

// ── Project card ───────────────────────────────────────────────────────────────
function ProjectCard({ project, onDelete }) {
  const [open, setOpen] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  const allTechs = [
    project.detected_type,
    project.detected_pm,
    project.framework,
    ...(project.databases || []),
  ].filter(Boolean)

  return (
    <div className={`project-card ${open ? 'project-card--open' : ''}`}>
      {/* ── Top row ── */}
      <div className="project-card-top">
        <div className="project-card-left">
          <div className="project-card-name">
            <svg viewBox="0 0 24 24" fill="currentColor" className="project-card-gh-icon">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.79-.26.79-.58v-2.23c-3.34.73-4.03-1.42-4.03-1.42-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 016.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.19.7.8.58C20.57 21.8 24 17.3 24 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            <span>{project.name}</span>
          </div>
          <a href={project.url} target="_blank" rel="noreferrer" className="project-card-url">
            {repoName(project.url)}
          </a>
        </div>

        <div className="project-card-right">
          <span className="project-card-date">
            <svg viewBox="0 0 24 24" fill="currentColor" className="date-clock-icon">
              <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/>
            </svg>
            Created at {formatDate(project.date)}
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
              onClick={() => setShowConfirm(true)}
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
              </svg>
            </button>
            {showConfirm && (
              <div className="delete-confirm-inline">
                <span className="delete-confirm-text">Delete?</span>
                <button
                  className="delete-confirm-btn cancel"
                  onClick={() => setShowConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  className="delete-confirm-btn confirm"
                  onClick={() => { setShowConfirm(false); onDelete(project.id) }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Badge strip ── */}
      <div className="project-badges">
        {allTechs.map(t => <TechBadge key={t} name={t} />)}
      </div>

      {/* ── More info dropdown ── */}
      {open && (
        <div className="project-more-info">
          <div className="more-info-grid">
            <div className="more-info-row">
              <span className="more-info-label">Runtime</span>
              <TechBadge name={project.detected_type} />
            </div>
            <div className="more-info-row">
              <span className="more-info-label">Package manager</span>
              <TechBadge name={project.detected_pm} />
            </div>
            {project.framework && (
              <div className="more-info-row">
                <span className="more-info-label">Framework</span>
                <TechBadge name={project.framework} />
              </div>
            )}
            {project.databases?.length > 0 && (
              <div className="more-info-row">
                <span className="more-info-label">Databases</span>
                <div className="more-info-badges">
                  {project.databases.map(db => <TechBadge key={db} name={db} />)}
                </div>
              </div>
            )}
            {!project.framework && !project.databases?.length && (
              <p className="more-info-pending">
                Framework &amp; database detection coming in the next update.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────
function ProjectsList({ onBack }) {
  const [projects, setProjects] = useState(MOCK_PROJECTS)

  const handleDelete = (id) => {
    setProjects(prev => prev.filter(p => p.id !== id))
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
          <h1 className="projects-title">Projects</h1>
          <span className="projects-count">{projects.length} project{projects.length !== 1 ? 's' : ''}</span>
        </div>
        <p className="projects-subtitle">
          {projects.length > 0
            ? 'Your launched project history with detected stack details.'
            : 'Your project history will appear here.'}
        </p>

        {projects.length === 0 ? (
          <div className="projects-empty">
            <svg viewBox="0 0 24 24" fill="none" className="empty-icon">
              <rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="13" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="13" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
            <p className="empty-label">No projects yet</p>
          </div>
        ) : (
          <div className="projects-list">
            {projects.map(p => <ProjectCard key={p.id} project={p} onDelete={handleDelete} />)}
          </div>
        )}
      </main>
    </div>
  )
}

export default ProjectsList
