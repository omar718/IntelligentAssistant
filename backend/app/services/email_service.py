import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.core.config import settings
from app.core.security import create_signed_token


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
    The link points to the backend GET /auth/verify/{token} endpoint.
    """
    token = create_signed_token(user_id, purpose="email_verify", ttl_hours=24)
    link = f"{settings.API_BASE_URL}/auth/verify/{token}"

    html = f"""
    <h2>Verify your email</h2>
    <p>Click the link below to activate your Intelligent Assistant account.
       This link expires in 24 hours.</p>
    <p><a href="{link}" style="
        background:#2563EB;color:#fff;padding:12px 24px;
        border-radius:6px;text-decoration:none;font-weight:bold;">
      Verify Email
    </a></p>
    <p>If you did not create an account, you can safely ignore this email.</p>
    """

    _send_email(email, "Verify your email — Intelligent Assistant", html)


def send_password_reset_email(user_id: str, email: str) -> None:
    """
    Send password-reset link (token expires in 1 hour).
    The link points to the frontend reset-password page.
    """
    token = create_signed_token(user_id, purpose="password_reset", ttl_hours=1)
    link = f"{settings.APP_BASE_URL}/reset-password?token={token}"

    html = f"""
    <h2>Reset your password</h2>
    <p>You requested a password reset for your Intelligent Assistant account.
       This link expires in 1 hour.</p>
    <p><a href="{link}" style="
        background:#2563EB;color:#fff;padding:12px 24px;
        border-radius:6px;text-decoration:none;font-weight:bold;">
      Reset Password
    </a></p>
    <p>If you did not request this, you can safely ignore this email.
       Your password has not been changed.</p>
    """

    _send_email(email, "Reset your password — Intelligent Assistant", html)