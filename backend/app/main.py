from dotenv import load_dotenv
load_dotenv()                          # loads .env (Docker defaults: host=db)
load_dotenv(".env.local", override=True)  # local override: host=localhost

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import projects

app = FastAPI(title="Intelligent Assistant API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router)

@app.get("/health")
async def health():
    return {"status": "ok"}

