<?php

declare(strict_types=1);

namespace Instatus;

/**
 * Sentry tags, contexts and extras become log attributes, and errors follow
 * the OpenTelemetry exception conventions so Instatus Errors groups them.
 */
final class Attributes
{
    public const MAX_VALUE_LENGTH = 8192;
    public const MAX_STACK_LENGTH = 32000;

    private const RESERVED_PREFIX = 'instatus.';
    private const DEFAULT_EXCEPTION_TYPE = 'Error';
    private const USER_KEYS = ['username' => 'name', 'ip_address' => 'ip'];
    private const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE;

    public static function toLogRecord(Event $event): ErrorLogRecord
    {
        [$severityNumber, $severityText] = Severity::of($event->level);
        $attributes = self::exceptionAttributes($event, $severityNumber >= Severity::ERROR);
        $attributes['log.record.uid'] = $event->eventId;

        foreach (self::metadataOf($event) as $key => $value) {
            $attributes[$key] ??= $value;
        }

        return new ErrorLogRecord(
            (int) round($event->timestamp * 1_000_000) * 1000,
            $severityNumber,
            $severityText,
            self::bodyOf($event),
            $attributes
        );
    }

    public static function toAttributeValue(mixed $value): string|int|float|bool|null
    {
        if ($value === null) {
            return null;
        }
        if (is_string($value)) {
            return Text::truncate($value, self::MAX_VALUE_LENGTH);
        }
        if (is_int($value) || is_float($value) || is_bool($value)) {
            return $value;
        }
        $json = json_encode($value, self::JSON_FLAGS);

        return Text::truncate($json === false ? get_debug_type($value) : $json, self::MAX_VALUE_LENGTH);
    }

    /**
     * @param array<string, string|int|float|bool> $attributes
     */
    public static function put(array &$attributes, string $key, mixed $value): void
    {
        if (str_starts_with($key, self::RESERVED_PREFIX)) {
            return;
        }
        $attribute = self::toAttributeValue(Scrub::value($key, $value));
        if ($attribute !== null && $attribute !== '') {
            $attributes[$key] = $attribute;
        }
    }

    /**
     * @return array<string, string|bool>
     */
    public static function ofException(ExceptionData $exception): array
    {
        $attributes = [
            'exception.type' => $exception->type !== '' ? $exception->type : self::DEFAULT_EXCEPTION_TYPE,
            'exception.message' => Text::truncate(Scrub::text($exception->value), self::MAX_VALUE_LENGTH),
        ];
        if ($exception->stacktrace !== null && $exception->stacktrace !== '') {
            $attributes['exception.stacktrace'] = Text::truncate(Scrub::text($exception->stacktrace), self::MAX_STACK_LENGTH);
        }
        $attributes['exception.handled'] = $exception->handled;

        return $attributes;
    }

    /**
     * @return array<string, string|int|float|bool>
     */
    private static function exceptionAttributes(Event $event, bool $isError): array
    {
        if ($event->exception !== null) {
            return self::ofException($event->exception);
        }
        if ($isError && $event->message !== null && $event->message !== '') {
            return [
                'exception.type' => self::DEFAULT_EXCEPTION_TYPE,
                'exception.message' => Text::truncate(Scrub::text($event->message), self::MAX_VALUE_LENGTH),
            ];
        }

        return [];
    }

    private static function bodyOf(Event $event): string
    {
        $exception = $event->exception;
        if ($exception === null) {
            return Scrub::text($event->message ?? '');
        }
        $type = $exception->type !== '' ? $exception->type : self::DEFAULT_EXCEPTION_TYPE;
        $message = Scrub::text($exception->value);

        return $message === '' ? $type : $type . ': ' . $message;
    }

    /**
     * @return array<string, string|int|float|bool>
     */
    private static function metadataOf(Event $event): array
    {
        $metadata = [];
        foreach ($event->tags as $key => $value) {
            self::put($metadata, (string) $key, $value);
        }
        foreach ($event->contexts as $name => $context) {
            if (!is_array($context)) {
                self::put($metadata, (string) $name, $context);
                continue;
            }
            foreach ($context as $key => $value) {
                self::put($metadata, $name . '.' . $key, $value);
            }
        }
        foreach ($event->extra as $key => $value) {
            self::put($metadata, 'extra.' . $key, $value);
        }

        return array_merge($metadata, self::userAttributes($event->user));
    }

    /**
     * @param array<string, mixed>|null $user
     * @return array<string, string|int|float|bool>
     */
    private static function userAttributes(?array $user): array
    {
        $attributes = [];
        if ($user === null) {
            return $attributes;
        }
        $endUser = self::endUserId($user);
        if ($endUser !== null) {
            $attributes['enduser.id'] = $endUser;
        }
        foreach ($user as $key => $value) {
            self::put($attributes, 'user.' . (self::USER_KEYS[$key] ?? $key), $value);
        }

        return $attributes;
    }

    /**
     * @param array<string, mixed>|null $user
     */
    public static function endUserId(?array $user): ?string
    {
        foreach (['id', 'email', 'username'] as $key) {
            $value = $user[$key] ?? null;
            if (is_scalar($value) && $value !== '') {
                return (string) $value;
            }
        }

        return null;
    }
}
