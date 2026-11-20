<?php

declare(strict_types=1);

namespace Instatus\Logging;

use DateTimeInterface;
use Monolog\Handler\AbstractProcessingHandler;
use Monolog\LogRecord;

/**
 * Sends Monolog records to Instatus Logs. Needs monolog/monolog 2 or 3:
 * `$logger->pushHandler(new MonologHandler())`.
 */
final class MonologHandler extends AbstractProcessingHandler
{
    /**
     * Monolog 3 passes a LogRecord, Monolog 2 an array.
     *
     * @param LogRecord|array{channel: string, level_name: string, message: string, context: array<array-key, mixed>, extra: array<array-key, mixed>, datetime: DateTimeInterface} $record
     */
    protected function write(LogRecord|array $record): void
    {
        if ($record instanceof LogRecord) {
            LogEmitter::emit(
                $record->channel,
                $record->level->toPsrLogLevel(),
                $record->message,
                $record->context,
                $record->extra,
                self::nanosOf($record->datetime)
            );

            return;
        }
        LogEmitter::emit(
            $record['channel'],
            strtolower($record['level_name']),
            $record['message'],
            $record['context'],
            $record['extra'],
            self::nanosOf($record['datetime'])
        );
    }

    private static function nanosOf(DateTimeInterface $time): int
    {
        return (int) $time->format('Uu') * 1000;
    }
}
