<?php

declare(strict_types=1);

namespace Instatus;

use Throwable;

/**
 * Sentry's event shape, which before_send receives and may change.
 */
final class Event
{
    /**
     * @param array<string, mixed>|null $user
     * @param array<string, scalar|null> $tags
     * @param array<string, mixed> $extra
     * @param array<string, mixed> $contexts
     */
    public function __construct(
        public string $eventId,
        public float $timestamp,
        public string $level,
        public ?string $message = null,
        public ?ExceptionData $exception = null,
        public ?array $user = null,
        public array $tags = [],
        public array $extra = [],
        public array $contexts = [],
        public ?string $release = null,
        public ?string $environment = null,
    ) {
    }

    public static function generateId(): string
    {
        return bin2hex(random_bytes(16));
    }

    public static function fromThrowable(Throwable $error, bool $handled = true): self
    {
        $exception = new ExceptionData(
            StackTrace::typeOf($error),
            $error->getMessage(),
            StackTrace::of($error),
            $handled
        );

        return new self(self::generateId(), microtime(true), 'error', exception: $exception);
    }

    public static function fromMessage(string $message, string $level): self
    {
        return new self(self::generateId(), microtime(true), $level, $message);
    }
}
