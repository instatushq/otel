<?php

declare(strict_types=1);

namespace Instatus;

use Closure;

final class RateCap
{
    private float $windowStart;
    private int $count = 0;
    /** @var Closure(): float */
    private Closure $now;

    /**
     * @param (Closure(): float)|null $now
     */
    public function __construct(
        private readonly int $limit,
        private readonly float $windowSeconds = 60.0,
        ?Closure $now = null,
    ) {
        $this->now = $now ?? static fn (): float => microtime(true);
        $this->windowStart = ($this->now)();
    }

    public function take(): bool
    {
        $time = ($this->now)();
        if ($time - $this->windowStart >= $this->windowSeconds) {
            $this->windowStart = $time;
            $this->count = 0;
        }
        if ($this->count >= $this->limit) {
            return false;
        }
        $this->count++;

        return true;
    }
}
