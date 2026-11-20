<?php

declare(strict_types=1);

namespace Instatus;

final class ExceptionData
{
    public function __construct(
        public string $type,
        public string $value,
        public ?string $stacktrace = null,
        public bool $handled = true,
    ) {
    }
}
