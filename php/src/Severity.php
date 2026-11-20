<?php

declare(strict_types=1);

namespace Instatus;

final class Severity
{
    public const ERROR = 17;

    private const LEVELS = [
        'fatal' => [21, 'FATAL'],
        'error' => [17, 'ERROR'],
        'warning' => [13, 'WARN'],
        'log' => [9, 'INFO'],
        'info' => [9, 'INFO'],
        'debug' => [5, 'DEBUG'],
    ];

    /**
     * @return array{0: int, 1: string}
     */
    public static function of(string $level): array
    {
        return self::LEVELS[$level] ?? self::LEVELS['error'];
    }
}
