<?php

declare(strict_types=1);

namespace Instatus;

use OpenTelemetry\API\Common\Time\Clock;
use OpenTelemetry\Contrib\Otlp\ContentTypes;
use OpenTelemetry\Contrib\Otlp\LogsExporter;
use OpenTelemetry\Contrib\Otlp\LogsExporterFactory;
use OpenTelemetry\Contrib\Otlp\MetricExporter;
use OpenTelemetry\Contrib\Otlp\MetricExporterFactory;
use OpenTelemetry\Contrib\Otlp\SpanExporter;
use OpenTelemetry\Contrib\Otlp\SpanExporterFactory;
use OpenTelemetry\SDK\Common\Export\Http\PsrTransportFactory;
use OpenTelemetry\SDK\Common\Export\TransportInterface;
use OpenTelemetry\SDK\Logs\LoggerProvider;
use OpenTelemetry\SDK\Logs\LoggerProviderInterface;
use OpenTelemetry\SDK\Logs\Processor\BatchLogRecordProcessor;
use OpenTelemetry\SDK\Metrics\MeterProvider;
use OpenTelemetry\SDK\Metrics\MeterProviderInterface;
use OpenTelemetry\SDK\Metrics\MetricReader\ExportingReader;
use OpenTelemetry\SDK\Resource\ResourceInfo;
use OpenTelemetry\SDK\Trace\Sampler\ParentBased;
use OpenTelemetry\SDK\Trace\Sampler\TraceIdRatioBasedSampler;
use OpenTelemetry\SDK\Trace\SpanProcessor\BatchSpanProcessor;
use OpenTelemetry\SDK\Trace\TracerProvider;
use OpenTelemetry\SDK\Trace\TracerProviderInterface;

/**
 * PHP has no background threads, so the batch processors export when a
 * batch fills and otherwise once, when the request or script ends.
 *
 * The OTel SDK takes a cancellation in forceFlush and shutdown but never
 * passes it to the export requests, so a flush or close bounds its time with a
 * deadline that the exporters' HTTP client reads instead.
 */
final class Providers
{
    private const EXPORT_TIMEOUT_SECONDS = 5.0;

    public function __construct(
        public readonly TracerProviderInterface $tracer,
        public readonly LoggerProviderInterface $logger,
        public readonly ?MeterProviderInterface $meter,
        private readonly Deadline $deadline,
    ) {
    }

    /**
     * @param array<string, SignalExport> $exports
     */
    public static function create(Options $options, array $exports, ResourceInfo $resource): self
    {
        $deadline = new Deadline();
        $meter = isset($exports['metrics']) ? self::meterProvider($resource, $exports['metrics'], $deadline) : null;

        return new self(
            self::tracerProvider($options, $resource, $exports['traces'] ?? null, $deadline),
            self::loggerProvider($resource, $exports['logs'] ?? null, $deadline),
            $meter,
            $deadline,
        );
    }

    public function forceFlush(float $timeout): bool
    {
        return $this->withinDeadline($timeout, [
            fn (): bool => $this->logger->forceFlush(),
            fn (): bool => $this->tracer->forceFlush(),
            fn (): bool => $this->meter?->forceFlush() ?? true,
        ]);
    }

    public function shutdown(float $timeout): bool
    {
        return $this->withinDeadline($timeout, [
            fn (): bool => $this->logger->shutdown(),
            fn (): bool => $this->tracer->shutdown(),
            fn (): bool => $this->meter?->shutdown() ?? true,
        ]);
    }

    /**
     * Logs go first because errors are log records. A signal whose turn
     * comes after the deadline is skipped.
     *
     * @param list<callable(): bool> $signals
     */
    private function withinDeadline(float $timeout, array $signals): bool
    {
        $this->deadline->start($timeout);
        $succeeded = true;
        try {
            foreach ($signals as $signal) {
                if ($this->deadline->passed() || !$signal()) {
                    $succeeded = false;
                }
            }
        } finally {
            $this->deadline->clear();
        }

        return $succeeded;
    }

    private static function tracerProvider(Options $options, ResourceInfo $resource, ?SignalExport $target, Deadline $deadline): TracerProviderInterface
    {
        $processors = $options->spanProcessors;
        if ($target !== null) {
            $exporter = $target->url === null
                ? (new SpanExporterFactory())->create()
                : new SpanExporter(self::transport($target, $deadline));
            $processors[] = new BatchSpanProcessor($exporter, Clock::getDefault());
        }

        return new TracerProvider(
            $processors,
            new ParentBased(new TraceIdRatioBasedSampler($options->tracesSampleRate)),
            $resource
        );
    }

    private static function loggerProvider(ResourceInfo $resource, ?SignalExport $target, Deadline $deadline): LoggerProviderInterface
    {
        $builder = LoggerProvider::builder()->setResource($resource);
        if ($target !== null) {
            $exporter = $target->url === null
                ? (new LogsExporterFactory())->create()
                : new LogsExporter(self::transport($target, $deadline));
            $builder->addLogRecordProcessor(new BatchLogRecordProcessor($exporter, Clock::getDefault()));
        }

        return $builder->build();
    }

    private static function meterProvider(ResourceInfo $resource, SignalExport $target, Deadline $deadline): MeterProviderInterface
    {
        $exporter = $target->url === null
            ? (new MetricExporterFactory())->create()
            : new MetricExporter(self::transport($target, $deadline));

        return MeterProvider::builder()
            ->setResource($resource)
            ->addReader(new ExportingReader($exporter))
            ->build();
    }

    /**
     * @return TransportInterface<'application/x-protobuf'>
     */
    private static function transport(SignalExport $target, Deadline $deadline): TransportInterface
    {
        return (new PsrTransportFactory(new DeadlineClient($deadline, self::EXPORT_TIMEOUT_SECONDS)))->create(
            (string) $target->url,
            ContentTypes::PROTOBUF,
            $target->headers,
            function_exists('gzencode') ? 'gzip' : null
        );
    }
}
