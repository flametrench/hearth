// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

// Package email wraps net/smtp for the share-link and notification
// emails Hearth dispatches. Mirrors backends/node/src/email.ts.
package email

import (
	"fmt"
	"net/smtp"
	"strings"
)

type Config struct {
	Host          string
	Port          int
	From          string
	PublicBaseURL string
}

type Mailer struct {
	addr          string
	from          string
	publicBaseURL string
}

func New(cfg Config) *Mailer {
	return &Mailer{
		addr:          fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		from:          cfg.From,
		publicBaseURL: cfg.PublicBaseURL,
	}
}

func (m *Mailer) ShareURL(token string) string {
	return fmt.Sprintf("%s/share/%s", m.publicBaseURL, token)
}

// send dispatches a single message to one or more recipients. Mailpit
// accepts unauthenticated SMTP on localhost:1025 in dev; production
// deployments should authenticate.
func (m *Mailer) send(to []string, subject, body string) error {
	headers := strings.Builder{}
	headers.WriteString("From: " + m.from + "\r\n")
	headers.WriteString("To: " + strings.Join(to, ", ") + "\r\n")
	headers.WriteString("Subject: " + subject + "\r\n")
	headers.WriteString("\r\n")
	headers.WriteString(body)
	return smtp.SendMail(m.addr, nil, m.from, to, []byte(headers.String()))
}

type ShareLinkEmail struct {
	To            string
	OrgName       string
	TicketSubject string
	ShareToken    string
}

func (m *Mailer) SendShareLink(args ShareLinkEmail) error {
	url := m.ShareURL(args.ShareToken)
	body := strings.Join([]string{
		fmt.Sprintf("Thanks for contacting %s.", args.OrgName),
		"",
		"View your ticket and reply at:",
		"  " + url,
		"",
		"This link is valid for 30 days.",
	}, "\n")
	subject := fmt.Sprintf("Your support request — %s", args.TicketSubject)
	return m.send([]string{args.To}, subject, body)
}

type CustomerReplyNotification struct {
	To            []string
	OrgName       string
	TicketSubject string
	CustomerEmail string
	Reopened      bool
}

func (m *Mailer) SendCustomerReplyNotification(args CustomerReplyNotification) error {
	if len(args.To) == 0 {
		return nil
	}
	subjectPrefix := "New customer reply"
	if args.Reopened {
		subjectPrefix = "Ticket reopened by customer reply"
	}
	lines := []string{
		fmt.Sprintf("%s replied to %q in %s.", args.CustomerEmail, args.TicketSubject, args.OrgName),
	}
	if args.Reopened {
		lines = append(lines, "The ticket was resolved and is now reopened.")
	}
	lines = append(lines, "", "Open the ticket in your inbox to respond.")
	subject := fmt.Sprintf("%s — %s", subjectPrefix, args.TicketSubject)
	return m.send(args.To, subject, strings.Join(lines, "\n"))
}
