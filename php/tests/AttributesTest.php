<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Instatus\Attributes;
use Instatus\Event;
use Instatus\ExceptionData;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class AttributesTest extends TestCase
{
    public function testMapsAnExceptionToAnErrorRecord(): void
    {
        $line = __LINE__ + 1;
        $error = new RuntimeException('Card 4242 4242 4242 4242 declined');
        $record = Attributes::toLogRecord(Event::fromThrowable($error));

        self::assertSame(17, $record->severityNumber);
        self::assertSame('ERROR', $record->severityText);
        self::assertSame('RuntimeException: Card [Filtered] declined', $record->body);
        self::assertSame('RuntimeException', $record->attributes['exception.type']);
        self::assertSame('Card [Filtered] declined', $record->attributes['exception.message']);
        self::assertTrue($record->attributes['exception.handled']);
        self::assertStringStartsWith('#0 ' . __FILE__ . '(' . $line . '): ', (string) $record->attributes['exception.stacktrace']);
        self::assertMatchesRegularExpression('/^[0-9a-f]{32}$/', (string) $record->attributes['log.record.uid']);
        self::assertGreaterThan(1_600_000_000 * 1_000_000_000, $record->timestampNanos);
    }

    /**
     * @return iterable<string, array{string, int, string}>
     */
    public static function levels(): iterable
    {
        yield 'fatal' => ['fatal', 21, 'FATAL'];
        yield 'error' => ['error', 17, 'ERROR'];
        yield 'warning' => ['warning', 13, 'WARN'];
        yield 'info' => ['info', 9, 'INFO'];
        yield 'log' => ['log', 9, 'INFO'];
        yield 'debug' => ['debug', 5, 'DEBUG'];
        yield 'unknown' => ['loud', 17, 'ERROR'];
    }

    #[DataProvider('levels')]
    public function testMapsSentryLevels(string $level, int $number, string $text): void
    {
        $record = Attributes::toLogRecord(Event::fromMessage('hello', $level));

        self::assertSame($number, $record->severityNumber);
        self::assertSame($text, $record->severityText);
    }

    public function testErrorMessagesAreIssuesAndLowerLevelsArePlainLogs(): void
    {
        $error = Attributes::toLogRecord(Event::fromMessage('Webhook signature mismatch', 'error'));
        $info = Attributes::toLogRecord(Event::fromMessage('Deployed', 'info'));

        self::assertSame('Webhook signature mismatch', $error->body);
        self::assertSame('Error', $error->attributes['exception.type']);
        self::assertSame('Webhook signature mismatch', $error->attributes['exception.message']);
        self::assertArrayNotHasKey('exception.type', $info->attributes);
        self::assertSame('Deployed', $info->body);
    }

    public function testFlattensScopeMetadata(): void
    {
        $event = Event::fromMessage('hi', 'info');
        $event->user = ['id' => 42, 'email' => 'ada@example.com', 'username' => 'ada', 'ip_address' => '10.0.0.1'];
        $event->tags = ['plan' => 'pro', 'instatus.internal' => 'x', 'exception.type' => 'Spoofed'];
        $event->contexts = ['cart' => ['items' => 3, 'currency' => 'EUR'], 'region' => 'eu'];
        $event->extra = ['retry' => 2, 'payload' => ['password' => 'hunter2', 'ok' => true]];

        $attributes = Attributes::toLogRecord($event)->attributes;

        self::assertSame('42', $attributes['enduser.id']);
        self::assertSame(42, $attributes['user.id']);
        self::assertSame('ada@example.com', $attributes['user.email']);
        self::assertSame('ada', $attributes['user.name']);
        self::assertSame('10.0.0.1', $attributes['user.ip']);
        self::assertSame('pro', $attributes['plan']);
        self::assertSame(3, $attributes['cart.items']);
        self::assertSame('EUR', $attributes['cart.currency']);
        self::assertSame('eu', $attributes['region']);
        self::assertSame(2, $attributes['extra.retry']);
        self::assertSame('{"password":"[Filtered]","ok":true}', $attributes['extra.payload']);
        self::assertSame('Spoofed', $attributes['exception.type'], 'a plain log has no exception fields to protect');
        self::assertArrayNotHasKey('instatus.internal', $attributes);
    }

    public function testErrorFieldsWinOverMetadata(): void
    {
        $event = Event::fromThrowable(new RuntimeException('boom'));
        $event->tags = ['exception.type' => 'Spoofed', 'log.record.uid' => 'nope'];

        $attributes = Attributes::toLogRecord($event)->attributes;

        self::assertSame('RuntimeException', $attributes['exception.type']);
        self::assertSame($event->eventId, $attributes['log.record.uid']);
    }

    public function testEndUserFallsBackToEmailThenUsername(): void
    {
        $byEmail = Event::fromMessage('hi', 'info');
        $byEmail->user = ['email' => 'ada@example.com'];
        $byName = Event::fromMessage('hi', 'info');
        $byName->user = ['username' => 'ada'];

        self::assertSame('ada@example.com', Attributes::toLogRecord($byEmail)->attributes['enduser.id']);
        self::assertSame('ada', Attributes::toLogRecord($byName)->attributes['enduser.id']);
    }

    public function testCutsLongValuesAndStacks(): void
    {
        $event = new Event(Event::generateId(), microtime(true), 'error', exception: new ExceptionData(
            'RuntimeException',
            str_repeat('m', 9000),
            '#0 ' . str_repeat('s', 40000)
        ));
        $event->extra = ['blob' => str_repeat('x', 9000)];

        $attributes = Attributes::toLogRecord($event)->attributes;

        self::assertSame(8192, strlen((string) $attributes['exception.message']));
        self::assertSame(32000, strlen((string) $attributes['exception.stacktrace']));
        self::assertSame(8192, strlen((string) $attributes['extra.blob']));
    }

    public function testUncaughtErrorsAreUnhandled(): void
    {
        $record = Attributes::toLogRecord(Event::fromThrowable(new RuntimeException('boom'), handled: false));

        self::assertFalse($record->attributes['exception.handled']);
    }
}
