<?php

declare(strict_types=1);

namespace Instatus\Logging;

use Instatus\Attributes;
use Instatus\ExceptionData;
use Instatus\Scrub;
use Instatus\Sdk;
use Instatus\StackTrace;
use Instatus\Text;
use JsonSerializable;
use OpenTelemetry\API\Logs\LogRecord;
use OpenTelemetry\Context\Context;
use Psr\Log\InvalidArgumentException;
use stdClass;
use Stringable;
use Throwable;

/**
 * @internal shared by the PSR-3 logger and the Monolog handler
 */
final class LogEmitter
{
    private const SEVERITY = [
        'debug' => 5,
        'info' => 9,
        'notice' => 10,
        'warning' => 13,
        'error' => 17,
        'critical' => 18,
        'alert' => 19,
        'emergency' => 21,
    ];
    private const MAX_DEPTH = 6;
    private const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;

    /**
     * @param array<array-key, mixed> $context
     * @param array<array-key, mixed> $extra
     */
    public static function emit(
        string $scope,
        string $level,
        string $message,
        array $context = [],
        array $extra = [],
        ?int $timestampNanos = null,
    ): void {
        $severity = self::SEVERITY[$level] ?? throw new InvalidArgumentException("Unknown log level: $level");
        $exception = $context['exception'] ?? null;
        unset($context['exception']);

        $attributes = [];
        foreach ($context as $key => $value) {
            Attributes::put($attributes, (string) $key, $value);
        }
        foreach ($extra as $key => $value) {
            Attributes::put($attributes, 'extra.' . $key, $value);
        }
        if ($exception instanceof Throwable) {
            $attributes = array_merge($attributes, Attributes::ofException(new ExceptionData(
                StackTrace::typeOf($exception),
                $exception->getMessage(),
                StackTrace::of($exception)
            )));
        }

        $body = self::withoutSecrets(self::interpolate($message, $context), [$context, $extra]);
        $body = Text::truncate(Scrub::text($body), Attributes::MAX_VALUE_LENGTH);
        $record = (new LogRecord($body))
            ->setSeverityNumber($severity)
            ->setSeverityText(strtoupper($level))
            ->setAttributes($attributes)
            ->setContext(Context::getCurrent());
        if ($timestampNanos !== null) {
            $record->setTimestamp($timestampNanos);
        }
        Sdk::otelLogger($scope)->emit($record);
    }

    /**
     * @param array<array-key, mixed> $context
     */
    private static function interpolate(string $message, array $context): string
    {
        if (!str_contains($message, '{')) {
            return $message;
        }
        $replacements = [];
        foreach ($context as $key => $value) {
            if ($value !== null && !is_scalar($value) && !$value instanceof Stringable) {
                continue;
            }
            if (Scrub::isSensitiveKey($key)) {
                $replacements['{' . $key . '}'] = Scrub::FILTERED;
                continue;
            }
            $replacements['{' . $key . '}'] = (string) Scrub::value($key, self::messageText($value));
        }

        return strtr($message, $replacements);
    }

    private static function messageText(mixed $value): string
    {
        if (is_bool($value)) {
            return var_export($value, true);
        }
        try {
            return (string) $value;
        } catch (\Throwable) {
            return Scrub::UNREADABLE;
        }
    }

    /**
     * Monolog's PsrLogMessageProcessor fills in placeholders before the
     * handler sees the record, so values under sensitive keys are also
     * removed from the finished message, raw and as Monolog's JSON shows them.
     *
     * @param list<array<array-key, mixed>> $sources
     */
    private static function withoutSecrets(string $body, array $sources): string
    {
        $secrets = [];
        foreach ($sources as $values) {
            self::collectSecrets($values, false, 0, $secrets);
        }
        if ($secrets === []) {
            return $body;
        }

        return strtr($body, array_fill_keys(array_keys($secrets), Scrub::FILTERED));
    }

    /**
     * @param array<array-key, mixed> $values
     * @param array<string, true> $secrets
     */
    private static function collectSecrets(array $values, bool $sensitive, int $depth, array &$secrets): void
    {
        foreach ($values as $key => $value) {
            $isSecret = $sensitive || Scrub::isSensitiveKey($key);
            $children = self::childrenOf($value);
            if ($children !== null) {
                if ($depth < self::MAX_DEPTH) {
                    self::collectSecrets($children, $isSecret, $depth + 1, $secrets);
                }
                continue;
            }
            $text = $isSecret ? self::textOf($value) : null;
            if ($text === null || $text === '') {
                continue;
            }
            $secrets[$text] = true;
            $encoded = json_encode($text, self::JSON_FLAGS);
            if ($encoded !== false) {
                $secrets[substr($encoded, 1, -1)] = true;
            }
        }
    }

    /**
     * @return array<array-key, mixed>|null
     */
    private static function childrenOf(mixed $value): ?array
    {
        if (is_array($value)) {
            return $value;
        }
        if ($value instanceof stdClass) {
            return get_object_vars($value);
        }
        if (!$value instanceof JsonSerializable) {
            return null;
        }
        try {
            $serialized = $value->jsonSerialize();
        } catch (Throwable) {
            return null;
        }

        return is_array($serialized) ? $serialized : ['value' => $serialized];
    }

    /**
     * Booleans are left out: Monolog prints true as "1" and false as nothing.
     */
    private static function textOf(mixed $value): ?string
    {
        if (is_string($value) || is_int($value) || is_float($value)) {
            return (string) $value;
        }
        if (!$value instanceof Stringable) {
            return null;
        }
        try {
            return (string) $value;
        } catch (Throwable) {
            return null;
        }
    }
}
