<?php

declare(strict_types=1);

namespace Instatus\Logging;

use Psr\Log\InvalidArgumentException;
use Psr\Log\LoggerInterface;
use Psr\Log\LoggerTrait;
use Stringable;

/**
 * A PSR-3 logger whose records go to Instatus Logs, in the active span's
 * trace. It looks up the SDK on every call, so it can be built before init.
 */
final class PsrLogger implements LoggerInterface
{
    use LoggerTrait;

    public function __construct(private readonly string $name = 'app')
    {
    }

    /**
     * @param mixed $level
     * @param string|Stringable $message
     * @param array<array-key, mixed> $context
     */
    public function log($level, $message, array $context = []): void
    {
        if (!is_string($level) && !$level instanceof Stringable) {
            throw new InvalidArgumentException('The log level must be a string');
        }
        LogEmitter::emit($this->name, strtolower((string) $level), (string) $message, $context);
    }
}
