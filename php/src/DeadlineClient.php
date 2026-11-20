<?php

declare(strict_types=1);

namespace Instatus;

use Closure;
use OpenTelemetry\SDK\Common\Http\Psr\Client\Discovery;
use Psr\Http\Client\ClientInterface;
use Psr\Http\Message\RequestInterface;
use Psr\Http\Message\ResponseInterface;

/**
 * PSR-18 has no per-request timeout and the OTLP transport sends, retries
 * and sleeps synchronously, so the deadline is enforced on each attempt: the
 * request may take only the time left, and none starts once it has run out.
 *
 * @internal
 */
final class DeadlineClient implements ClientInterface
{
    /**
     * Below this, cURL rounds the timeout down to 0 ms, which means no limit.
     */
    private const MIN_TIMEOUT_SECONDS = 0.01;

    private ?ClientInterface $client = null;
    /** @var Closure(float): ClientInterface */
    private readonly Closure $connect;

    /**
     * @param (Closure(float): ClientInterface)|null $connect
     */
    public function __construct(
        private readonly Deadline $deadline,
        private readonly float $timeout,
        ?Closure $connect = null,
    ) {
        $this->connect = $connect ?? static fn (float $seconds): ClientInterface => Discovery::find(['timeout' => $seconds]);
    }

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $remaining = $this->deadline->remaining();
        if ($remaining === null) {
            return $this->clientFor($this->timeout)->sendRequest($request);
        }
        if ($remaining < self::MIN_TIMEOUT_SECONDS) {
            throw new DeadlineExceeded('The flush or close timeout ran out before this export');
        }
        $response = $this->clientFor(min($remaining, $this->timeout))->sendRequest($request);
        if (self::retryAfterSeconds($response) >= ($this->deadline->remaining() ?? 0.0)) {
            throw new DeadlineExceeded('The collector asked to retry after the flush or close timeout');
        }

        return $response;
    }

    private function clientFor(float $timeout): ClientInterface
    {
        if ($timeout < $this->timeout) {
            return ($this->connect)($timeout);
        }

        return $this->client ??= ($this->connect)($this->timeout);
    }

    /**
     * The transport sleeps for Retry-After before retrying, which would
     * outlast the deadline.
     */
    private static function retryAfterSeconds(ResponseInterface $response): float
    {
        $retryAfter = trim($response->getHeaderLine('Retry-After'));
        if ($response->getStatusCode() < 300 || $retryAfter === '') {
            return -1.0;
        }
        if ($retryAfter === (string) (int) $retryAfter) {
            return (float) $retryAfter;
        }
        $time = strtotime($retryAfter);

        return $time === false ? -1.0 : (float) ($time - time());
    }
}
