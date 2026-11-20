<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Instatus\Logging\MonologHandler;
use Instatus\Scope;
use Instatus\Sdk;
use Monolog\Logger;
use OpenTelemetry\API\Trace\SpanInterface;
use PHPUnit\Framework\TestCase;
use RuntimeException;

use function Instatus\captureException;
use function Instatus\captureMessage;
use function Instatus\flush;
use function Instatus\init;
use function Instatus\logger;
use function Instatus\setContext;
use function Instatus\setExtra;
use function Instatus\setTag;
use function Instatus\setUser;
use function Instatus\startSpan;
use function Instatus\withScope;

final class EndToEndTest extends TestCase
{
    private StubCollector $collector;

    protected function setUp(): void
    {
        $this->collector = new StubCollector();
    }

    protected function tearDown(): void
    {
        Sdk::reset();
        $this->collector->stop();
    }

    private function init(): void
    {
        init([
            'api_key' => 'sk_test',
            'site_id' => 'site_1',
            'endpoint' => $this->collector->url,
            'service_name' => 'checkout',
            'release' => 'shop@1.4.0',
            'environment' => 'test',
            'default_integrations' => false,
        ]);
    }

    public function testExportsAnErrorAndItsSpanOverOtlpProtobuf(): void
    {
        $this->init();
        setUser(['id' => 'user_42', 'email' => 'ada@example.com']);
        setTag('plan', 'pro');
        setContext('cart', ['items' => 3]);
        setExtra('payload', ['password' => 'hunter2']);

        $throwLine = 0;
        $eventId = startSpan('checkout', static function (SpanInterface $span) use (&$throwLine): string {
            try {
                $throwLine = __LINE__ + 1;
                throw new RuntimeException('Card 4242 4242 4242 4242 declined');
            } catch (RuntimeException $error) {
                return captureException($error, ['tags' => ['step' => 'charge']]);
            }
        });

        self::assertTrue(flush());

        $logs = $this->collector->requestsTo('/v1/logs');
        $traces = $this->collector->requestsTo('/v1/traces');
        self::assertCount(1, $logs);
        self::assertCount(1, $traces);
        foreach ([$logs[0], $traces[0]] as $request) {
            self::assertSame('Bearer sk_test', $request['headers']['authorization']);
            self::assertSame('site_1', $request['headers']['x-instatus-site-id']);
            self::assertSame('application/x-protobuf', $request['headers']['content-type']);
        }

        [$entry] = $this->collector->logRecords();
        $record = $entry['record'];
        $attributes = StubCollector::attributes($record->getAttributes());
        self::assertSame('instatus/otel', $entry['scope']);
        self::assertSame('RuntimeException: Card [Filtered] declined', $record->getBody()?->getStringValue());
        self::assertSame(17, $record->getSeverityNumber());
        self::assertSame('ERROR', $record->getSeverityText());
        self::assertSame('RuntimeException', $attributes['exception.type']);
        self::assertSame('Card [Filtered] declined', $attributes['exception.message']);
        self::assertTrue($attributes['exception.handled']);
        self::assertSame($eventId, $attributes['log.record.uid']);
        self::assertSame('user_42', $attributes['enduser.id']);
        self::assertSame('ada@example.com', $attributes['user.email']);
        self::assertSame('pro', $attributes['plan']);
        self::assertSame('charge', $attributes['step']);
        self::assertSame(3, $attributes['cart.items']);
        self::assertSame('{"password":"[Filtered]"}', $attributes['extra.payload']);

        $stack = (string) $attributes['exception.stacktrace'];
        self::assertSame('php', BackendStack::language($stack));
        $frames = BackendStack::frames($stack);
        self::assertSame(__FILE__, $frames[0]['file']);
        self::assertSame($throwLine, $frames[0]['line']);

        self::assertSame('checkout', $entry['resource']['service.name']);
        self::assertSame('shop@1.4.0', $entry['resource']['service.version']);
        self::assertSame('test', $entry['resource']['deployment.environment.name']);
        self::assertSame('instatus/otel', $entry['resource']['telemetry.sdk.name']);
        self::assertSame('php', $entry['resource']['telemetry.sdk.language']);
        self::assertArrayHasKey('host.name', $entry['resource']);
        self::assertArrayHasKey('process.pid', $entry['resource']);

        [$span] = $this->collector->spans();
        self::assertSame('checkout', $span->getName());
        self::assertSame(bin2hex($span->getTraceId()), bin2hex($record->getTraceId()));
        self::assertSame(bin2hex($span->getSpanId()), bin2hex($record->getSpanId()));
        self::assertSame(0, $span->getStatus()?->getCode() ?? 0);
        $spanEvent = $span->getEvents()[0];
        self::assertSame('exception', $spanEvent->getName());
        self::assertSame('Card [Filtered] declined', StubCollector::attributes($spanEvent->getAttributes())['exception.message']);
    }

