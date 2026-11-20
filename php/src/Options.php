<?php

declare(strict_types=1);

namespace Instatus;

use Closure;
use InvalidArgumentException;
use OpenTelemetry\SDK\Trace\SpanProcessorInterface;

final class Options
{
    public const DEFAULT_MAX_EVENTS_PER_MINUTE = 300;
    public const DEFAULT_SHUTDOWN_TIMEOUT = 2.0;

    private const KEYS = [
        'api_key', 'site_id', 'service_name', 'release', 'environment', 'endpoint',
        'traces_sample_rate', 'sample_rate', 'before_send', 'ignore_exceptions',
        'max_events_per_minute', 'enabled', 'default_integrations', 'span_processors',
        'shutdown_timeout', 'finish_request',
    ];

    /**
     * @param (Closure(Event, ?\Throwable): ?Event)|null $beforeSend
     * @param list<class-string<\Throwable>> $ignoreExceptions
     * @param list<SpanProcessorInterface> $spanProcessors
     */
    public function __construct(
        public readonly ?string $apiKey = null,
        public readonly ?string $siteId = null,
        public readonly ?string $serviceName = null,
        public readonly ?string $release = null,
        public readonly ?string $environment = null,
        public readonly ?string $endpoint = null,
        public readonly float $tracesSampleRate = 1.0,
        public readonly float $sampleRate = 1.0,
        public readonly ?Closure $beforeSend = null,
        public readonly array $ignoreExceptions = [],
        public readonly int $maxEventsPerMinute = self::DEFAULT_MAX_EVENTS_PER_MINUTE,
        public readonly bool $enabled = true,
        public readonly bool $defaultIntegrations = true,
        public readonly array $spanProcessors = [],
        public readonly float $shutdownTimeout = self::DEFAULT_SHUTDOWN_TIMEOUT,
        public readonly bool $finishRequest = true,
    ) {
    }

    /**
     * @param array<string, mixed> $options
     * @return list<string>
     */
    public static function unknownKeys(array $options): array
    {
        return array_values(array_diff(array_map('strval', array_keys($options)), self::KEYS));
    }

    /**
     * @param array<string, mixed> $options
     * @param (Closure(string): ?string)|null $env
     */
    public static function fromArray(array $options, ?Closure $env = null): self
    {
        $env ??= Env::get(...);
        $beforeSend = $options['before_send'] ?? null;
        if ($beforeSend !== null && !is_callable($beforeSend)) {
            throw new InvalidArgumentException('before_send must be callable');
        }

        return new self(
            apiKey: self::string($options, 'api_key') ?? $env('INSTATUS_API_KEY'),
            siteId: self::string($options, 'site_id') ?? $env('INSTATUS_SITE_ID'),
            serviceName: self::string($options, 'service_name') ?? $env('OTEL_SERVICE_NAME'),
            release: self::string($options, 'release'),
            environment: self::string($options, 'environment'),
            endpoint: self::string($options, 'endpoint'),
            tracesSampleRate: self::rate($options, 'traces_sample_rate'),
            sampleRate: self::rate($options, 'sample_rate'),
            beforeSend: $beforeSend === null ? null : Closure::fromCallable($beforeSend),
            ignoreExceptions: array_values((array) ($options['ignore_exceptions'] ?? [])),
            maxEventsPerMinute: (int) ($options['max_events_per_minute'] ?? self::DEFAULT_MAX_EVENTS_PER_MINUTE),
            enabled: (bool) ($options['enabled'] ?? true),
            defaultIntegrations: (bool) ($options['default_integrations'] ?? true),
            spanProcessors: array_values((array) ($options['span_processors'] ?? [])),
            shutdownTimeout: (float) ($options['shutdown_timeout'] ?? self::DEFAULT_SHUTDOWN_TIMEOUT),
            finishRequest: (bool) ($options['finish_request'] ?? true),
        );
    }

    /**
     * @param array<string, mixed> $options
     */
    private static function string(array $options, string $key): ?string
    {
        $value = $options[$key] ?? null;
        if ($value === null || $value === '') {
            return null;
        }
        if (!is_scalar($value)) {
            throw new InvalidArgumentException("$key must be a string");
        }

        return (string) $value;
    }

    /**
     * @param array<string, mixed> $options
     */
    private static function rate(array $options, string $key): float
    {
        $value = $options[$key] ?? 1.0;
        if (!is_int($value) && !is_float($value)) {
            throw new InvalidArgumentException("$key must be a number from 0 to 1");
        }

        return max(0.0, min(1.0, (float) $value));
    }
}
