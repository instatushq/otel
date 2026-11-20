<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Opentelemetry\Proto\Collector\Logs\V1\ExportLogsServiceRequest;
use Opentelemetry\Proto\Collector\Trace\V1\ExportTraceServiceRequest;
use Opentelemetry\Proto\Common\V1\AnyValue;
use Opentelemetry\Proto\Common\V1\KeyValue;
use Opentelemetry\Proto\Logs\V1\LogRecord;
use Opentelemetry\Proto\Trace\V1\Span;
use RuntimeException;

/**
 * A local OTLP endpoint: php -S with a router that saves every request,
 * after waiting $delaySeconds to stand in for a slow collector.
 */
final class StubCollector
{
    public readonly string $url;
    private readonly string $directory;
    /** @var resource */
    private $process;

    public function __construct(float $delaySeconds = 0.0)
    {
        $this->directory = sys_get_temp_dir() . '/instatus-otel-' . bin2hex(random_bytes(6));
        mkdir($this->directory);
        $port = self::freePort();
        $this->url = "http://127.0.0.1:$port";
        $process = proc_open(
            [PHP_BINARY, '-S', "127.0.0.1:$port", __DIR__ . '/Fixtures/stub.php'],
            [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
            null,
            ['STUB_DIR' => $this->directory, 'STUB_DELAY' => (string) $delaySeconds] + getenv()
        );
        if ($process === false) {
            throw new RuntimeException('Could not start the stub collector');
        }
        $this->process = $process;
        $this->waitUntilListening($port);
    }

    public function stop(): void
    {
        proc_terminate($this->process);
        proc_close($this->process);
        foreach (glob($this->directory . '/*') ?: [] as $file) {
            unlink($file);
        }
        rmdir($this->directory);
    }

    /**
     * @return list<array{path: string, headers: array<string, string>, body: string}>
     */
    public function requests(): array
    {
        $files = glob($this->directory . '/*.json') ?: [];
        sort($files);
        $requests = [];
        foreach ($files as $file) {
            $request = json_decode((string) file_get_contents($file), true, flags: JSON_THROW_ON_ERROR);
            $request['body'] = base64_decode($request['body'], true);
            $requests[] = $request;
        }

        return $requests;
    }

    /**
     * @return list<array{path: string, headers: array<string, string>, body: string}>
     */
    public function requestsTo(string $path): array
    {
        return array_values(array_filter($this->requests(), static fn (array $request): bool => $request['path'] === $path));
    }

    /**
     * @return list<array{record: LogRecord, scope: string, resource: array<string, mixed>}>
     */
    public function logRecords(): array
    {
        $records = [];
        foreach ($this->requestsTo('/v1/logs') as $request) {
            $export = new ExportLogsServiceRequest();
            $export->mergeFromString($request['body']);
            foreach ($export->getResourceLogs() as $resourceLogs) {
                $resource = self::attributes($resourceLogs->getResource()?->getAttributes());
                foreach ($resourceLogs->getScopeLogs() as $scopeLogs) {
                    foreach ($scopeLogs->getLogRecords() as $record) {
                        $records[] = ['record' => $record, 'scope' => (string) $scopeLogs->getScope()?->getName(), 'resource' => $resource];
                    }
                }
            }
        }

        return $records;
    }

    /**
     * @return list<Span>
     */
    public function spans(): array
    {
        $spans = [];
        foreach ($this->requestsTo('/v1/traces') as $request) {
            $export = new ExportTraceServiceRequest();
            $export->mergeFromString($request['body']);
            foreach ($export->getResourceSpans() as $resourceSpans) {
                foreach ($resourceSpans->getScopeSpans() as $scopeSpans) {
                    foreach ($scopeSpans->getSpans() as $span) {
                        $spans[] = $span;
                    }
                }
            }
        }

        return $spans;
    }

    /**
     * @param iterable<KeyValue>|null $attributes
     * @return array<string, mixed>
     */
    public static function attributes(?iterable $attributes): array
    {
        $values = [];
        foreach ($attributes ?? [] as $attribute) {
            $values[$attribute->getKey()] = self::valueOf($attribute->getValue());
        }

        return $values;
    }

    private static function valueOf(?AnyValue $value): mixed
    {
        return match ($value?->getValue()) {
            'string_value' => $value->getStringValue(),
            'bool_value' => $value->getBoolValue(),
            'int_value' => (int) $value->getIntValue(),
            'double_value' => $value->getDoubleValue(),
            default => null,
        };
    }

    private static function freePort(): int
    {
        $server = stream_socket_server('tcp://127.0.0.1:0');
        if ($server === false) {
            throw new RuntimeException('No free port');
        }
        $name = (string) stream_socket_get_name($server, false);
        fclose($server);

        return (int) substr($name, strrpos($name, ':') + 1);
    }

    private function waitUntilListening(int $port): void
    {
        $deadline = microtime(true) + 10;
        while (microtime(true) < $deadline) {
            $socket = @fsockopen('127.0.0.1', $port, $code, $message, 0.1);
            if ($socket !== false) {
                fclose($socket);

                return;
            }
            usleep(50_000);
        }
        throw new RuntimeException('The stub collector did not start');
    }
}
