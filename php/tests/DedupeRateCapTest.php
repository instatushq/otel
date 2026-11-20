<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Instatus\Dedupe;
use Instatus\Event;
use Instatus\RateCap;
use LogicException;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class DedupeRateCapTest extends TestCase
{
    private static function failure(string $message): RuntimeException
    {
        return new RuntimeException($message);
    }

    public function testDropsAnErrorIdenticalToTheOneBefore(): void
    {
        $dedupe = new Dedupe();
        $results = [];
        foreach (['boom', 'boom', 'other', 'boom'] as $message) {
            $results[] = $dedupe->isDuplicate(Event::fromThrowable(self::failure($message)));
        }

        self::assertSame([false, true, false, false], $results);
    }

    public function testDifferentTypesOrStacksAreNotDuplicates(): void
    {
        $dedupe = new Dedupe();

        self::assertFalse($dedupe->isDuplicate(Event::fromThrowable(new RuntimeException('boom'))));
        self::assertFalse($dedupe->isDuplicate(Event::fromThrowable(new LogicException('boom'))));
        self::assertFalse($dedupe->isDuplicate(Event::fromThrowable(new LogicException('boom'))), 'a different line is a different stack');
    }

    public function testComparesMessages(): void
    {
        $dedupe = new Dedupe();

        self::assertFalse($dedupe->isDuplicate(Event::fromMessage('hi', 'error')));
        self::assertTrue($dedupe->isDuplicate(Event::fromMessage('hi', 'error')));
    }

    public function testCapsEventsPerWindow(): void
    {
        $now = 1000.0;
        $cap = new RateCap(2, 60.0, static function () use (&$now): float {
            return $now;
        });

        self::assertTrue($cap->take());
        self::assertTrue($cap->take());
        self::assertFalse($cap->take());
        $now += 59.9;
        self::assertFalse($cap->take());
        $now += 0.1;
        self::assertTrue($cap->take());
    }
}
