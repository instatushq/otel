<?php

declare(strict_types=1);

namespace Instatus;

final class ErrorLogRecord
{
    /**
     * @param array<string, string|int|float|bool> $attributes
     */
    public function __construct(
        public readonly int $timestampNanos,
        public readonly int $severityNumber,
        public readonly string $severityText,
        public readonly string $body,
        public readonly array $attributes,
    ) {
    }
}
