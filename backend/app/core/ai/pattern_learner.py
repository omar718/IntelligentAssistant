# app/core/ai/pattern_learner.py
def save_new_pattern(error_output: str, project_type: str, solution: dict) -> None:
    from app.db.session import get_sync_session
    from app.models.error_pattern import ErrorPattern
    from app.core.ai.embedding_service import EmbeddingService

    with get_sync_session() as db:
        pattern = ErrorPattern(
            signature=error_output[:500],
            category="runtime",
            project_type=project_type,
            solutions=[solution],
            occurrences=1,
            success_rate=0.5,
        )
        db.add(pattern)
        db.commit()
        db.refresh(pattern)

    # embed and store immediately
    EmbeddingService().store_embedding(pattern.id, error_output)