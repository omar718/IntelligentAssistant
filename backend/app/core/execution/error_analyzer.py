"""
Sprint 5 — Error Recovery & Automated Troubleshooting
Sprint 6 — Groq + 30-day Redis cache
Sprint 7 (R3) — RAG: embedding-based retrieval replaces regex matching

Retrieval flow:
  1. Semantic similarity search via pgvector  (fast, catches paraphrased errors)
  2. Regex/substring fallback                 (catches exact known patterns)
  3. Groq API with few-shot examples          (unknown errors, best context)

All results cached in Redis for 30 days.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from typing import Callable, List, Optional

logger = logging.getLogger(__name__)


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class Solution:
    description: str
    commands: List[List[str]]
    success_rate: float = 0.5
    conditions: dict = field(default_factory=dict)


@dataclass
class AnalysisResult:
    matched: bool
    pattern_id: Optional[int]
    solutions: List[Solution] = field(default_factory=list)
    raw_error: str = ""
    match_method: str = ""   # "embedding" | "regex" | "groq" | "cache"


@dataclass
class ApplyResult:
    success: bool
    solution_used: Optional[Solution] = None
    output: str = ""


# ── Main class ────────────────────────────────────────────────────────────────

class ErrorAnalyzer:
    """
    Usage inside install_project task:
        analyzer = ErrorAnalyzer(
            project_path=project_path,
            project_type=project_type,
            on_log=log_callback,
        )
        analysis = analyzer.analyze(error_output)
        apply_result = await analyzer.apply_top_fix(analysis, project_path)
    """

    def __init__(
        self,
        project_path,
        project_type: str,
        on_log: Optional[Callable[[str], None]] = None,
    ):
        from pathlib import Path
        self.project_path = Path(project_path)
        self.project_type = project_type
        self.on_log = on_log or (lambda msg: None)

    # ── Step 1: analyse ───────────────────────────────────────────────────────

    def analyze(self, error_output: str) -> AnalysisResult:
        """
        Three-stage retrieval:
          1. Embedding similarity (semantic — catches paraphrased errors)
          2. Regex fallback       (deterministic — catches exact known patterns)
          3. Groq + few-shot      (generative — handles unknown errors)

        Redis cache is checked first and written after every Groq call.
        """
        # ── Cache check ────────────────────────────────────────────
        cache_key = self._cache_key(error_output)
        cached = self._cache_get(cache_key)
        if cached is not None:
            logger.info("Error analysis cache HIT")
            return AnalysisResult(
                matched=True,
                pattern_id=None,
                solutions=self._solutions_from_data(cached),
                raw_error=error_output,
                match_method="cache",
            )

        # ── Stage 1: embedding similarity ─────────────────────────
        embedding_result = self._match_by_embedding(error_output)
        if embedding_result.matched:
            logger.info(
                "Error matched by embedding similarity (method=embedding, pattern_id=%s)",
                embedding_result.pattern_id,
            )
            self._cache_set(cache_key, self._solutions_to_data(embedding_result.solutions))
            return embedding_result

        # ── Stage 2: regex fallback ────────────────────────────────
        regex_result = self._match_db_patterns(error_output)
        if regex_result.matched:
            logger.info("Error matched by regex (pattern_id=%s)", regex_result.pattern_id)
            self._cache_set(cache_key, self._solutions_to_data(regex_result.solutions))
            return regex_result

        # ── Stage 3: Groq with few-shot context ───────────────────
        logger.info("No DB match — calling Groq with few-shot context")
        similar_examples = self._get_similar_examples_for_prompt(error_output)
        return self._ai_suggest_solution(error_output, similar_examples, cache_key)

    # ── Step 2: apply ─────────────────────────────────────────────────────────

    async def apply_top_fix(
        self,
        analysis: AnalysisResult,
        project_path=None,
    ) -> ApplyResult:
        from pathlib import Path
        cwd = Path(project_path) if project_path else self.project_path

        for solution in analysis.solutions:
            self.on_log(f"[ErrorAnalyzer] Trying fix: {solution.description}")
            all_ok = True
            output_lines: List[str] = []

            for argv in solution.commands:
                code, out = await self._run(argv, cwd=cwd)
                output_lines.append(out)
                if code != 0:
                    self.on_log(f"[ErrorAnalyzer] Command failed: {' '.join(argv)}")
                    all_ok = False
                    break
                else:
                    self.on_log(f"[ErrorAnalyzer] {' '.join(argv)}")

            if all_ok:
                await self._update_success_rate(analysis.pattern_id, success=True)
                # ── Promote successful Groq fix to DB pattern with embedding ──
                if analysis.match_method == "groq" and analysis.pattern_id is None:
                    await self._promote_to_pattern(
                        error_output=analysis.raw_error,
                        solution=solution,
                    )
                return ApplyResult(
                    success=True,
                    solution_used=solution,
                    output="\n".join(output_lines),
                )
            else:
                await self._update_success_rate(analysis.pattern_id, success=False)

        return ApplyResult(success=False, output="All fixes exhausted")

    # ── Stage 1: embedding similarity ────────────────────────────────────────

    def _match_by_embedding(self, error_output: str) -> AnalysisResult:
        """
        Use pgvector cosine similarity to find the closest known error pattern.
        Falls back gracefully if sentence-transformers is not installed.
        """
        try:
            from app.core.ai.embedding_service import EmbeddingService
            service = EmbeddingService()
            similar = service.find_similar(error_output, self.project_type, limit=3)

            if not similar:
                return AnalysisResult(matched=False, pattern_id=None, raw_error=error_output)

            # Use the top match
            top = similar[0]
            self.on_log(
                f"[ErrorAnalyzer] Embedding match: similarity={top['similarity']:.2f} "
                f"pattern_id={top['id']}"
            )

            solutions = self._parse_solutions(top["solutions"])
            solutions.sort(key=lambda s: s.success_rate, reverse=True)

            return AnalysisResult(
                matched=True,
                pattern_id=top["id"],
                solutions=solutions,
                raw_error=error_output,
                match_method="embedding",
            )

        except Exception as exc:
            logger.warning("Embedding match failed (non-fatal): %s", exc)
            return AnalysisResult(matched=False, pattern_id=None, raw_error=error_output)

    # ── Stage 2: regex fallback ───────────────────────────────────────────────

    def _match_db_patterns(self, error_output: str) -> AnalysisResult:
        try:
            from app.db.session import get_sync_session
            from app.models.error_pattern import ErrorPattern

            with get_sync_session() as db:
                rows = (
                    db.query(ErrorPattern)
                    .filter(
                        (ErrorPattern.project_type == self.project_type)
                        | (ErrorPattern.project_type.is_(None))
                    )
                    .all()
                )

                for row in rows:
                    if self._signature_matches(row.signature, error_output):
                        solutions = self._parse_solutions(row.solutions or [])
                        solutions.sort(key=lambda s: s.success_rate, reverse=True)
                        return AnalysisResult(
                            matched=True,
                            pattern_id=row.id,
                            solutions=solutions,
                            raw_error=error_output,
                            match_method="regex",
                        )

        except Exception as exc:
            logger.warning("DB regex lookup failed: %s", exc)

        return AnalysisResult(matched=False, pattern_id=None, raw_error=error_output)

    def _signature_matches(self, signature: str, error_output: str) -> bool:
        try:
            return bool(re.search(signature, error_output, re.IGNORECASE))
        except re.error:
            return signature.lower() in error_output.lower()

    def _parse_solutions(self, raw: list) -> List[Solution]:
        out = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            out.append(Solution(
                description=item.get("description", ""),
                commands=item.get("commands", []),
                success_rate=float(item.get("success_rate", 0.5)),
                conditions=item.get("conditions", {}),
            ))
        return out

    # ── Stage 3: Groq with few-shot examples ─────────────────────────────────

    def _get_similar_examples_for_prompt(self, error_output: str) -> List[dict]:
        """
        Retrieve top similar patterns to use as few-shot examples in the Groq prompt.
        Uses a lower similarity threshold than the match threshold so we always
        get some context even for novel errors.
        """
        try:
            from app.core.ai.embedding_service import EmbeddingService
            service = EmbeddingService()
            # Lower threshold for few-shot context (0.5) vs match threshold (0.75)
            similar = service.find_similar(error_output, self.project_type, limit=3)
            # Return even low-similarity results as prompt context
            return similar
        except Exception as exc:
            logger.warning("Few-shot retrieval failed (non-fatal): %s", exc)
            return []

    def _format_few_shot_examples(self, examples: List[dict]) -> str:
        """Format similar past errors as few-shot examples for the prompt."""
        if not examples:
            return ""

        lines = ["Here are similar past errors and their successful fixes:\n"]
        for i, ex in enumerate(examples, 1):
            solutions = ex.get("solutions", [])
            if not solutions:
                continue
            best = max(solutions, key=lambda s: s.get("success_rate", 0))
            lines.append(f"Example {i}:")
            lines.append(f"  Error pattern: {ex['signature'][:200]}")
            lines.append(f"  Fix: {best.get('description', '')}")
            cmds = best.get("commands", [])
            if cmds:
                lines.append(f"  Commands: {cmds}")
            lines.append(f"  Success rate: {ex['success_rate']:.0%}\n")

        return "\n".join(lines)

    def _ai_suggest_solution(
        self,
        error_output: str,
        similar_examples: List[dict],
        cache_key: str,
    ) -> AnalysisResult:
        """
        Call Groq with few-shot context from similar past errors.
        Caches result for 30 days.
        """
        import json as _json

        few_shot_block = self._format_few_shot_examples(similar_examples)

        prompt = f"""
