<?php

declare(strict_types=1);

namespace Instatus\Tests;

/**
 * The checks packages/backend/src/modules/issues/helpers/stack-frames.ts runs
 * before it decides a stack is PHP, and its PHP frame pattern.
 */
final class BackendStack
{
    public static function language(string $stack): string
    {
        if (preg_match('/Traceback \(most recent call last\)/', $stack) || preg_match('/^\s*File ".*", line \d+/m', $stack)) {
            return 'python';
        }
        if (preg_match('/^goroutine \d+ \[/m', $stack) || preg_match('/^\t.*\.go:\d+/m', $stack)) {
            return 'go';
        }
        if (preg_match('/^\d+\t[^\t]+\t0x[0-9a-fA-F]+\t/m', $stack)) {
            return 'native';
        }
        if (preg_match('/^#\d+ /m', $stack)) {
            return 'php';
        }

        return 'other';
    }

    /**
     * @return list<array{file: string, line: int, fn: string}>
     */
    public static function frames(string $stack): array
    {
        $frames = [];
        foreach (preg_split('/\r?\n/', $stack) ?: [] as $line) {
            if (preg_match('/^#\d+ (.+?)\((\d+)\): (.*)$/', $line, $match)) {
                $frames[] = ['file' => $match[1], 'line' => (int) $match[2], 'fn' => trim($match[3])];
            }
        }

        return $frames;
    }
}
