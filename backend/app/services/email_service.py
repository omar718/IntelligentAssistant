import smtplib
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.core.config import settings
from app.core.security import create_signed_token

logger = logging.getLogger(__name__)


def _normalize_base_url(base_url: str) -> str:
    url = str(base_url).strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        url = f"http://{url}"
    return url


def _send_email(to: str, subject: str, html_body: str) -> None:
    """Send a plain HTML email via SMTP."""
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = settings.EMAIL_FROM
    msg["To"] = to
    msg.attach(MIMEText(html_body, "html"))

    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
        server.ehlo()
        server.starttls()
        server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        server.sendmail(settings.EMAIL_FROM, to, msg.as_string())


def send_verification_email(user_id: str, email: str) -> None:
    """
    Send email verification link (token expires in 24 hours).
    The link points to the frontend verify-email page.
    """
    token = create_signed_token(user_id, purpose="email_verify", ttl_hours=24)
    app_url = _normalize_base_url(settings.APP_BASE_URL)
    link = f"{app_url}/verify-email?token={token}"
    
    logger.info(f"Generating verification email. APP_BASE_URL={app_url}, Token={token[:20]}..., Link={link}")
    
    # Simple, reliable HTML that works in all email clients
    html = f"""<html><body>
<h2>Verify your email</h2>
<p>Click the link below to activate your Intelligent Assistant account. This link expires in 24 hours.</p>
<p><a href="{link}" target="_blank" style="background-color: #2563EB; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Verify Email</a></p>
<p>If you did not create an account, you can safely ignore this email.</p>
</body></html>"""
    
    logger.debug(f"Email HTML: {html}")
    _send_email(email, "Verify your email — Intelligent Assistant", html)


def send_password_reset_email(user_id: str, email: str) -> None:
    """
    Send password-reset link (token expires in 1 hour).
    The link points to the frontend reset-password page.
    """
    token = create_signed_token(user_id, purpose="password_reset", ttl_hours=1)
    app_url = _normalize_base_url(settings.APP_BASE_URL)
    link = f"{app_url}/reset-password?token={token}"
    
    logger.info(f"Generating password reset email. APP_BASE_URL={app_url}, Token={token[:20]}..., Link={link}")
    
    # Simple, reliable HTML that works in all email clients
    html = f"""<html><body>
<h2>Reset your password</h2>
<p>You requested a password reset for your Intelligent Assistant account. This link expires in 1 hour.</p>
<p><a href="{link}" target="_blank" style="background-color: #2563EB; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">Reset Password</a></p>
<p>If you did not request this, you can safely ignore this email. Your password has not been changed.</p>
</body></html>"""
    
    logger.debug(f"Email HTML: {html}")
    _send_email(email, "Reset your password — Intelligent Assistant", html)