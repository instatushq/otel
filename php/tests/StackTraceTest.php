<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Instatus\StackTrace;
use PHPUnit\Framework\TestCase;
use RuntimeException;

final class StackTraceTest extends TestCase
{
    private static int $line = 0;

    private static function place(): RuntimeException
    {
        self::$line = __LINE__ + 1;
        return new RuntimeException('declined');
    }

    public function testStartsWithTheThrowingLineThenPhpsOwnTrace(): void
    {
        $callLine = __LINE__ + 1;
        $error = self::place();

        $stack = StackTrace::of($error);
        $frames = BackendStack::frames($stack);

        self::assertSame('php', BackendStack::language($stack));
        self::assertSame(['file' => __FILE__, 'line' => self::$line, 'fn' => StackTraceTest::class . '::place()'], $frames[0]);
        self::assertSame(['file' => __FILE__, 'line' => $callLine, 'fn' => StackTraceTest::class . '::place()'], $frames[1]);
        self::assertStringEndsWith('{main}', $stack);

        $expectedRest = preg_replace_callback('/^#(\d+) /m', static fn (array $m): string => '#' . ((int) $m[1] + 1) . ' ', $error->getTraceAsString());
        self::assertSame($expectedRest, substr($stack, strpos($stack, "\n") + 1));
    }

    public function testATopLevelThrowStillHasAFrame(): void
    {
        $stack = StackTrace::ofLocation('/var/www/app/index.php', 12);

        self::assertSame('php', BackendStack::language($stack));
        self::assertSame([['file' => '/var/www/app/index.php', 'line' => 12, 'fn' => '{main}']], BackendStack::frames($stack));
    }

    public function testNamesAnonymousClassesAsPhpPrintsThem(): void
    {
        $error = new class ('boom') extends RuntimeException {
        };

        self::assertSame('RuntimeException@anonymous', StackTrace::typeOf($error));
        self::assertSame(RuntimeException::class, StackTrace::typeOf(new RuntimeException()));
    }
}
