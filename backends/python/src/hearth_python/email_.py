"""SMTP mailer for share-link and admin-notification emails."""

from __future__ import annotations

import smtplib
from dataclasses import dataclass
from email.message import EmailMessage


@dataclass(frozen=True)
class MailerConfig:
    host: str
    port: int
    from_addr: str
    public_base_url: str


class Mailer:
    def __init__(self, config: MailerConfig) -> None:
        self._config = config

    def share_url(self, token: str) -> str:
        return f"{self._config.public_base_url}/share/{token}"

    def send_share_link_email(
        self,
        *,
        to: str,
        org_name: str,
        ticket_subject: str,
        share_token: str,
    ) -> None:
        url = self.share_url(share_token)
        msg = EmailMessage()
        msg["From"] = self._config.from_addr
        msg["To"] = to
        msg["Subject"] = f"Your support request — {ticket_subject}"
        msg.set_content(
            "\n".join(
                [
                    f"Thanks for contacting {org_name}.",
                    "",
                    "View your ticket and reply at:",
                    f"  {url}",
                    "",
                    "This link is valid for 30 days.",
                ]
            )
        )
        self._send(msg)

    def send_customer_reply_notification(
        self,
        *,
        to: list[str],
        org_name: str,
        ticket_subject: str,
        customer_email: str,
        reopened: bool,
    ) -> None:
        if not to:
            return
        subject_prefix = "Ticket reopened by customer reply" if reopened else "New customer reply"
        msg = EmailMessage()
        msg["From"] = self._config.from_addr
        msg["To"] = ", ".join(to)
        msg["Subject"] = f"{subject_prefix} — {ticket_subject}"
        body_lines = [
            f'{customer_email} replied to "{ticket_subject}" in {org_name}.',
        ]
        if reopened:
            body_lines.append("The ticket was resolved and is now reopened.")
        body_lines.extend(["", "Open the ticket in your inbox to respond."])
        msg.set_content("\n".join(body_lines))
        self._send(msg)

    def _send(self, msg: EmailMessage) -> None:
        # local_hostname pinned to 'hearth-python' instead of letting
        # smtplib call socket.getfqdn() — on macOS that triggers a slow
        # reverse-DNS lookup that adds ~25s to every send.
        with smtplib.SMTP(
            self._config.host,
            self._config.port,
            local_hostname="hearth-python",
            timeout=10,
        ) as smtp:
            smtp.send_message(msg)
