<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Closure;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use Instatus\Deadline;
use Instatus\DeadlineClient;
use Instatus\DeadlineExceeded;
use PHPUnit\Framework\TestCase;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

final class DeadlineClientTest extends TestCase
{
    /** @var list<float> */
    private array $timeouts = [];

    /**
     * @return Closure(float): ClientInterface
     */
    private function connect(ResponseInterface $response): Closure
    {
        return function (float $timeout) use ($response): ClientInterface {
            $this->timeouts[] = $timeout;

            return new class ($response) implements ClientInterface {
                public function __construct(private readonly ResponseInterface $response)
                {
                }

                public function sendRequest(RequestInterface $request): ResponseInterface
                {
                    return $this->response;
                }
            };
        };
    }

    public function testWithoutADeadlineOneClientUsesTheExportTimeout(): void
    {
        $client = new DeadlineClient(new Deadline(), 5.0, $this->connect(new Response(200)));

        $client->sendRequest(new Request('POST', 'http://collector/v1/logs'));
        $client->sendRequest(new Request('POST', 'http://collector/v1/logs'));

        self::assertSame([5.0], $this->timeouts);
    }

    public function testARequestMayTakeOnlyTheTimeLeft(): void
    {
        $deadline = new Deadline();
        $deadline->start(0.5);
        $client = new DeadlineClient($deadline, 5.0, $this->connect(new Response(200)));

        $client->sendRequest(new Request('POST', 'http://collector/v1/logs'));

        self::assertCount(1, $this->timeouts);
        self::assertGreaterThan(0.4, $this->timeouts[0]);
        self::assertLessThanOrEqual(0.5, $this->timeouts[0]);
    }

    public function testNoRequestStartsOnceTheDeadlineHasPassed(): void
    {
        $deadline = new Deadline();
        $deadline->start(0.0);
        $client = new DeadlineClient($deadline, 5.0, $this->connect(new Response(200)));

        $this->expectException(DeadlineExceeded::class);
        try {
            $client->sendRequest(new Request('POST', 'http://collector/v1/logs'));
        } finally {
            self::assertSame([], $this->timeouts);
        }
    }

    public function testARetryAfterBeyondTheDeadlineEndsTheExport(): void
    {
        $deadline = new Deadline();
        $deadline->start(1.0);
        $client = new DeadlineClient($deadline, 5.0, $this->connect(new Response(503, ['Retry-After' => '30'])));

        $this->expectException(DeadlineExceeded::class);
        $client->sendRequest(new Request('POST', 'http://collector/v1/logs'));
    }

    public function testARetryAfterWithinTheDeadlineIsLeftToTheTransport(): void
    {
        $deadline = new Deadline();
        $deadline->start(5.0);
        $client = new DeadlineClient($deadline, 5.0, $this->connect(new Response(503, ['Retry-After' => '1'])));

        self::assertSame(503, $client->sendRequest(new Request('POST', 'http://collector/v1/logs'))->getStatusCode());
    }
}
