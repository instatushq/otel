<?php

declare(strict_types=1);

namespace Instatus\Tests;

use Closure;
use Instatus\Exports;
use Instatus\Options;
use Instatus\ResourceFactory;
use Instatus\Version;
use PHPUnit\Framework\TestCase;

final class ExportsTest extends TestCase
{
    /**
     * @param array<string, string> $variables
     * @return Closure(string): ?string
     */
    private static function env(array $variables = []): Closure
    {
        return static fn (string $name): ?string => $variables[$name] ?? null;
    }

    /**
     * @param array<string, mixed> $options
     * @param array<string, string> $variables
     * @return array<string, array{url: ?string, headers: array<string, string>}>
     */
    private static function resolve(array $options, array $variables = []): array
    {
        $exports = Exports::resolve(Options::fromArray($options, self::env($variables)), self::env($variables));

        return array_map(static fn ($export) => ['url' => $export->url, 'headers' => $export->headers], $exports);
    }

    public function testApiKeySendsEverySignalToTheCollector(): void
    {
        $headers = ['Authorization' => 'Bearer sk_live', 'X-Instatus-Site-Id' => 'site_1'];

        self::assertSame([
            'logs' => ['url' => 'https://otel.instatus.com/v1/logs', 'headers' => $headers],
            'traces' => ['url' => 'https://otel.instatus.com/v1/traces', 'headers' => $headers],
            'metrics' => ['url' => 'https://otel.instatus.com/v1/metrics', 'headers' => $headers],
        ], self::resolve(['api_key' => 'sk_live', 'site_id' => 'site_1']));
    }

    public function testReadsTheKeyAndSiteFromTheEnvironment(): void
    {
        $exports = self::resolve([], ['INSTATUS_API_KEY' => 'sk_env', 'INSTATUS_SITE_ID' => 'site_env']);

        self::assertSame(['Authorization' => 'Bearer sk_env', 'X-Instatus-Site-Id' => 'site_env'], $exports['logs']['headers']);
    }

    public function testLeavesOutTheSiteHeaderWithoutASite(): void
    {
        self::assertSame(['Authorization' => 'Bearer sk_live'], self::resolve(['api_key' => 'sk_live'])['traces']['headers']);
    }

    public function testEndpointReplacesTheHost(): void
    {
        $exports = self::resolve(['api_key' => 'sk_live', 'endpoint' => 'http://localhost:4318/']);

        self::assertSame('http://localhost:4318/v1/logs', $exports['logs']['url']);
        self::assertSame('http://localhost:4318/v1/metrics', $exports['metrics']['url']);
    }

    public function testEndpointWithoutAKeySendsNoHeaders(): void
    {
        self::assertSame(
            ['url' => 'http://collector:4318/v1/traces', 'headers' => []],
            self::resolve(['endpoint' => 'http://collector:4318'])['traces']
        );
    }

    public function testKeyHeadersFollowAnEnvironmentEndpoint(): void
    {
        $exports = self::resolve(['api_key' => 'sk_live'], [
            'OTEL_EXPORTER_OTLP_ENDPOINT' => 'http://collector:4318',
            'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT' => 'http://traces:4318/custom',
        ]);

        self::assertSame('http://collector:4318/v1/logs', $exports['logs']['url']);
        self::assertSame('http://traces:4318/custom', $exports['traces']['url']);
        self::assertSame(['Authorization' => 'Bearer sk_live'], $exports['traces']['headers']);
    }

    public function testWithoutAKeyOrEndpointTheOtelVariablesApply(): void
    {
        self::assertSame([], self::resolve([]));
        self::assertSame(
            ['traces' => ['url' => null, 'headers' => []]],
            self::resolve([], ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT' => 'http://traces:4318/v1/traces'])
        );
        self::assertSame(
            ['logs', 'traces', 'metrics'],
            array_keys(self::resolve([], ['OTEL_EXPORTER_OTLP_ENDPOINT' => 'http://collector:4318']))
        );
    }

    public function testResourceAttributes(): void
    {
        $options = Options::fromArray(['release' => 'shop@1.4.0', 'environment' => 'production'], self::env());

        self::assertSame([
            'service.name' => 'php',
            'telemetry.sdk.name' => 'instatus/otel',
            'telemetry.sdk.version' => Version::VERSION,
            'telemetry.sdk.language' => 'php',
            'service.version' => 'shop@1.4.0',
            'deployment.environment.name' => 'production',
        ], ResourceFactory::attributes($options));
    }

    public function testServiceNameFallsBackFromOptionToVariableToDetected(): void
    {
        $named = Options::fromArray(['service_name' => 'checkout'], self::env(['OTEL_SERVICE_NAME' => 'from-env']));
        $fromEnv = Options::fromArray([], self::env(['OTEL_SERVICE_NAME' => 'from-env']));
        $unnamed = Options::fromArray([], self::env());

        self::assertSame('checkout', ResourceFactory::attributes($named, 'detected')['service.name']);
        self::assertSame('from-env', ResourceFactory::attributes($fromEnv, 'detected')['service.name']);
        self::assertSame('detected', ResourceFactory::attributes($unnamed, 'detected')['service.name']);
    }

    public function testReportsUnknownOptions(): void
    {
        self::assertSame(['apiKey'], Options::unknownKeys(['apiKey' => 'x', 'release' => '1']));
    }

    public function testVersionMatchesTheJavaScriptPackage(): void
    {
        $package = dirname(__DIR__, 2) . '/js/package.json';
        if (!is_file($package)) {
            self::markTestSkipped('js/ is not next to php/');
        }
        $json = json_decode((string) file_get_contents($package), true);

        self::assertSame($json['version'], Version::VERSION);
    }
}
