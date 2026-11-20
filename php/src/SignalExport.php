<?php

declare(strict_types=1);

namespace Instatus;

/**
 * A null url leaves the OTLP exporter to read OTEL_EXPORTER_OTLP_* itself.
 */
final class SignalExport
{
    /**
     * @param array<string, string> $headers
     */
    public function __construct(
        public readonly ?string $url,
        public readonly array $headers = [],
    ) {
    }
}
