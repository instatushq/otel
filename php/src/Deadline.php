<?php

declare(strict_types=1);

namespace Instatus;

/**
 * @internal the time left for a flush or close, shared by every exporter's
 * HTTP client
 */
final class Deadline
{
    private ?int $untilNanos = null;

    public function start(float $seconds): void
    {
        $this->untilNanos = hrtime(true) + (int) (max($seconds, 0.0) * 1e9);
    }

    public function clear(): void
    {
        $this->untilNanos = null;
    }

    public function remaining(): ?float
    {
        if ($this->untilNanos === null) {
            return null;
        }

        return max(($this->untilNanos - hrtime(true)) / 1e9, 0.0);
    }

    public function passed(): bool
    {
        return $this->remaining() === 0.0;
    }
}