    public function testMessagesScopesAndLoggersReachLogs(): void
    {
        $this->init();
        withScope(static function (Scope $scope): void {
            $scope->setTag('job', 'nightly');
            captureMessage('Stripe webhook signature mismatch', 'error');
        });
        captureMessage('Deployed', 'info');
        logger('billing')->warning('Retrying charge {charge} for {email}', [
            'charge' => 'ch_1',
            'email' => 'ada@example.com',
            'api_key' => 'sk_live_secret',
            'exception' => new RuntimeException('Gateway timeout'),
        ]);
        $monolog = new Logger('orders');
        $monolog->pushHandler(new MonologHandler());
        $monolog->error('Order {id} failed', ['id' => 7]);

        self::assertTrue(flush());

        $byBody = [];
        foreach ($this->collector->logRecords() as $entry) {
            $byBody[(string) $entry['record']->getBody()?->getStringValue()] = $entry;
        }

        $issue = StubCollector::attributes($byBody['Stripe webhook signature mismatch']['record']->getAttributes());
        self::assertSame('Error', $issue['exception.type']);
        self::assertSame('nightly', $issue['job']);
        self::assertSame(17, $byBody['Stripe webhook signature mismatch']['record']->getSeverityNumber());

        $plain = StubCollector::attributes($byBody['Deployed']['record']->getAttributes());
        self::assertArrayNotHasKey('exception.type', $plain);
        self::assertArrayNotHasKey('job', $plain);

        $warning = $byBody['Retrying charge ch_1 for ada@example.com'];
        $warningAttributes = StubCollector::attributes($warning['record']->getAttributes());
        self::assertSame('billing', $warning['scope']);
        self::assertSame(13, $warning['record']->getSeverityNumber());
        self::assertSame('WARNING', $warning['record']->getSeverityText());
        self::assertSame('[Filtered]', $warningAttributes['api_key']);
        self::assertSame('RuntimeException', $warningAttributes['exception.type']);
        self::assertSame('php', BackendStack::language((string) $warningAttributes['exception.stacktrace']));

        $monologRecord = $byBody['Order 7 failed'];
        self::assertSame('orders', $monologRecord['scope']);
        self::assertSame(17, $monologRecord['record']->getSeverityNumber());
        self::assertSame(7, StubCollector::attributes($monologRecord['record']->getAttributes())['id']);
    }

    public function testUncaughtExceptionsAreReportedThenPhpPrintsThemAndExits(): void
    {
        [$exitCode, $output] = $this->runFixture('uncaught.php');

        self::assertSame(255, $exitCode);
        self::assertStringContainsString('Uncaught RuntimeException: Unhandled checkout failure', $output);

        $records = $this->collector->logRecords();
        self::assertCount(1, $records);
        $record = $records[0]['record'];
        $attributes = StubCollector::attributes($record->getAttributes());
        self::assertSame(21, $record->getSeverityNumber());
        self::assertSame('RuntimeException', $attributes['exception.type']);
        self::assertFalse($attributes['exception.handled']);
        self::assertStringContainsString('Fixtures/uncaught.php(9): {main}', (string) $attributes['exception.stacktrace']);
    }

    public function testFatalErrorsAreReportedAtShutdown(): void
    {
        [$exitCode, $output] = $this->runFixture('fatal.php');

        self::assertSame(255, $exitCode);
        self::assertStringContainsString('Allowed memory size', $output);

        $records = $this->collector->logRecords();
        self::assertCount(1, $records);
        $attributes = StubCollector::attributes($records[0]['record']->getAttributes());
        self::assertSame(21, $records[0]['record']->getSeverityNumber());
        self::assertSame('ErrorException', $attributes['exception.type']);
        self::assertStringStartsWith('Allowed memory size of', (string) $attributes['exception.message']);
        self::assertFalse($attributes['exception.handled']);
        self::assertSame('php', BackendStack::language((string) $attributes['exception.stacktrace']));
    }

    public function testFlushesOnceWhenTheScriptEnds(): void
    {
        [$exitCode] = $this->runFixture('exit.php');

        self::assertSame(0, $exitCode);
        self::assertCount(1, $this->collector->requestsTo('/v1/logs'));
        $bodies = array_map(
            static fn (array $entry): string => (string) $entry['record']->getBody()?->getStringValue(),
            $this->collector->logRecords()
        );
        self::assertEqualsCanonicalizing(['Job invoice-7 done', 'Queue is backing up'], $bodies);
    }

    /**
     * @return array{int, string}
     */
    private function runFixture(string $fixture): array
    {
        $process = proc_open(
            [PHP_BINARY, '-d', 'display_errors=stderr', '-d', 'log_errors=0', __DIR__ . '/Fixtures/' . $fixture, dirname(__DIR__) . '/vendor/autoload.php', $this->collector->url],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes
        );
        self::assertIsResource($process);
        fclose($pipes[0]);
        $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);

        return [proc_close($process), $output];
    }
}
