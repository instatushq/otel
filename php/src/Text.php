<?php

declare(strict_types=1);

namespace Instatus;

final class Text
{
    public static function truncate(string $text, int $length): string
    {
        if (strlen($text) <= $length) {
            return $text;
        }
        if (function_exists('mb_strcut')) {
            return mb_strcut($text, 0, $length, 'UTF-8');
        }

        return substr($text, 0, $length);
    }
}
