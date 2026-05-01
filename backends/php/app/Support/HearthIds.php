<?php

declare(strict_types=1);

namespace App\Support;

use InvalidArgumentException;
use Symfony\Component\Uid\Uuid;

/**
 * Hearth wire-format helpers for app-defined prefixes (inst_, ticket_, comment_).
 * Mirrors backends/node/src/ids.ts.
 */
final class HearthIds
{
    /** @var array<string,bool> */
    private const PREFIXES = ['inst' => true, 'ticket' => true, 'comment' => true];

    public static function generate(string $prefix): string
    {
        if (! isset(self::PREFIXES[$prefix])) {
            throw new InvalidArgumentException("Unsupported Hearth prefix: $prefix");
        }
        $uuid = Uuid::v7()->toRfc4122();

        return $prefix.'_'.str_replace('-', '', $uuid);
    }

    public static function toUuid(string $wireId): string
    {
        $sep = strpos($wireId, '_');
        if ($sep === false) {
            throw new InvalidArgumentException("Malformed Hearth id: $wireId");
        }
        $hex = substr($wireId, $sep + 1);
        if (strlen($hex) !== 32 || ! ctype_xdigit($hex)) {
            throw new InvalidArgumentException("Malformed Hearth id payload: $wireId");
        }

        return substr($hex, 0, 8).'-'.substr($hex, 8, 4).'-'.substr($hex, 12, 4)
            .'-'.substr($hex, 16, 4).'-'.substr($hex, 20);
    }

    public static function fromUuid(string $prefix, string $uuid): string
    {
        return $prefix.'_'.str_replace('-', '', $uuid);
    }
}
