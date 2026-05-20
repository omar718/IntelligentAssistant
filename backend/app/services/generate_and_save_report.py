import logging
from datetime import datetime, timezone
 
from app.services.report_generator import generate_stack_report
from app.services.r2_storage import B2Storage
from app.services.report_service import ReportService
from app.db.session import SessionLocal
 
logger = logging.getLogger(__name__)
 
 
async def generate_and_save_report(
    project_id: str,
    installation_history_id: int,
    report_data: dict,
) -> str:
    """
    1. Build the PDF bytes via generate_stack_report()
    2. Upload to B2 under  reports/{project_id}/{timestamp}.pdf
    3. Persist a StackReport row
    Returns the storage key.
    """
    pdf_bytes = generate_stack_report(report_data)
 
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    r2_key = f"reports/{project_id}/{ts}.pdf"
 
    b2 = B2Storage()
    await b2.upload(r2_key, pdf_bytes)
 
    async with SessionLocal() as db:
        svc = ReportService(db)
        await svc.save(
            project_id=project_id,
            r2_key=r2_key,
            installation_history_id=installation_history_id,
        )
 
    logger.info("Stack report generated and saved: %s", r2_key)
    return r2_key
