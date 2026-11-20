<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Instatus\Client;
use Instatus\Event;
use Instatus\Options;
use Instatus\RateCap;
use InvalidArgumentException;
use LogicException;
use OpenTelemetry\API\Trace\StatusCode;
use OpenTelemetry\SDK\Logs\Exporter\InMemoryExporter as InMemoryLogExporter;
use OpenTelemetry\SDK\Logs\LoggerProvider;
use OpenTelemetry\SDK\Logs\Processor\SimpleLogRecordProcessor;
use OpenTelemetry\SDK\Logs\ReadableLogRecord;
use OpenTelemetry\SDK\Trace\SpanExporter\InMemoryExporter as InMemorySpanExporter;
use OpenTelemetry\SDK\Trace\SpanProcessor\SimpleSpanProcessor;
use OpenTelemetry\SDK\Trace\TracerProvider;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class ClientTest extends TestCase
{
    private InMemoryLogExporter $logs;

    /**
     * @param array<string, mixed> $options
     */
    private function client(array $options = [], ?RateCap $rateCap = null): Client
    {
        $this->logs = new InMemoryLogExporter();
        $provider = LoggerProvider::builder()
            ->addLogRecordProcessor(new SimpleLogRecordProcessor($this->logs))
            ->build();

        return new Client(
            Options::fromArray($options, static fn (string $name): ?string => null),
            $provider->getLogger('test'),
            $rateCap
        );
    }

    /**
     * @return list<ReadableLogRecord>
     */
    private function records(): array
    {
        /** @var list<ReadableLogRecord> $records */
        $records = array_values($this->logs->getStorage()->getArrayCopy());

        return $records;
    }

    public function testEmitsTheRecordWithReleaseAndEnvironmentOnTheEvent(): void
    {
        $seen = null;
        $client = $this->client([
            'release' => 'shop@1.0.0',
            'environment' => 'production',
            'before_send' => static function (Event $event) use (&$seen): Event {
                $seen = $event;

                return $event;
            },
        ]);

        $id = $client->captureEvent(Event::fromThrowable(new RuntimeException('boom')));

        $records = $this->records();
        self::assertCount(1, $records);
        self::assertSame('RuntimeException: boom', $records[0]->getBody());
        self::assertSame(17, $records[0]->getSeverityNumber());
        self::assertSame($id, $records[0]->getAttributes()->get('log.record.uid'));
        self::assertInstanceOf(Event::class, $seen);
        self::assertSame('shop@1.0.0', $seen->release);
        self::assertSame('production', $seen->environment);
    }

    public function testBeforeSendCanChangeTheEvent(): void
    {
        $client = $this->client(['before_send' => static function (Event $event, ?\Throwable $error): Event {
            $event->tags['caught'] = $error === null ? 'no' : $error::class;
            if ($event->exception !== null) {
                $event->exception->value = 'rewritten';
            }

            return $event;
        }]);
        $error = new RuntimeException('boom');

        $client->captureEvent(Event::fromThrowable($error), $error);

        $attributes = $this->records()[0]->getAttributes();
        self::assertSame('RuntimeException', $attributes->get('caught'));
        self::assertSame('rewritten', $attributes->get('exception.message'));
    }

    public function testBeforeSendCanDropTheEvent(): void
    {
        $client = $this->client(['before_send' => static fn (): ?Event => null]);

        $client->captureEvent(Event::fromThrowable(new RuntimeException('boom')));

        self::assertSame([], $this->records());
    }

    public function testABeforeSendThatThrowsDropsTheEventQuietly(): void
    {
        $client = $this->client(['before_send' => static function (): never {
            throw new LogicException('bug in the hook');
        }]);

        $id = $client->captureEvent(Event::fromThrowable(new RuntimeException('boom')));

        self::assertSame([], $this->records());
        self::assertMatchesRegularExpression('/^[0-9a-f]{32}$/', $id);
    }

    public function testTheSameThrowableIsSentOnce(): void
    {
        $client = $this->client();
        $error = new RuntimeException('boom');

        $client->captureEvent(Event::fromThrowable($error), $error);
        $client->captureEvent(Event::fromThrowable($error), $error);

        self::assertCount(1, $this->records());
    }

    public function testIdenticalErrorsInARowAreSentOnce(): void
    {
        $client = $this->client();

        foreach (['boom', 'boom', 'between', 'boom'] as $message) {
            $client->captureEvent(Event::fromThrowable(new RuntimeException($message)));
        }

        self::assertCount(3, $this->records());
    }

    public function testCapsErrorsPerMinute(): void
    {
        $client = $this->client([], new RateCap(2, 60.0, static fn (): float => 0.0));

        foreach (['a', 'b', 'c'] as $message) {
            $client->captureEvent(Event::fromMessage($message, 'error'));
        }

        self::assertCount(2, $this->records());
    }

    public function testMaxEventsPerMinuteOption(): void
    {
        $client = $this->client(['max_events_per_minute' => 1]);

        $client->captureEvent(Event::fromMessage('a', 'error'));
        $client->captureEvent(Event::fromMessage('b', 'error'));

        self::assertCount(1, $this->records());
    }

    public function testDisabledSendsNothing(): void
    {
        $client = $this->client(['enabled' => false]);

        $client->captureEvent(Event::fromMessage('a', 'error'));

        self::assertSame([], $this->records());
    }

    public function testIgnoresListedExceptionClasses(): void
    {
        $client = $this->client(['ignore_exceptions' => [InvalidArgumentException::class]]);
        $ignored = new InvalidArgumentException('bad input');
        $kept = new RuntimeException('boom');

        $client->captureEvent(Event::fromThrowable($ignored), $ignored);
        $client->captureEvent(Event::fromThrowable($kept), $kept);

        self::assertCount(1, $this->records());
    }

    public function testRecordsTheErrorOnTheActiveSpan(): void
    {
        $client = $this->client();
        $spans = new InMemorySpanExporter();
        $tracer = (new TracerProvider(new SimpleSpanProcessor($spans)))->getTracer('test');

        $span = $tracer->spanBuilder('checkout')->startSpan();
        $scope = $span->activate();
        $client->captureEvent(Event::fromThrowable(new RuntimeException('card 4242424242424242 declined')));
        $scope->detach();
        $span->end();

        $exported = $spans->getSpans()[0];
        $event = $exported->getEvents()[0];
        self::assertSame('exception', $event->getName());
        self::assertSame('RuntimeException', $event->getAttributes()->get('exception.type'));
        self::assertSame('card [Filtered] declined', $event->getAttributes()->get('exception.message'));
        self::assertStringStartsWith('#0 ', (string) $event->getAttributes()->get('exception.stacktrace'));
        self::assertSame(StatusCode::STATUS_UNSET, $exported->getStatus()->getCode());

        $record = $this->records()[0];
        self::assertSame($exported->getTraceId(), $record->getSpanContext()?->getTraceId());
        self::assertSame($exported->getSpanId(), $record->getSpanContext()?->getSpanId());
    }
}
