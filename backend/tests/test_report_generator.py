import sys
sys.path.append(".")

from app.services.report_generator import generate_stack_report

sample = {
    "project_name": "ecommerce-platform",
    "project_id":   "proj_abc123",
    "user_email":   "omar@pfe2026.dz",
    "stack": {
        "type":             "Node.js",
        "framework":        "Express 4.18",
        "language":         "JavaScript",
        "package_manager":  "npm",
        "node_version":     "20.11.0",
        "entry_point":      "npm run start",
        "port":             3000,
        "resolution":       "local",
    },
    "environment": {
        "NODE_ENV":     "production",
        "DATABASE_URL": "postgres://localhost:5432/ecommerce",
        "JWT_SECRET":   "supersecret123",
        "PORT":         "3000",
    },
    "dependencies": [
        {"name": "express",      "version": "4.18.2", "status": "installed"},
        {"name": "pg",           "version": "8.11.3", "status": "installed"},
        {"name": "jsonwebtoken", "version": "9.0.2",  "status": "installed"},
        {"name": "bcryptjs",     "version": "2.4.3",  "status": "installed"},
    ],
    "installation_steps": [
        {"order": 1, "action": "nvm_setup",        "status": "success", "duration_s": 3},
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
    "conflicts_resolved": [
        {"component": "node", "required": "20.x", "actual": "18.19.0",
         "strategy": "nvm install 20"}
    ],
    "notes": "Project launched successfully.",
}

pdf_bytes = generate_stack_report(sample)

output_path = "test_report.pdf"
with open(output_path, "wb") as f:
    f.write(pdf_bytes)

print(f"PDF saved: {output_path} ({len(pdf_bytes):,} bytes)")