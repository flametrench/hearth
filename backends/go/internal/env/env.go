// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

// Package env loads runtime configuration. Mirrors backends/node/src/env.ts.
package env

import (
	"fmt"
	"os"
	"strconv"
)

type Env struct {
	Port                int
	DatabaseURL         string
	SMTPHost            string
	SMTPPort            int
	SMTPFrom            string
	HearthPublicBaseURL string
}

func required(name string) (string, error) {
	v := os.Getenv(name)
	if v == "" {
		return "", fmt.Errorf("missing required env var: %s", name)
	}
	return v, nil
}

func withDefault(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func parseIntDefault(name string, def int) (int, error) {
	v := os.Getenv(name)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("env %s: %w", name, err)
	}
	return n, nil
}

func Load() (Env, error) {
	dbURL, err := required("DATABASE_URL")
	if err != nil {
		return Env{}, err
	}
	port, err := parseIntDefault("PORT", 5005)
	if err != nil {
		return Env{}, err
	}
	smtpPort, err := parseIntDefault("SMTP_PORT", 1025)
	if err != nil {
		return Env{}, err
	}
	return Env{
		Port:                port,
		DatabaseURL:         dbURL,
		SMTPHost:            withDefault("SMTP_HOST", "localhost"),
		SMTPPort:            smtpPort,
		SMTPFrom:            withDefault("SMTP_FROM", "hearth@localhost"),
		HearthPublicBaseURL: withDefault("HEARTH_PUBLIC_BASE_URL", "http://localhost:3000"),
	}, nil
}