You are an automated installer recovery assistant fixing a {self.project_type} project.

{few_shot_block}
Now fix this new error:

<error>
{error_output[:3000]}
</error>

Respond ONLY with a JSON array (no markdown, no prose) of up to 3 fix objects:
{{
  "description": "short human-readable fix name",
  "commands": [["cmd", "arg1", "arg2"], ...],
  "success_rate": 0.0-1.0
}}

Rules:
- commands must be argv lists (no shell strings, no &&, no pipes)
- prefer non-destructive fixes first
- if a file needs creating: ["python3", "-c", "open('file','w').write('content')"]
"""

        try:
            from groq import Groq
            from app.core.config import settings

            client = Groq(api_key=settings.GROQ_API_KEY)
            message = client.chat.completions.create(
                model=settings.GROQ_MODEL,
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}],
            )

            raw_text = message.choices[0].message.content
            raw_text = re.sub(r"^```[a-z]*\n?|```$", "", raw_text, flags=re.MULTILINE).strip()
            data = _json.loads(raw_text)

            self._cache_set(cache_key, data)

            return AnalysisResult(
                matched=False,
                pattern_id=None,
                solutions=self._solutions_from_data(data),
                raw_error=error_output,
                match_method="groq",
            )

        except Exception as exc:
            logger.error("Groq API fallback failed: %s", exc)
            return AnalysisResult(
                matched=False,
                pattern_id=None,
                solutions=[],
                raw_error=error_output,
                match_method="groq",
            )

    # ── Auto-promote successful Groq fixes to DB ──────────────────────────────

    async def _promote_to_pattern(self, error_output: str, solution: Solution) -> None:
        try:
            import re
            from app.db.session import get_sync_session
            from sqlalchemy import text
            import json as _json
            solutions_json = _json.dumps([{
                "description": solution.description,
                "commands": solution.commands,
                "success_rate": solution.success_rate,
            }])


            first_line = error_output.strip().splitlines()[0][:240]
            signature = re.escape(first_line)

            # Generate embedding BEFORE inserting
            try:
                from app.core.ai.embedding_service import EmbeddingService
                svc = EmbeddingService()
                embedding = svc.embed(first_line)
                vector_str = "[" + ",".join(f"{v:.6f}" for v in embedding) + "]"
            except Exception:
                vector_str = None

            with get_sync_session() as db:
                # Check duplicate
                existing = db.execute(
                    text("SELECT id FROM error_patterns WHERE signature = :sig"),
                    {"sig": signature}
                ).fetchone()
                if existing:
                    return

                # Insert with embedding in one atomic operation
                if vector_str:
                    db.execute(
                        text(f"""
                            INSERT INTO error_patterns
                                (signature, category, project_type, solutions,
                                occurrences, success_rate, embedding)
                            VALUES
                                (:sig, 'auto_learned', :pt, '{solutions_json.replace("'", "''")}',
                                1, :sr, '{vector_str}'::vector)
                        """),
                        {"sig": signature, "pt": self.project_type, "sr": solution.success_rate}
                    )
                else:
                    db.execute(
                        text("""
                            INSERT INTO error_patterns
                                (signature, category, project_type, solutions,
                                occurrences, success_rate)
                            VALUES
                                (:sig, 'auto_learned', :pt, CAST(:sol AS json), 1, :sr)
                        """),
                        {
                            "sig": signature,
                            "pt": self.project_type,
                            "sol": json.dumps([{
                                "description": solution.description,
                                "commands": solution.commands,
                                "success_rate": solution.success_rate,
                            }]),
                            "sr": solution.success_rate,
                        }
                    )
                db.commit()
                logger.info("Auto-promoted pattern with embedding in single transaction")

        except Exception as exc:
            logger.warning("_promote_to_pattern failed (non-fatal): %s", exc)

    # ── Redis cache ───────────────────────────────────────────────────────────

    _CACHE_TTL = 60 * 60 * 24 * 30   # 30 days

    def _cache_key(self, error_output: str) -> str:
        import hashlib
        raw = f"{self.project_type}:{error_output[:500]}"
        return "ai_solution:" + hashlib.sha256(raw.encode()).hexdigest()

    def _cache_get(self, key: str):
        try:
            import json as _json
            import redis
            from app.core.config import settings
            r = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)
            cached = r.get(key)
            r.close()
            if cached:
                return _json.loads(cached)
        except Exception as exc:
            logger.warning("Cache get failed (non-fatal): %s", exc)
        return None

    def _cache_set(self, key: str, data: list) -> None:
        try:
            import json as _json
            import redis
            from app.core.config import settings
            r = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)
            r.setex(key, self._CACHE_TTL, _json.dumps(data))
            r.close()
        except Exception as exc:
            logger.warning("Cache set failed (non-fatal): %s", exc)

    def _solutions_from_data(self, data: list) -> List[Solution]:
        solutions = []
        for item in data[:3]:
            if not isinstance(item, dict):
                continue
            solutions.append(Solution(
                description=item.get("description", "AI-suggested fix"),
                commands=item.get("commands", []),
                success_rate=float(item.get("success_rate", 0.5)),
            ))
        solutions.sort(key=lambda s: s.success_rate, reverse=True)
        return solutions

    def _solutions_to_data(self, solutions: List[Solution]) -> list:
        """Convert Solution objects back to JSON-serialisable dicts for caching."""
        return [
            {
                "description": s.description,
                "commands": s.commands,
                "success_rate": s.success_rate,
            }
            for s in solutions
        ]

    # ── DB success-rate update ────────────────────────────────────────────────

    async def _update_success_rate(self, pattern_id: Optional[int], success: bool):
        if pattern_id is None:
            return
        try:
            from app.db.session import get_sync_session
            from app.models.error_pattern import ErrorPattern

            with get_sync_session() as db:
                row = db.get(ErrorPattern, pattern_id)
                if row is None:
                    return
                row.occurrences = (row.occurrences or 1) + 1
                current = row.success_rate or 0.5
                row.success_rate = current * 0.8 + (1.0 if success else 0.0) * 0.2
                db.commit()
        except Exception as exc:
            logger.warning("success_rate update failed: %s", exc)

    # ── Subprocess helper ─────────────────────────────────────────────────────

    async def _run(self, argv: List[str], cwd=None) -> tuple[int, str]:
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=str(cwd or self.project_path),
            )
            stdout, _ = await proc.communicate()
            return proc.returncode, stdout.decode().strip()
        except FileNotFoundError as exc:
            return 1, f"Command not found: {exc}"