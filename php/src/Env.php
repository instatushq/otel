<?php

declare(strict_types=1);

namespace Instatus;

/**
 * PHP-FPM passes pool and FastCGI variables through $_SERVER, which a bare
 * getenv() does not see, so every source is read.
 */
final class Env
{
    public static function get(string $name): ?string
    {
        $value = $_SERVER[$name] ?? $_ENV[$name] ?? getenv($name);

        return is_string($value) && $value !== '' ? $value : null;
    }
}
