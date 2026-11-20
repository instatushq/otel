<?php

declare(strict_types=1);

namespace Instatus;

use Throwable;

/**
 * PHP's trace text leaves out the line that threw, which is the frame
 * Errors groups by, so it is added as #0 the way Sentry's PHP SDK reports
 * it, and PHP's own frames follow unchanged apart from their numbers.
 */
final class StackTrace
{
    public static function of(Throwable $error): string
    {
        $trace = $error->getTrace();
        $top = sprintf('#0 %s(%d): %s', $error->getFile(), $error->getLine(), self::enclosingFunction($trace[0] ?? null));
        $rest = preg_replace_callback(
            '/^#(\d+) /m',
            static fn (array $match): string => '#' . ((int) $match[1] + 1) . ' ',
            $error->getTraceAsString()
        ) ?? $error->getTraceAsString();

        return $top . "\n" . $rest;
    }

    public static function ofLocation(string $file, int $line): string
    {
        return sprintf("#0 %s(%d): {main}\n#1 {main}", $file, $line);
    }

    public static function typeOf(Throwable $error): string
    {
        $class = $error::class;
        $anonymous = strpos($class, "@anonymous\0");

        return $anonymous === false ? $class : substr($class, 0, $anonymous + strlen('@anonymous'));
    }

    /**
     * @param array<string, mixed>|null $frame
     */
    private static function enclosingFunction(?array $frame): string
    {
        if ($frame === null || !is_string($frame['function'] ?? null)) {
            return '{main}';
        }
        $class = is_string($frame['class'] ?? null) ? $frame['class'] : '';
        $type = is_string($frame['type'] ?? null) ? $frame['type'] : '';

        return $class . $type . $frame['function'] . '()';
    }
}
