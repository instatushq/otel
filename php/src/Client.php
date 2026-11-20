<?php

declare(strict_types=1);

namespace Instatus;

use OpenTelemetry\API\Logs\LoggerInterface;
use OpenTelemetry\API\Logs\LogRecord;
use OpenTelemetry\API\Trace\Span;
use OpenTelemetry\API\Trace\SpanInterface;
use OpenTelemetry\API\Trace\StatusCode;
use OpenTelemetry\Context\Context;
use Throwable;
use WeakMap;

final class Client
{
    private const SPAN_EVENT_KEYS = ['exception.type', 'exception.message', 'exception.stacktrace'];

    private readonly Dedupe $dedupe;
    private readonly RateCap $rateCap;
    /** @var WeakMap<Throwable, true> */
    private WeakMap $captured;

    public function __construct(
        public readonly Options $options,
        private readonly LoggerInterface $logger,
        ?RateCap $rateCap = null,
    ) {
        $this->dedupe = new Dedupe();
        $this->rateCap = $rateCap ?? new RateCap($options->maxEventsPerMinute);
        $this->captured = new WeakMap();
    }

    public function captureEvent(Event $event, ?Throwable $error = null): string
    {
        if ($this->shouldDrop($error)) {
            return $event->eventId;
        }
        if ($error !== null) {
            $this->captured[$error] = true;
        }
        $prepared = clone $event;
        $prepared->release ??= $this->options->release;
        $prepared->environment ??= $this->options->environment;

        try {
            $beforeSend = $this->options->beforeSend;
            $result = $beforeSend === null ? $prepared : $beforeSend($prepared, $error);
            if ($result instanceof Event) {
                $this->send($result);
            }
        } catch (Throwable) {
            return $event->eventId;
        }

        return $event->eventId;
    }

    private function shouldDrop(?Throwable $error): bool
    {
        if (!$this->options->enabled) {
            return true;
        }
        if ($error !== null && isset($this->captured[$error])) {
            return true;
        }
        if ($this->options->sampleRate < 1 && mt_rand() / mt_getrandmax() >= $this->options->sampleRate) {
            return true;
        }
        foreach ($this->options->ignoreExceptions as $class) {
            if ($error instanceof $class) {
                return true;
            }
        }

        return false;
    }

    private function send(Event $event): void
    {
        if ($this->dedupe->isDuplicate($event) || !$this->rateCap->take()) {
            return;
        }
        $record = Attributes::toLogRecord($event);
        $context = Context::getCurrent();
        self::recordOnSpan(Span::fromContext($context), $event, $record);
        $this->logger->emit(
            (new LogRecord($record->body))
                ->setTimestamp($record->timestampNanos)
                ->setSeverityNumber($record->severityNumber)
                ->setSeverityText($record->severityText)
                ->setAttributes($record->attributes)
                ->setContext($context)
        );
    }

    /**
     * The span event is what OpenTelemetry's recordException writes, built
     * from the filtered record so traces carry nothing the log doesn't.
     */
    private static function recordOnSpan(SpanInterface $span, Event $event, ErrorLogRecord $record): void
    {
        if ($event->exception === null || !$span->isRecording()) {
            return;
        }
        $attributes = [];
        foreach (self::SPAN_EVENT_KEYS as $key) {
            if (isset($record->attributes[$key])) {
                $attributes[$key] = (string) $record->attributes[$key];
            }
        }
        $span->addEvent('exception', $attributes);
        if (!$event->exception->handled) {
            $span->setStatus(StatusCode::STATUS_ERROR, $attributes['exception.message'] ?? null);
        }
    }
}
