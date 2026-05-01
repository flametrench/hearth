import nodemailer, { type Transporter } from 'nodemailer';

export interface MailerConfig {
  host: string;
  port: number;
  from: string;
  publicBaseUrl: string;
}

export class Mailer {
  private readonly transport: Transporter;
  private readonly from: string;
  private readonly publicBaseUrl: string;

  constructor(config: MailerConfig) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: false,
      ignoreTLS: true,
    });
    this.from = config.from;
    this.publicBaseUrl = config.publicBaseUrl;
  }

  shareUrl(token: string): string {
    return `${this.publicBaseUrl}/share/${token}`;
  }

  async sendShareLinkEmail(args: {
    to: string;
    orgName: string;
    ticketSubject: string;
    shareToken: string;
  }): Promise<void> {
    const url = this.shareUrl(args.shareToken);
    await this.transport.sendMail({
      from: this.from,
      to: args.to,
      subject: `Your support request — ${args.ticketSubject}`,
      text: [
        `Thanks for contacting ${args.orgName}.`,
        ``,
        `View your ticket and reply at:`,
        `  ${url}`,
        ``,
        `This link is valid for 30 days.`,
      ].join('\n'),
    });
  }

  async sendCustomerReplyNotification(args: {
    to: string[];
    orgName: string;
    ticketSubject: string;
    customerEmail: string;
    reopened: boolean;
  }): Promise<void> {
    if (args.to.length === 0) return;
    const subjectPrefix = args.reopened
      ? `Ticket reopened by customer reply`
      : `New customer reply`;
    await this.transport.sendMail({
      from: this.from,
      to: args.to.join(', '),
      subject: `${subjectPrefix} — ${args.ticketSubject}`,
      text: [
        `${args.customerEmail} replied to "${args.ticketSubject}" in ${args.orgName}.`,
        args.reopened ? `The ticket was resolved and is now reopened.` : ``,
        ``,
        `Open the ticket in your inbox to respond.`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
}
