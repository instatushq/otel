<?php

declare(strict_types=1);

namespace Instatus;

use BackedEnum;
use DateTimeInterface;
use JsonSerializable;
use stdClass;
use Stringable;
use Throwable;
use UnitEnum;

final class Scrub
{
    public const FILTERED = '[Filtered]';

    private const SENSITIVE_KEY = '/pass(word|wd)?|secret|token|api[-_.]?key|auth|credential|session|cookie|csrf|xsrf|private[-_.]?key|signature/i';
    private const CARD_NUMBER = '/\b\d(?:[ -]?\d){12,18}\b/';
    private const URL_CREDENTIALS = '~^([a-z][a-z0-9+.-]*://)[^/@?#]*@~i';
    private const URL_PARAM = '/([?&#])([^=&#]+)=([^&#]*)/';
    private const URL_IN_TEXT = '~\b[a-z][a-z0-9+.-]*://[^\s"\'<>`]+~i';
    private const MAX_DEPTH = 6;
    public const UNREADABLE = '[Unreadable]';

    public static function isSensitiveKey(string|int $key): bool
    {
        return preg_match(self::SENSITIVE_KEY, (string) $key) === 1;
    }

    /**
     * Exception messages carry whole URLs (Guzzle puts the request URL in
     * its message), so URLs inside text lose their secrets as well.
     */
    public static function text(string $text): string
    {
        $withUrls = preg_replace_callback(
            self::URL_IN_TEXT,
            static fn (array $match): string => self::stripUrl($match[0]),
            $text
        ) ?? $text;

        return self::cards($withUrls);
    }

    /**
     * OAuth redirects put tokens in the hash as well as the query, and a card
     * number can sit in any parameter, not only under a secret-sounding name.
     */
    public static function url(string $url): string
    {
        return self::cards(self::stripUrl($url));
    }

    public static function value(string|int $key, mixed $value): mixed
    {
        return self::nested((string) $key, $value, 0, []);
    }

    private static function stripUrl(string $url): string
    {
        $withoutCredentials = preg_replace(self::URL_CREDENTIALS, '$1', $url) ?? $url;

        return preg_replace_callback(
            self::URL_PARAM,
            static function (array $match): string {
                if (!self::isSensitiveKey(rawurldecode($match[2]))) {
                    return $match[0];
                }

                return $match[1] . $match[2] . '=' . self::FILTERED;
            },
            $withoutCredentials
        ) ?? $withoutCredentials;
    }

    private static function cards(string $text): string
    {
        return preg_replace_callback(
            self::CARD_NUMBER,
            static function (array $match): string {
                $digits = preg_replace('/\D/', '', $match[0]) ?? '';

                return self::passesLuhn($digits) ? self::FILTERED : $match[0];
            },
            $text
        ) ?? $text;
    }

    /**
     * The Luhn check keeps timestamps and order numbers of card length.
     */
    private static function passesLuhn(string $digits): bool
    {
        $sum = 0;
        $length = strlen($digits);
        for ($index = 0; $index < $length; $index++) {
            $digit = (int) $digits[$length - 1 - $index];
            if ($index % 2 === 1) {
                $digit *= 2;
            }
            if ($digit > 9) {
                $digit -= 9;
            }
            $sum += $digit;
        }

        return $sum % 10 === 0;
    }

    /**
     * $ancestors holds the objects on the current path only, so an object used
     * twice (billing and shipping address) is kept and only a real cycle is cut.
     *
     * @param array<int, true> $ancestors
     */
    private static function nested(string $key, mixed $value, int $depth, array $ancestors): mixed
    {
        if (self::isSensitiveKey($key)) {
            return self::FILTERED;
        }
        if (is_string($value)) {
            return self::text($value);
        }
        if (is_resource($value)) {
            return 'Resource ' . get_resource_type($value);
        }
        if (!is_object($value)) {
            return is_array($value) ? self::children($value, $depth, $ancestors) : $value;
        }

        $id = spl_object_id($value);
        if (isset($ancestors[$id])) {
            return '[Circular]';
        }
        $ancestors[$id] = true;

        if ($value instanceof stdClass) {
            return self::children(get_object_vars($value), $depth, $ancestors);
        }
        if ($value instanceof JsonSerializable) {
            try {
                $serialized = $value->jsonSerialize();
            } catch (Throwable) {
                return self::UNREADABLE;
            }

            return self::nested($key, $serialized, $depth, $ancestors);
        }

        return self::scalarOf($value);
    }

    /**
     * @param array<array-key, mixed> $values
     * @param array<int, true> $ancestors
     * @return array<array-key, mixed>|string
     */
    private static function children(array $values, int $depth, array $ancestors): array|string
    {
        if ($depth >= self::MAX_DEPTH) {
            return '[Truncated]';
        }
        $scrubbed = [];
        foreach ($values as $childKey => $child) {
            $scrubbed[$childKey] = self::nested((string) $childKey, $child, $depth + 1, $ancestors);
        }

        return $scrubbed;
    }

    private static function scalarOf(object $value): string|int
    {
        if ($value instanceof BackedEnum) {
            return $value->value;
        }
        if ($value instanceof UnitEnum) {
            return $value->name;
        }
        if ($value instanceof DateTimeInterface) {
            return $value->format(DateTimeInterface::RFC3339_EXTENDED);
        }
        if ($value instanceof Stringable) {
            try {
                return self::text((string) $value);
            } catch (Throwable) {
                return self::UNREADABLE;
            }
        }

        return 'Object ' . $value::class;
    }
}
