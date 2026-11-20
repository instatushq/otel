<?php

declare(strict_types=1);

namespace Instatus;

use ErrorException;
use OpenTelemetry\API\Logs\LoggerInterface;
use OpenTelemetry\API\Logs\NoopLogger;
use OpenTelemetry\API\Trace\NoopTracer;
use OpenTelemetry\API\Trace\Propagation\TraceContextPropagator;
use OpenTelemetry\API\Trace\Span;
use OpenTelemetry\API\Trace\SpanInterface;
use OpenTelemetry\API\Trace\StatusCode;
use OpenTelemetry\API\Trace\TracerInterface;
use OpenTelemetry\Context\Context;
use OpenTelemetry\Context\ContextKeyInterface;
use OpenTelemetry\Context\ScopeInterface;
use OpenTelemetry\SDK\Metrics\NoopMeterProvider;
use OpenTelemetry\SDK\Sdk as OtelSdk;
use Throwable;

/**
 * The process-wide state behind the functions in functions.php. Under
 * PHP-FPM a process serves one request at a time and init runs per request,
 * so the global scope is the request's scope.
 */
final class Sdk
{
    private const FATAL_ERRORS = E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR;
    private const MEMORY_HEADROOM_BYTES = 16 * 1024 * 1024;

    private static ?Client $client = null;
    private static ?Providers $providers = null;
    private static ?ScopeInterface $globals = null;
    private static ?Scope $globalScope = null;
    /** @var ContextKeyInterface<Scope>|null */
    private static ?ContextKeyInterface $scopeKey = null;
    private static bool $shutdownRegistered = false;
    private static bool $exceptionHandlerRegistered = false;
    private static bool $uncaughtSeen = false;
    /** @var callable|null */
    private static $previousExceptionHandler = null;

    /**
     * @param array<string, mixed> $options
     */
    public static function init(array $options = []): void
    {
        if (self::$client !== null) {
            return;
        }
        foreach (Options::unknownKeys($options) as $key) {
            error_log("[instatus] init ignored an unknown option: $key");
        }
        $resolved = Options::fromArray($options);
        $exports = $resolved->enabled ? Exports::resolve($resolved) : [];
        if ($resolved->enabled && !isset($exports['logs'])) {
            error_log('[instatus] init needs an api_key (or INSTATUS_API_KEY) or an OTLP endpoint');
        }

        $resource = ResourceFactory::create($resolved);
        try {
            $providers = Providers::create($resolved, $exports, $resource);
        } catch (Throwable $error) {
            error_log('[instatus] nothing will be exported: ' . $error->getMessage());
            $providers = Providers::create($resolved, [], $resource);
        }
        self::$providers = $providers;
        self::$globals = OtelSdk::builder()
            ->setTracerProvider($providers->tracer)
            ->setLoggerProvider($providers->logger)
            ->setMeterProvider($providers->meter ?? new NoopMeterProvider())
            ->setPropagator(TraceContextPropagator::getInstance())
            ->buildAndRegisterGlobal();
        self::$client = new Client($resolved, $providers->logger->getLogger(Version::SDK_NAME, Version::VERSION));

        self::registerShutdown();
        if ($resolved->enabled && $resolved->defaultIntegrations) {
            self::registerExceptionHandler();
        }
    }

    public static function isInitialized(): bool
    {
        return self::$client !== null;
    }

    /**
     * @param array<string, mixed> $context
     */
    public static function captureException(Throwable $error, array $context = []): string
    {
        return self::capture(Event::fromThrowable($error), $error, $context);
    }

    public static function captureMessage(string $message, string $level = 'info'): string
    {
        return self::capture(Event::fromMessage($message, $level), null, ['level' => $level]);
    }

    public static function currentScope(): Scope
    {
        $scope = Context::getCurrent()->get(self::scopeKey());
        if ($scope instanceof Scope) {
            return $scope;
        }

        return self::$globalScope ??= new Scope();
    }

    /**
     * @param array<string, mixed>|null $user
     */
    public static function setUser(?array $user): void
    {
        self::currentScope()->setUser($user);
        $span = Span::getCurrent();
        $id = Attributes::endUserId($user);
        if ($id !== null && $span->isRecording()) {
            $span->setAttribute('enduser.id', $id);
        }
    }

    /**
     * @template T
     * @param callable(Scope): T $callback
     * @return T
     */
    public static function withScope(callable $callback): mixed
    {
        $scope = clone self::currentScope();
        $activated = Context::getCurrent()->with(self::scopeKey(), $scope)->activate();
        try {
            return $callback($scope);
        } finally {
            $activated->detach();
        }
    }

    /**
     * @template T
     * @param non-empty-string $name
     * @param callable(SpanInterface): T $callback
     * @param iterable<non-empty-string, mixed> $attributes
     * @return T
     */
    public static function startSpan(string $name, callable $callback, iterable $attributes = []): mixed
    {
        $span = self::tracer()->spanBuilder($name)->setAttributes($attributes)->startSpan();
        $activated = $span->activate();
        try {
            return $callback($span);
        } catch (Throwable $error) {
            $span->setStatus(StatusCode::STATUS_ERROR, Scrub::text($error->getMessage()));
            throw $error;
        } finally {
            $activated->detach();
            $span->end();
        }
    }

