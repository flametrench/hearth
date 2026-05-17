// Copyright 2026 NDC Digital, LLC
// SPDX-License-Identifier: Apache-2.0

// Package ids provides Hearth-specific wire-format id generation +
// parsing. The Flametrench SDK ids package handles framework prefixes;
// these are Hearth-app prefixes (inst, ticket, comment).
package ids

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"time"
)

type HearthPrefix string

const (
	PrefixInstall HearthPrefix = "inst"
	PrefixTicket  HearthPrefix = "ticket"
	PrefixComment HearthPrefix = "comment"
)

var hexPayload = regexp.MustCompile(`^[0-9a-f]{32}$`)

// Generate produces a UUIDv7 wire-format id `<prefix>_<32hex>`.
func Generate(prefix HearthPrefix) (string, error) {
	u, err := uuidV7()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s_%s", prefix, u), nil
}

// UUIDFromHearthID returns the canonical 8-4-4-4-12 UUID form of a
// Hearth wire id, for binding into Postgres uuid columns.
func UUIDFromHearthID(id string) (string, error) {
	sep := -1
	for i := 0; i < len(id); i++ {
		if id[i] == '_' {
			sep = i
			break
		}
	}
	if sep == -1 {
		return "", fmt.Errorf("malformed hearth id: %q", id)
	}
	h := id[sep+1:]
	if !hexPayload.MatchString(h) {
		return "", fmt.Errorf("malformed hearth id payload: %q", id)
	}
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32]), nil
}

// uuidV7 returns a UUIDv7 as 32-char hex (no hyphens). Matches the
// shape the SDK ids package uses.
func uuidV7() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	ms := uint64(time.Now().UnixMilli())
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	b[6] = (b[6] & 0x0F) | 0x70 // version 7
	b[8] = (b[8] & 0x3F) | 0x80 // variant 10
	return hex.EncodeToString(b[:]), nil
}
