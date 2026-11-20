<?php

declare(strict_types=1);

namespace Instatus;

use Closure;

final class Exports
{
    public const DEFAULT_ENDPOINT = 'https://otel.instatus.com';
    public const SIGNALS = ['logs', 'traces', 'metrics'];

    /**
     * An API key sends every signal to the collector. Without one, each
     * signal with an OTEL_EXPORTER_OTLP_* endpoint exports there, configured
     * by the OTel SDK from those variables (a null url).
     *
     * @param (Closure(string): ?string)|null $env
     * @return array<string, SignalExport>
     */
    public static function resolve(Options $options, ?Closure $env = null): array
    {
        $env ??= Env::get(...);
        if ($options->apiKey !== null) {
            $headers = ['Authorization' => 'Bearer ' . $options->apiKey];
            if ($options->siteId !== null) {
                $headers['X-Instatus-Site-Id'] = $options->siteId;
            }

            return self::everySignal(static fn (string $signal): SignalExport => new SignalExport(
                self::urlFor($options, $env, $signal),
                $headers
            ));
        }
        if ($options->endpoint !== null) {
            return self::everySignal(static fn (string $signal): SignalExport => new SignalExport(
                self::signalUrl($options->endpoint, $signal)
            ));
        }
        $exports = [];
        foreach (self::SIGNALS as $signal) {
            if (self::hasEnvEndpoint($env, $signal)) {
                $exports[$signal] = new SignalExport(null);
            }
        }

        return $exports;
    }

    public static function signalUrl(string $endpoint, string $signal): string
    {
        return rtrim($endpoint, '/') . '/v1/' . $signal;
    }

    /**
     * The key's headers go wherever the endpoint is, including one set
     * through OTEL_EXPORTER_OTLP_*.
     *
     * @param Closure(string): ?string $env
     */
    private static function urlFor(Options $options, Closure $env, string $signal): string
    {
        if ($options->endpoint !== null) {
            return self::signalUrl($options->endpoint, $signal);
        }
        $signalEndpoint = $env('OTEL_EXPORTER_OTLP_' . strtoupper($signal) . '_ENDPOINT');
        if ($signalEndpoint !== null) {
            return $signalEndpoint;
        }

        return self::signalUrl($env('OTEL_EXPORTER_OTLP_ENDPOINT') ?? self::DEFAULT_ENDPOINT, $signal);
    }

    /**
     * @param Closure(string): ?string $env
     */
    private static function hasEnvEndpoint(Closure $env, string $signal): bool
    {
        return $env('OTEL_EXPORTER_OTLP_' . strtoupper($signal) . '_ENDPOINT') !== null
            || $env('OTEL_EXPORTER_OTLP_ENDPOINT') !== null;
    }

    /**
     * @param Closure(string): SignalExport $build
     * @return array<string, SignalExport>
     */
    private static function everySignal(Closure $build): array
    {
        $exports = [];
        foreach (self::SIGNALS as $signal) {
            $exports[$signal] = $build($signal);
        }

        return $exports;
    }
}