    public static function flush(float $timeout = Options::DEFAULT_SHUTDOWN_TIMEOUT): bool
    {
        $providers = self::$providers;
        if ($providers === null) {
            return true;
        }

        return self::withinTimeout(static fn (): bool => $providers->forceFlush($timeout), $timeout);
    }

    public static function close(float $timeout = Options::DEFAULT_SHUTDOWN_TIMEOUT): bool
    {
        $providers = self::$providers;
        if ($providers === null) {
            return true;
        }
        self::$providers = null;
        self::$client = null;
        $closed = self::withinTimeout(static fn (): bool => $providers->shutdown($timeout), $timeout);
        self::$globals?->detach();
        self::$globals = null;

        return $closed;
    }

    /**
     * @internal for the logging bridge
     */
    public static function otelLogger(string $name): LoggerInterface
    {
        return self::$providers?->logger->getLogger($name) ?? NoopLogger::getInstance();
    }

    /**
     * @internal for tests, which run many inits in one process
     */
    public static function reset(): void
    {
        self::close();
        self::$globalScope = null;
        self::$uncaughtSeen = false;
    }

    private static function tracer(): TracerInterface
    {
        return self::$providers?->tracer->getTracer(Version::SDK_NAME, Version::VERSION) ?? NoopTracer::getInstance();
    }

    /**
     * @param array<string, mixed> $context
     */
    private static function capture(Event $event, ?Throwable $error, array $context): string
    {
        $client = self::$client;
        if ($client === null) {
            return $event->eventId;
        }
        $scope = self::currentScope();
        if ($context !== []) {
            $scope = (clone $scope)->update($context);
        }

        return $client->captureEvent($scope->applyTo($event), $error);
    }

    /**
     * @param callable(): bool $work
     */
    private static function withinTimeout(callable $work, float $timeout): bool
    {
        $startedAt = hrtime(true);
        try {
            $done = $work();
        } catch (Throwable) {
            return false;
        }

        return $done && (hrtime(true) - $startedAt) / 1e9 <= $timeout;
    }

    /**
     * @return ContextKeyInterface<Scope>
     */
    private static function scopeKey(): ContextKeyInterface
    {
        return self::$scopeKey ??= Context::createKey('instatus.scope');
    }

    private static function registerExceptionHandler(): void
    {
        if (self::$exceptionHandlerRegistered) {
            return;
        }
        self::$exceptionHandlerRegistered = true;
        self::$previousExceptionHandler = set_exception_handler(static function (Throwable $error): void {
            self::handleUncaught($error);
        });
    }

    /**
     * Rethrowing from the handler gives PHP's own output and exit code 255,
     * as if no handler were set.
     */
    private static function handleUncaught(Throwable $error): void
    {
        self::$uncaughtSeen = true;
        self::capture(Event::fromThrowable($error, handled: false), $error, ['level' => 'fatal']);
        $previous = self::$previousExceptionHandler;
        if ($previous !== null) {
            $previous($error);

            return;
        }
        throw $error;
    }

    private static function registerShutdown(): void
    {
        if (self::$shutdownRegistered) {
            return;
        }
        self::$shutdownRegistered = true;
        register_shutdown_function(static function (): void {
            self::captureFatalError();
            register_shutdown_function(static function (): void {
                self::finishRequest();
            });
        });
    }

    /**
     * An uncaught exception also ends as an "Uncaught ..." fatal error, which
     * the exception handler has reported already.
     */
    private static function captureFatalError(): void
    {
        $error = error_get_last();
        $options = self::$client?->options;
        if ($error === null || $options === null || !$options->defaultIntegrations) {
            return;
        }
        if (($error['type'] & self::FATAL_ERRORS) === 0) {
            return;
        }
        if (self::$uncaughtSeen && str_starts_with($error['message'], 'Uncaught ')) {
            return;
        }
        if (str_starts_with($error['message'], 'Allowed memory size')) {
            ini_set('memory_limit', (string) (memory_get_usage(true) + self::MEMORY_HEADROOM_BYTES));
        }

        $exception = new ExceptionData(
            ErrorException::class,
            $error['message'],
            StackTrace::ofLocation($error['file'], $error['line']),
            false
        );
        $event = new Event(Event::generateId(), microtime(true), 'fatal', exception: $exception);
        $hint = new ErrorException($error['message'], 0, $error['type'], $error['file'], $error['line']);
        self::capture($event, $hint, ['level' => 'fatal']);
    }

    /**
     * Runs after every other shutdown function. Under PHP-FPM the response is
     * sent first, so exporting does not hold up the visitor.
     */
    private static function finishRequest(): void
    {
        $options = self::$client?->options;
        if ($options === null) {
            return;
        }
        if ($options->finishRequest && PHP_SAPI === 'fpm-fcgi' && function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        } elseif ($options->finishRequest && function_exists('litespeed_finish_request')) {
            litespeed_finish_request();
        }
        self::close($options->shutdownTimeout);
    }
}
