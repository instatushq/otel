<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Instatus\Scrub;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use stdClass;

final class ScrubTest extends TestCase
{
    /**
     * @return iterable<string, array{string, bool}>
     */
    public static function keys(): iterable
    {
        foreach (['password', 'passwd', 'db_pass', 'client_secret', 'access_token', 'api_key', 'apiKey', 'x-api.key', 'Authorization', 'credentials', 'session_id', 'Cookie', 'csrf', 'XSRF-TOKEN', 'private_key', 'signature'] as $key) {
            yield $key => [$key, true];
        }
        foreach (['name', 'email', 'id', 'amount', 'path'] as $key) {
            yield $key => [$key, false];
        }
    }

    #[DataProvider('keys')]
    public function testSensitiveKeys(string $key, bool $sensitive): void
    {
        self::assertSame($sensitive, Scrub::isSensitiveKey($key));
    }

    public function testFiltersCardNumbersThatPassLuhn(): void
    {
        self::assertSame('Charge [Filtered] failed', Scrub::text('Charge 4242 4242 4242 4242 failed'));
        self::assertSame('card [Filtered]', Scrub::text('card 4111-1111-1111-1111'));
        self::assertSame('amex [Filtered]', Scrub::text('amex 378282246310005'));
    }

    public function testKeepsNumbersThatFailLuhn(): void
    {
        self::assertSame('order 4111111111111112', Scrub::text('order 4111111111111112'));
        self::assertSame('at 1700000000000', Scrub::text('at 1700000000000'));
        self::assertSame('short 4242424242', Scrub::text('short 4242424242'));
    }

    public function testStripsUrlCredentialsAndSensitiveParameters(): void
    {
        self::assertSame(
            'https://example.com/callback?code=1&token=[Filtered]#access_token=[Filtered]',
            Scrub::url('https://user:hunter2@example.com/callback?code=1&token=abc#access_token=xyz')
        );
        self::assertSame('https://example.com/?api%5Fkey=[Filtered]', Scrub::url('https://example.com/?api%5Fkey=secret'));
        self::assertSame('https://shop.test/pay?number=[Filtered]', Scrub::url('https://shop.test/pay?number=4111111111111111'));
        self::assertSame('https://example.com/a?page=2', Scrub::url('https://example.com/a?page=2'));
    }

    public function testFiltersUrlsInsideText(): void
    {
        self::assertSame(
            'Client error: `GET https://api.example.com/v1?api_key=[Filtered]` resulted in a `401`',
            Scrub::text('Client error: `GET https://bot:pw@api.example.com/v1?api_key=s3cret` resulted in a `401`')
        );
    }

    public function testWalksNestedArraysAndLists(): void
    {
        $scrubbed = Scrub::value('request', [
            'user' => ['name' => 'Ada', 'password' => 'hunter2'],
            'cards' => ['4111111111111111', 'none'],
            'token' => ['nested' => 'all of it'],
            'count' => 3,
        ]);

        self::assertSame([
            'user' => ['name' => 'Ada', 'password' => '[Filtered]'],
            'cards' => ['[Filtered]', 'none'],
            'token' => '[Filtered]',
            'count' => 3,
        ], $scrubbed);
        self::assertSame('[Filtered]', Scrub::value('password', ['a' => 1]));
    }

    public function testCutsDeepValues(): void
    {
        $scrubbed = Scrub::value('root', ['a' => ['b' => ['c' => ['d' => ['e' => ['f' => ['g' => 1]]]]]]]);

        self::assertSame('[Truncated]', $scrubbed['a']['b']['c']['d']['e']['f']);
    }

    public function testCutsCyclesButKeepsSharedObjects(): void
    {
        $address = new stdClass();
        $address->city = 'Paris';
        $order = new stdClass();
        $order->billing = $address;
        $order->shipping = $address;
        $order->self = $order;

        self::assertSame([
            'billing' => ['city' => 'Paris'],
            'shipping' => ['city' => 'Paris'],
            'self' => '[Circular]',
        ], Scrub::value('order', $order));
    }

    public function testDescribesOtherValues(): void
    {
        $stringable = new class () {
            public function __toString(): string
            {
                return 'paid with 4242424242424242';
            }
        };

        self::assertSame('paid with [Filtered]', Scrub::value('note', $stringable));
        self::assertSame('Object ' . ScrubTest::class, Scrub::value('test', $this));
        self::assertSame('pro', Scrub::value('plan', Plan::Pro));
        self::assertTrue(Scrub::value('flag', true));
    }
}

enum Plan: string
{
    case Pro = 'pro';
}
