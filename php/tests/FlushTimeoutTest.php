<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Instatus\Sdk;
use OpenTelemetry\API\Trace\SpanInterface;
use PHPUnit\Framework\TestCase;

use function Instatus\captureMessage;
use function Instatus\close;
use function Instatus\flush;
use function Instatus\init;
use function Instatus\logger;
use function Instatus\startSpan;

final class FlushTimeoutTest extends TestCase
{
    private StubCollector $collector;
    private string|false $errorLog = false;

    protected function setUp(): void
    {
        $this->errorLog = ini_set('error_log', '/dev/null');
        $this->collector = new StubCollector(delaySeconds: 10.0);
        init([
            'api_key' => 'sk_test',
            'endpoint' => $this->collector->url,
            'default_integrations' => false,
        ]);
    }

    protected function tearDown(): void
    {
        Sdk::reset();
        $this->collector->stop();
        ini_set('error_log', (string) $this->errorLog);
    }

    private static function queueEverySignal(): void
    {
        startSpan('checkout', static function (SpanInterface $span): void {
            captureMessage('Payment failed', 'error');
            logger()->info('Retrying');
        });
    }

    public function testFlushReturnsWithinItsTimeoutWhenTheCollectorHangs(): void
    {
        self::queueEverySignal();

        $startedAt = microtime(true);
        $flushed = flush(0.5);
        $elapsed = microtime(true) - $startedAt;

        self::assertFalse($flushed);
        self::assertLessThan(1.5, $elapsed);
    }

    public function testCloseReturnsWithinItsTimeoutWhenTheCollectorHangs(): void
    {
        self::queueEverySignal();

        $startedAt = microtime(true);
        $closed = close(0.5);
        $elapsed = microtime(true) - $startedAt;

        self::assertFalse($closed);
        self::assertLessThan(1.5, $elapsed);
    }
}
