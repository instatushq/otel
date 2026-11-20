<?php

declare(strict_types=1);

namespace Instatus;

use Psr\Http\Client\ClientExceptionInterface;
use RuntimeException;

/**
 * @internal not a network error, so the OTLP transport gives up instead of
 * retrying
 */
final class DeadlineExceeded extends RuntimeException implements ClientExceptionInterface
{
}
