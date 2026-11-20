<?php

declare(strict_types=1);

namespace Instatus;

/**
 * Same as Sentry's Dedupe integration: an event identical to the one just
 * sent is a re-throw, or a handler and a logger both reporting one error.
 */
final class Dedupe
{
    private ?string $previous = null;

    public function isDuplicate(Event $event): bool
    {
        $signature = self::signatureOf($event);
        $duplicate = $signature === $this->previous;
        $this->previous = $signature;

        return $duplicate;
    }

    private static function signatureOf(Event $event): string
    {
        $exception = $event->exception;
        if ($exception !== null) {
            return $exception->type . '|' . $exception->value . '|' . ($exception->stacktrace ?? '');
        }

        return 'message|' . ($event->message ?? '');
    }
}
