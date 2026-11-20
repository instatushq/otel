<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Instatus\Logging\MonologHandler;
use Instatus\Sdk;
use Monolog\Logger;
use Monolog\Processor\PsrLogMessageProcessor;
use PHPUnit\Framework\TestCase;

use function Instatus\flush;
use function Instatus\init;
use function Instatus\logger;

final class LoggingTest extends TestCase
{
    private const CARD = '4242 4242 4242 4242';

    private StubCollector $collector;

    protected function setUp(): void
    {
        $this->collector = new StubCollector();
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
    }

    /**
     * @return list<string>
     */
    private function bodies(): array
    {
        self::assertTrue(flush());
        $bodies = [];
        foreach ($this->collector->logRecords() as $entry) {
            $bodies[] = (string) $entry['record']->getBody()?->getStringValue();
        }

        return $bodies;
    }

    public function testPsrPlaceholdersUnderSensitiveKeysAreFiltered(): void
    {
        logger()->info('login {user} with {password}', ['user' => 'ada', 'password' => 'hunter2']);
        logger()->info('charged {card} using {session}', ['card' => self::CARD, 'session' => new class () implements \Stringable {
            public function __toString(): string
            {
                return 'sess_abc';
            }
        }]);
        logger()->info('payload hunter3 sent', ['auth' => ['user' => 'bob', 'secret' => 'hunter3']]);

        self::assertSame([
            'login ada with [Filtered]',
            'charged [Filtered] using [Filtered]',
            'payload [Filtered] sent',
        ], $this->bodies());
    }

    public function testStringableValuesKeepTheirTextWhenTheyAlsoSerialize(): void
    {
        $order = new class () implements \Stringable, \JsonSerializable {
            public function __toString(): string
            {
                return 'order 42';
            }

            /** @return array<string, string> */
            public function jsonSerialize(): array
            {
                return ['id' => '42', 'token' => 'tok_abc'];
            }
        };
        $broken = new class () implements \Stringable {
            public function __toString(): string
            {
                throw new \RuntimeException('cannot render');
            }
        };
        $secret = new class () implements \Stringable {
            public function __toString(): string
            {
                throw new \RuntimeException('never rendered');
            }
        };
        logger()->info('shipped {order}', ['order' => $order]);
        logger()->info('order {order} token {token}', ['order' => $broken, 'token' => $secret]);

        self::assertSame(['shipped order 42', 'order [Unreadable] token [Filtered]'], $this->bodies());
    }

    public function testMonologMessagesFilledInByItsProcessorLoseSecrets(): void
    {
        $monolog = new Logger('auth');
        $monolog->pushProcessor(new PsrLogMessageProcessor());
        $monolog->pushHandler(new MonologHandler());

        $monolog->info('login {user} with {password}', ['user' => 'ada', 'password' => 'hunter2']);
        $monolog->info('request {request}', ['request' => [
            'path' => '/pay',
            'headers' => ['cookie' => 'id="a/b"', 'accept' => '*/*'],
            'card' => self::CARD,
        ]]);
        $monolog->info('nested {user}', ['user' => ['credentials' => ['pin' => 4821]]]);

        $bodies = $this->bodies();
        self::assertSame('login ada with [Filtered]', $bodies[0]);
        self::assertSame('request array{"path":"/pay","headers":{"cookie":"[Filtered]","accept":"*/*"},"card":"[Filtered]"}', $bodies[1]);
        self::assertSame('nested array{"credentials":{"pin":[Filtered]}}', $bodies[2]);
    }

    public function testMonologPlaceholdersAreFilteredWithoutItsProcessor(): void
    {
        $monolog = new Logger('auth');
        $monolog->pushHandler(new MonologHandler());

        $monolog->warning('token {token} for {user}', ['token' => 'tok_123', 'user' => 'ada']);

        self::assertSame(['token [Filtered] for ada'], $this->bodies());
    }
}
