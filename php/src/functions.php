<?php

declare(strict_types=1);

namespace Instatus;

use OpenTelemetry\API\Trace\SpanInterface;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Starts the SDK. Call it once, as early as you can.
 *
 * @param array<string, mixed> $options
 */
function init(array $options = []): void
{
    Sdk::init($options);
}

/**
 * Reports an error you caught and returns the event id.
 *
 * @param array<string, mixed> $context user, level, tags, extra or contexts for this event only
 */
function captureException(Throwable $error, array $context = []): string
{
    return Sdk::captureException($error, $context);
}

/**
 * Reports a message. error and fatal messages are issues in Errors; lower
 * levels are plain logs.
 */
function captureMessage(string $message, string $level = 'info'): string
{
    return Sdk::captureMessage($message, $level);
}

/**
 * @param array<string, mixed>|null $user
 */
function setUser(?array $user): void
{
    Sdk::setUser($user);
}

function setTag(string $key, string|int|float|bool|null $value): void
{
    Sdk::currentScope()->setTag($key, $value);
}

/**
 * @param array<string, scalar|null> $tags
 */
function setTags(array $tags): void
{
    Sdk::currentScope()->setTags($tags);
}

/**
 * @param array<string, mixed>|null $context
 */
function setContext(string $name, ?array $context): void
{
    Sdk::currentScope()->setContext($name, $context);
}

function setExtra(string $key, mixed $value): void
{
    Sdk::currentScope()->setExtra($key, $value);
}

/**
 * @param array<string, mixed> $extras
 */
function setExtras(array $extras): void
{
    Sdk::currentScope()->setExtras($extras);
}

/**
 * Runs $callback with a copy of the scope, so changes stay inside it.
 *
 * @template T
 * @param callable(Scope): T $callback
 * @return T
 */
function withScope(callable $callback): mixed
{
    return Sdk::withScope($callback);
}

/**
 * Runs $callback inside an OpenTelemetry span and ends it when the callback
 * returns. An exception marks the span as failed and is rethrown.
 *
 * @template T
 * @param non-empty-string $name
 * @param callable(SpanInterface): T $callback
 * @param iterable<non-empty-string, mixed> $attributes
 * @return T
 */
function startSpan(string $name, callable $callback, iterable $attributes = []): mixed
{
    return Sdk::startSpan($name, $callback, $attributes);
}

/**
 * Sends what is queued. False if it failed or took longer than $timeout seconds.
 */
function flush(float $timeout = 2.0): bool
{
    return Sdk::flush($timeout);
}

/**
 * Flushes and shuts the SDK down.
 */
function close(float $timeout = 2.0): bool
{
    return Sdk::close($timeout);
}

/**
 * A PSR-3 logger whose records go to Instatus Logs.
 */
function logger(string $name = 'app'): LoggerInterface
{
    return new Logging\PsrLogger($name);
}
